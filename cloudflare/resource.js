// One Durable Object per site, holding a Resource per URL that has been
// asked for.  A Resource holds the single subscription to the origin for
// its URL, keeps the newest whole representation as its copy, fans every
// update out to the streams attached to it, and answers plain GETs from the
// copy while the copy is live.  It never interprets versions: it keeps the
// frontier as a set of strings, compares versions for equality, and varies
// on them.

import braid from './node_modules/braid-http/braid-http-client.js'
import {CRLF, serialize_update, parse_versions, format_versions,
        same_versions, versions_match, update_header, origin_status}
    from './http-history.js'
import {shareable, directives, kept_headers} from './edge-cache.js'
import {Multiplexers} from './multiplexer.js'

// A reader's disconnect does not always reach this object's stream, so a
// reader counts as gone once its queue has stayed unread this long.  A
// burst of chunks, a page opening a hundred subscriptions at once, drains
// within milliseconds; a departed reader never drains.  Checked on every
// write, heartbeats included, so the check comes at least once a second.
export var STALL_SECONDS = 4
export function stalled (reader, controller) {
    if (controller.desiredSize === null || controller.desiredSize >= 0) {
        reader.stalled_since = null
        return false
    }
    reader.stalled_since ??= Date.now()
    return Date.now() - reader.stalled_since > STALL_SECONDS * 1000
}

// Every reader gets a heartbeat this often, whatever interval it asked
// for: the Worker relaying the stream renews the data center's copy on each
// one, and the unread-queue check needs something to measure.  Shorter
// than edge-cache's CACHE_SECONDS, or a copy fed by a quiet stream lapses
// between heartbeats.
var HEARTBEAT_SECONDS = 1

// A reader waits this long for the origin's first answer before the copy
// is served stale or the origin is reported unreachable
var ANSWER_WAIT_SECONDS = 15

// After a failed connection to the origin, the next attempt waits this
// long, by attempt number, for as long as anyone is subscribed
var RECONNECT_SECONDS = [1, 2, 3]

// Statuses that mean the origin, or the way to it, is unavailable for the
// moment, so another attempt is worth making, as http_bus classifies them.
// A waiting reader still gets the answer, or the stale copy, at once.
var RETRY_STATUSES = new Set([408, 409, 423, 425, 429, 309, 432,
                              500, 502, 503, 504, 507])

// The object's own request to the origin carries the headers of the
// request it is made on behalf of, as any proxy's upstream request does,
// minus connection headers, credentials, what the object sets itself, and
// the multiplexing headers, which belong to the reader's connection
var NOT_FORWARDED = new Set([
    'host', 'connection', 'keep-alive', 'proxy-authorization',
    'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
    'content-length', 'cookie', 'authorization',
    'subscribe', 'parents', 'version', 'heartbeats',
    'multiplex-through', 'multiplex-version'
])
export function forwardable_headers (request) {
    var headers = {}
    for (var [name, value] of request.headers)
        if (!NOT_FORWARDED.has(name)) headers[name] = value
    return headers
}

// Where the origin copy of a URL lives.  With ORIGIN set, that host; on a
// route in the operator's own zone, the request's own URL, which a Worker's
// subrequest reaches without re-entering the Worker.
export function origin_url (request, env) {
    var url = new URL(request.url)
    return env.ORIGIN ? env.ORIGIN + url.pathname + url.search : url.toString()
}

// Told to the Worker when this object will not handle a request, so the
// Worker relays it to the origin one-to-one
var RELAY = 'Braid-Polyfill-Relay'
function relay (reason) {
    return new Response(null, {status: 204, headers: {[RELAY]: reason}})
}
export function wants_relay (response) {
    return response.headers.get(RELAY)
}

// Resources a site's object keeps once they have gone idle, for the copy a
// later reader may be served, stale-if-error included.  The least recently
// used idle ones go when there are more.
var MAX_IDLE_RESOURCES = 500

export class BraidResource {
    constructor (state, env) {
        this.env = env
        this.resources = new Map()  // path -> Resource
        this.multiplexers = new Multiplexers()
        this.region = null          // named by the Worker on each request
    }

    fetch (request) {
        var url = new URL(request.url), path = url.pathname + url.search
        this.region = request.headers.get('braid-region') ?? this.region
        if (path === '/.braid-polyfill/status') return this.status()
        var route = Multiplexers.route(request)
        if (route?.kind === 'create')
            return this.multiplexers.create(route, request)
        if (route?.kind === 'close') return this.multiplexers.close(route)
        if (route?.kind === 'through')
            return this.multiplexers.through(route, request,
                                             this.resource_for(request))
        return this.resource_for(request).fetch(request)
    }

    resource_for (request) {
        var url = new URL(request.url), path = url.pathname + url.search,
            resource = this.resources.get(path)
        if (!resource) {
            resource = new Resource(path, origin_url(request, this.env),
                                    this.env, () => this.region ?? 'unknown')
            this.resources.set(path, resource)
            this.evict_idle()
        }
        resource.last_used = Date.now()
        return resource
    }

    evict_idle () {
        var idle = [...this.resources.values()]
            .filter(resource => !resource.upstream && !resource.subscribers.size)
            .sort((a, b) => a.last_used - b.last_used)
        var excess = Math.max(0, idle.length - MAX_IDLE_RESOURCES)
        for (var resource of idle.slice(0, excess))
            this.resources.delete(resource.path)
    }

    // The data center this object runs in, read off a trace request once:
    // a location hint names a region, and where in it the object landed
    // decides what the hop to it costs
    async colo () {
        if (!this.own_colo) {
            try {
                var trace = await (await fetch('https://www.cloudflare.com/cdn-cgi/trace')).text()
                this.own_colo = /colo=(\w+)/.exec(trace)?.[1] ?? 'unknown'
            } catch (e) { return 'unknown' }
        }
        return this.own_colo
    }

    // What this object holds, for tests and for looking inside
    async status () {
        return Response.json({
            region: this.region,
            colo: await this.colo(),
            multiplexers: {
                ...this.multiplexers.counts,
                open: [...this.multiplexers.multiplexers.values()].map(m =>
                    ({id: m.id, responses: m.responses.size}))
            },
            resources: [...this.resources.values()].map(resource => ({
                path: resource.path,
                subscribers: resource.subscribers.size,
                keepers: [...resource.keepers.keys()],
                upstream: resource.upstream ? (resource.upstream_answered
                                               ? 'up' : resource.status_because)
                                            : 'none',
                frontier: resource.frontier && [...resource.frontier],
                copy: resource.copy && {
                    version: resource.copy.version, whole: resource.whole,
                    received_at: resource.copy_received_at
                },
                cache_control: resource.cache_control,
                unshareable: resource.unshareable
            }))
        })
    }
}

class Resource {
    constructor (path, origin, env, where) {
        this.env = env
        this.path = path          // pathname plus query
        this.origin = origin      // that URL at the origin
        this.where = where        // names this object's region, for 104s
        this.sends_status = env.ORIGIN_SENDS_STATUS === 'true'
        this.last_used = 0
        this.keepers = new Map()  // data center -> its one keeper subscriber
        this.copy = null          // newest whole-body update
        this.copy_received_at = 0
        this.whole = false        // whether the copy reflects every update received
        this.frontier = null      // versions held that are not parents of others
                                  // held; a Set once known, possibly empty, or
                                  // null when the newest update had no version
        this.cache_control = null // the origin's Cache-Control for this resource
        this.unshareable = false  // origin said private or no-store
        this.subscribers = new Set()
        this.upstream = null      // AbortController of the origin subscription
        this.upstream_answered = false // the copy is what the origin has:
                                       // "up" in 104 Origin Status terms
        this.status_because = 'connecting' // why not, when it is not
        this.upstream_headers = {}     // the origin's 209 headers, for the
                                       // 209s this object sends
        this.upstream_answer = null    // resolves with the origin's next answer
        this.copy_arrived = null       // resolves once the subscription has
                                       // delivered a state
        this.upstream_request = null   // headers the subscription is made with
        this.failures = 0              // connection attempts failed in a row
        this.idle_timer = null
        this.retry_timer = null
    }

    fetch (request) {
        if (this.unshareable) return relay('unshareable')
        if (request.headers.has('subscribe')) return this.subscribe(request)
        return this.plain_get(request)
    }

    // The copy is live while the origin subscription is answered and the
    // copy is the newest thing on it: a whole body whose version set is
    // the whole frontier, both possibly the empty set, or both unknown
    live () {
        return this.upstream && this.upstream_answered && this.copy
            && this.whole
            && versions_match(this.frontier && [...this.frontier],
                              this.copy.version)
    }

    // A reader's subscription as its own 209 stream
    async subscribe (request) {
        var subscriber = {}
        var stream = new ReadableStream({
            start: controller => {
                subscriber.write = bytes => {
                    if (stalled(subscriber, controller))
                        return this.remove_subscriber(subscriber)
                    try { controller.enqueue(bytes) }
                    catch (e) { this.remove_subscriber(subscriber) }
                }
                subscriber.close = () => {
                    try { controller.close() } catch (e) {}
                }
            },
            cancel: () => this.remove_subscriber(subscriber)
        })
        var start = await this.open_subscription(request, subscriber)
        if (start instanceof Response) return start
        return new Response(stream, start)
    }

    // Attaches a subscriber and feeds it, once the origin has answered the
    // object's own subscription, so that the 209 carries the origin's
    // headers and an origin answering plainly has that answer passed on
    // instead.  A subscriber has `write` and `close`, and may have `start`,
    // called with the 209's status and headers before its first byte.
    // Returns those, {status, statusText, headers}, or a Response when there
    // is no 209.
    async open_subscription (request, subscriber, {heartbeats = true} = {}) {
        var wanted = parseFloat(request.headers.get('heartbeats'))

        // A data center keeps one subscription of its own per URL; a new
        // keeper from the same data center takes over from the old one
        var keeper = request.headers.get('braid-keeper')
        if (keeper) {
            var former = this.keepers.get(keeper)
            if (former) this.remove_subscriber(former)
            this.keepers.set(keeper, subscriber)
            subscriber.keeper_of = keeper
        }
        this.ensure_upstream(request)
        // A subscriber waits as long as the origin takes: an origin may hold
        // a subscription open until the resource exists, and the reader,
        // not this object, decides how long it will wait
        var answer = await this.wait_for(this.upstream_answer, 'answer', Infinity)
        if (!answer) {
            this.remove_subscriber(subscriber)
            return unreachable()
        }
        if (answer.status !== 209) {
            this.remove_subscriber(subscriber)
            return this.plain_answer(answer, request)
        }

        var headers = {
            ...this.upstream_headers,
            'Content-Type': 'application/http-history',
            'Subscribe': 'true',
            'Cache-Control': 'no-store',
            'Vary': 'Subscribe',
            'Cache-Status': this.live()
                ? 'braid-object; hit; detail=live'
                : 'braid-object; fwd=uri-miss; detail=connecting'
        }
        if (heartbeats && isFinite(wanted))
            headers['Heartbeats'] = request.headers.get('heartbeats')
        if (this.frontier)
            headers['Current-Version'] = format_versions([...this.frontier])
        if (this.cache_control)
            headers['Braid-Cache-Control'] = this.cache_control
        var start = {status: 209, statusText: 'Multiresponse', headers}
        subscriber.start?.(start)

        // Only now does the subscriber hear broadcasts: nothing may precede
        // its status line and headers
        this.subscribers.add(subscriber)

        // A byte behind the headers, for Firefox and header-holding proxies
        subscriber.write(CRLF)

        // A reader that already has the current version needs no snapshot,
        // whether it is here now or arrives as the first upstream update
        subscriber.known = parse_versions(request.headers.get('parents'))
        // Whether this reader hears 104 Origin Status: the Worker's own
        // keepers always, since the edge's markers are read off them; a
        // reader only where READER_STATUS allows, since a client that hands
        // every sub-response to its application breaks on one it does not
        // expect
        subscriber.wants_status = request.headers.has('braid-keeper')
                                  || this.env.READER_STATUS !== 'false'
        if (this.copy && !(subscriber.known !== undefined
                           && versions_match(subscriber.known, this.copy.version)))
            subscriber.write(serialize_update(this.copy))

        // Then whether that is current, as 104 Origin Status
        if (subscriber.wants_status) subscriber.write(this.status_bytes())

        // Heartbeats say the connection is alive; currency is the 104's to
        // say.  A multiplexed subscriber gets none of its own; its
        // multiplexer beats.
        if (heartbeats)
            subscriber.heartbeat_timer = setInterval(
                () => subscriber.write(CRLF), HEARTBEAT_SECONDS * 1000)
        return start
    }

    // Currency, told to every reader as a 104 Origin Status sub-response:
    // up when the copy is what the origin has, down with a reason
    // otherwise.  Written on each change, and to each new reader after its
    // snapshot.
    set_current (is_current, because) {
        if (is_current === this.upstream_answered
            && (is_current || because === this.status_because)) return
        this.upstream_answered = is_current
        this.status_because = is_current ? null : because
        var bytes = this.status_bytes()
        for (var subscriber of this.subscribers)
            if (subscriber.wants_status) subscriber.write(bytes)
    }

    status_bytes () {
        var headers = {
            'State': this.upstream_answered ? 'up'
                : `down; because=${this.status_because}; from=${this.where()}`,
            'Date': new Date().toUTCString()
        }
        if (this.upstream_answered && this.frontier)
            headers['Current-Version'] = format_versions([...this.frontier])
        return serialize_update({status: 104, extra_headers: headers, body: ''})
    }

    remove_subscriber (subscriber) {
        clearInterval(subscriber.heartbeat_timer)
        subscriber.close?.()
        this.subscribers.delete(subscriber)
        if (subscriber.keeper_of
            && this.keepers.get(subscriber.keeper_of) === subscriber)
            this.keepers.delete(subscriber.keeper_of)
        this.touch_idle()
    }

    // The origin subscription outlives its last reader by IDLE_SECONDS, so
    // a reload does not reopen it
    touch_idle () {
        clearTimeout(this.idle_timer)
        if (this.subscribers.size === 0)
            this.idle_timer = setTimeout(
                () => this.drop_upstream(),
                1000 * (parseFloat(this.env.IDLE_SECONDS) || 60))
    }

    close_readers () {
        for (var subscriber of [...this.subscribers])
            this.remove_subscriber(subscriber)
    }

    // The one subscription to the origin, opened for the first reader,
    // plain or subscribing, and dropped a while after the last one leaves.
    // Every request the object makes carries Subscribe: an origin with
    // subscriptions answers 209, and one without answers as it would any
    // GET, which is then the reader's answer.  The subscription resumes
    // from the frontier, so the origin sends only what this object missed.
    ensure_upstream (request) {
        clearTimeout(this.idle_timer)
        if (this.upstream) return
        this.upstream_request = forwardable_headers(request)
        this.connect_upstream()
    }

    // One connection attempt.  Each attempt is made and judged here rather
    // than by the braid client's own retrying, so that a reader waiting on
    // it learns of a failure at once instead of after a retry loop.
    connect_upstream () {
        clearTimeout(this.retry_timer)
        this.set_current(false, 'connecting')
        var aborter = this.upstream = new AbortController()
        this.expect_answer()
        this.copy_arrived = new Promise(resolve => { this.arrive_copy = resolve })
        braid.fetch(this.origin, {
            headers: this.upstream_request,
            subscribe: true,
            retry: false,
            heartbeats: 20,
            parents: this.frontier ? [...this.frontier] : undefined,
            signal: aborter.signal
        }).then(res => this.upstream_response(res, aborter))
          .catch(error => this.upstream_failed(aborter, error))
    }

    // A fresh promise of the origin's next answer, for readers to wait on
    expect_answer () {
        this.upstream_answer = new Promise(resolve => {
            this.answer_upstream = resolve
        })
    }

    // A promise's value, or undefined once `seconds` have passed; with no
    // limit, the value however long it takes
    async wait_for (promise, waiting_for, seconds = ANSWER_WAIT_SECONDS) {
        if (seconds === Infinity) return await promise
        var timer
        var timeout = new Promise(resolve => {
            timer = setTimeout(() => {
                console.error(`origin ${this.path}: no ${waiting_for} `
                              + `within ${seconds}s`)
                resolve(undefined)
            }, seconds * 1000)
        })
        try { return await Promise.race([promise, timeout]) }
        finally { clearTimeout(timer) }
    }

    // Each answer from the origin, first connection and every reconnection
    // The origin's answer to a connection attempt
    upstream_response (res, aborter) {
        if (aborter.signal.aborted) return
        this.failures = 0
        this.answer_upstream?.(res)
        this.answer_upstream = null
        if (res.status !== 209) {
            // No subscription here: the answer belongs to the reader who
            // asked, and there is nothing to hold.  The request is forgotten
            // rather than aborted, so that its body can still be read.
            this.upstream = null
            this.arrive_copy?.(false)
            setTimeout(() => {
                if (!res.claimed) res.body?.cancel().catch(() => {})
            })
            if (RETRY_STATUSES.has(res.status)) {
                this.set_current(false, `status; status=${res.status}`)
                this.schedule_retry(retry_after(res))
            } else this.set_current(false, 'no-subscription')
            return
        }
        this.upstream_headers = kept_headers(res.headers)

        // Sub-responses inherit the 209's Cache-Control, except that a
        // no-store there guards the 209 itself against caches that would
        // store it, and says nothing about the sub-responses
        var cache_control = res.headers.get('cache-control')
        if (cache_control && !directives(cache_control)['no-store']) {
            if (!shareable(cache_control)) return this.become_unshareable()
            this.cache_control = cache_control
        }

        // An origin that sends 104 Origin Status says when the copy is
        // current.  For one that does not, its Current-Version does, and
        // failing that the first update will.
        var current = parse_versions(res.headers.get('current-version'))
        if (!this.sends_status && current !== undefined && this.frontier !== null
            && same_versions(current, [...this.frontier]))
            this.set_current(true)
        else this.set_current(false, 'catching-up')
        // The client hands 1xx sub-responses to on_status; one that hands
        // them to the update callback instead is handled the same
        res.subscribe(update => this.on_update(update),
                      error => this.upstream_failed(aborter, error),
                      {on_status: update => this.on_update(update)})
    }

    // A failed attempt, or a subscription that died.  An abort is this
    // object's own doing; anything else is worth a log line.  Readers
    // waiting on the attempt hear of it now, and the next attempt comes
    // after a pause if anyone is still subscribed.
    upstream_failed (aborter, error) {
        if (aborter.signal.aborted) return
        this.answer_upstream?.(null)
        this.answer_upstream = null
        this.arrive_copy?.(false)
        this.set_current(false, 'connection-failed')
        this.drop_upstream()
        var pause = RECONNECT_SECONDS[
            Math.min(this.failures++, RECONNECT_SECONDS.length - 1)]
        console.error(`upstream ${this.path}: ${error}; failure ${this.failures}, `
                      + `${this.subscribers.size} subscribers, `
                      + (this.subscribers.size ? `retry in ${pause}s`
                                               : 'no retry'))
        this.schedule_retry(pause)
    }

    // The next attempt, after a pause, while anyone is subscribed
    schedule_retry (pause) {
        if (this.subscribers.size === 0) return
        clearTimeout(this.retry_timer)
        this.retry_timer = setTimeout(() => this.connect_upstream(),
                                      pause * 1000)
    }

    drop_upstream () {
        clearTimeout(this.retry_timer)
        this.upstream?.abort()
        this.upstream = null
        this.upstream_answered = false
        this.status_because = 'idle'
    }

    on_update (update) {
        // A 104 from the origin is its word on currency, taken only from an
        // origin that is known to give it; any other 1xx says nothing
        var status = origin_status(update)
        if (status || (update.status >= 100 && update.status < 200)) {
            if (status && this.sends_status)
                this.set_current(status.up, status.because ?? 'origin')
            return
        }

        // Parents absent: the update supersedes everything held.  Parents
        // present, even empty: it descends from those.  Version absent: the
        // new state has no name, so nothing can resume from it.
        if (update.parents === undefined)
            this.frontier = update.version === undefined
                ? null : new Set(update.version)
        else {
            this.frontier ??= new Set()
            for (var parent of update.parents) this.frontier.delete(parent)
            if (update.version === undefined) this.frontier = null
            else for (var version of update.version) this.frontier.add(version)
        }

        var cache_control = update_header(update, 'cache-control')
        if (cache_control && !shareable(cache_control))
            return this.become_unshareable()
        if (cache_control) this.cache_control = cache_control

        if (update.status === 410) {
            this.copy = null
            this.whole = false
            this.arrive_copy?.(true)
        } else if (update.body !== undefined) {
            this.copy = update
            this.copy_received_at = Date.now()
            this.whole = true
            this.arrive_copy?.(true)
        } else
            this.whole = false

        var bytes = serialize_update(update)
        for (var subscriber of this.subscribers)
            if (!(subscriber.known !== undefined
                  && versions_match(subscriber.known, update.version)))
                subscriber.write(bytes)

        // From an origin without 104s, each update is current as sent
        if (!this.sends_status) this.set_current(true)
    }

    // The origin marked this resource private or no-store: nothing of it is
    // kept or shared from here on
    become_unshareable () {
        this.unshareable = true
        this.copy = null
        this.close_readers()
        this.drop_upstream()
    }

    // A plain GET.  While the copy is live it is the answer.  Otherwise the
    // origin answers through the object's own subscription: this request
    // opens it if need be, and the first sub-response is the answer.  An
    // origin that answers plainly has that answer passed on.
    async plain_get (request) {
        var wanted = parse_versions(request.headers.get('version'))
        if (this.live()
            && (wanted === undefined
                || versions_match(wanted, this.copy.version)))
            return this.from_copy(request, 'braid-object; hit; detail=live')

        // A request naming a version asks for history, not the current state
        if (wanted !== undefined || request.headers.has('parents'))
            return this.pass_through(request)

        var asked_at = Date.now()
        this.ensure_upstream(request)
        var answer = await this.wait_for(this.upstream_answer, 'answer')
        if (answer?.status === 209)
            await this.wait_for(this.copy_arrived, 'first sub-response')
        this.touch_idle()
        if (!answer) return this.stale_or_error(request, 0)
        if (answer.status !== 209) return this.plain_answer(answer, request)
        if (this.live())
            return this.from_copy(request, 'braid-object; hit; detail=live')
        if (this.copy && this.copy_received_at >= asked_at)
            return this.from_copy(request,
                                  'braid-object; fwd=uri-miss; detail=subscribed')
        return this.pass_through(request)
    }

    // A request the subscription cannot answer, forwarded as it is
    async pass_through (request) {
        var forwarded = new Headers(request.headers)
        forwarded.delete('host')
        try {
            var response = await fetch(this.origin,
                                       {headers: forwarded, redirect: 'manual'})
        } catch (e) {
            return this.stale_or_error(request, 0)
        }
        return this.plain_answer(response, request)
    }

    // The origin's answer to a request the object hoped to subscribe with,
    // a plain 200, a redirect, an error, streamed to the one reader who
    // asked.  A second reader waiting on the same answer is relayed.
    plain_answer (answer, request) {
        if (answer.claimed) return relay('answered')
        answer.claimed = true
        var cache_control = answer.headers.get('cache-control')
        if (cache_control && !shareable(cache_control)) this.become_unshareable()
        else if (cache_control) this.cache_control = cache_control

        var headers = new Headers()
        for (var [name, value] of answer.headers)
            if (!name.startsWith(':')) headers.append(name, value)
        headers.set('Cache-Status', 'braid-object; fwd=uri-miss')
        var response = new Response(answer.body, {status: answer.status,
                                                  statusText: answer.statusText,
                                                  headers})
        if (answer.status >= 500)
            return this.stale_or_error(request, answer.status, response)
        return response
    }

    from_copy (request, cache_status) {
        var version = this.copy.version === undefined
                ? null : format_versions(this.copy.version),
            parents = this.copy.parents === undefined
                ? null : format_versions(this.copy.parents),
            headers = {
                ...kept_headers(this.copy.extra_headers ?? this.copy.headers),
                'Vary': 'Version, Parents, Subscribe',
                'Cache-Status': cache_status
            }
        if (version !== null) headers['Version'] = version
        if (parents !== null) headers['Parents'] = parents
        if (version) headers['ETag'] = version
        if (this.cache_control) headers['Cache-Control'] = this.cache_control
        if (this.copy.content_type)
            headers['Content-Type'] = this.copy.content_type
        if (version && request.headers.get('if-none-match') === version)
            return new Response(null, {status: 304, headers})
        return new Response(this.copy.body, {status: 200, headers})
    }

    // The origin failed: the copy is served if the origin allowed that with
    // stale-if-error and the copy is still within that window
    stale_or_error (request, status, response) {
        var allowed = directives(this.cache_control)['stale-if-error']
        if (this.copy && Number.isFinite(allowed)
            && Date.now() - this.copy_received_at < allowed * 1000)
            return this.from_copy(request, 'braid-object; fwd=stale; '
                                  + `fwd-status=${status}; detail=stale-if-error`)
        return response ?? unreachable()
    }
}

// Seconds until the next attempt after a retryable status: the origin's
// Retry-After if it gave one, else the first reconnect pause
function retry_after (res) {
    var seconds = parseFloat(res.headers.get('retry-after'))
    return Number.isFinite(seconds) ? Math.max(seconds, RECONNECT_SECONDS[0])
                                    : RECONNECT_SECONDS[0]
}

function unreachable () {
    return new Response('origin unreachable', {
        status: 502,
        headers: {'Cache-Status': 'braid-object; fwd=uri-miss; fwd-status=0'}
    })
}
