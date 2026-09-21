// The copy of a page that one data center keeps, in that data center's own
// cache.  It is keyed by URL plus the request's Version and Parents, since
// Cloudflare's cache keys on URL alone.  A copy is live while a stream
// through this data center keeps rewriting it, fresh for the origin's
// max-age after that, and kept a while longer to be served if the origin
// fails and the origin allowed that with stale-if-error.

import {parser, update_header, format_versions, parse_versions,
        serialize_update, multiplexer_parser, parse_status_and_headers,
        origin_status} from './http-history.js'

// A stored response keeps the origin's headers, all but these: connection
// headers, ones every response gets afresh, and ones that belong to the
// subscription a sub-response arrived in rather than to the sub-response
var NOT_KEPT = new Set([
    'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer',
    'upgrade', 'proxy-authenticate', 'proxy-authorization',
    'content-length', 'content-type', 'date', 'age', 'cache-status',
    'cache-control', 'vary', 'etag', 'version', 'parents', 'set-cookie',
    'subscribe', 'heartbeats', 'current-version', 'incremental'
])
export function kept_headers (headers) {
    var kept = {},
        entries = headers instanceof Headers ? headers
                                             : Object.entries(headers ?? {})
    for (var [name, value] of entries) {
        var lower = name.toLowerCase()
        if (!NOT_KEPT.has(lower) && !lower.startsWith('braid-')
            && !lower.startsWith('cf-') && !lower.startsWith(':'))
            kept[name] = value
    }
    return kept
}

// A copy is live while the stream that fed it says so.  Each stream keeps
// one marker entry in the cache: up or down as the object's 104 Origin
// Status last said, ended when the stream ends, and renewed every
// REFRESH_SECONDS while bytes keep arriving as the backstop for a stream
// that dies without saying so, counting as live for CACHE_SECONDS after
// its last renewal.
export var CACHE_SECONDS = 1.5,
    REFRESH_SECONDS = 1
var MAX_STALE_SECONDS = 86400,
    MAX_LIVE_SECONDS = 86400  // how long the cache is asked to keep a copy
                              // that a stream may keep live

// A version list as a key: the same set in any order gives the same key
export function version_key (header) {
    var versions = parse_versions(header)
    return versions === undefined ? '' : '=' + format_versions([...versions].sort())
}

// The variant a request asks for: the plain page unless it names a
// version.  A header present with an empty value names the empty set,
// a different variant from no header at all.
export function variant_of (request) {
    var named = name => version_key(request.headers.get(name))
    return {version: named('version'), parents: named('parents')}
}
export var PLAIN = {version: '', parents: ''}

function key (url, variant) {
    return new Request('https://braid-polyfill.cache/'
                       + encodeURIComponent(url.toString())
                       + '?version=' + encodeURIComponent(variant.version)
                       + '&parents=' + encodeURIComponent(variant.parents))
}

function marker_key (stream) {
    return new Request('https://braid-polyfill.cache/live/' + stream)
}

// The origin's Cache-Control as a map of directive to value (true if bare)
export function directives (cache_control) {
    var found = {}
    for (var part of (cache_control ?? '').toLowerCase().split(',')) {
        var [name, value] = part.split('=')
            .map(s => s.trim().replace(/^"|"$/g, ''))
        if (name) found[name] = value === undefined ? true : parseInt(value)
    }
    return found
}

// Whether a shared cache may keep this response and hand it to other users
export function shareable (cache_control) {
    var d = directives(cache_control)
    return !d['no-store'] && !d['private']
}

// Seconds a copy stays fresh after it stops being live
function lifetime (d) {
    if (d['no-cache']) return 0
    var seconds = d['s-maxage'] ?? d['max-age']
    return Number.isFinite(seconds) ? Math.max(0, seconds) : 0
}

// Stores a copy.  `via` names the stream feeding it, whose marker says
// whether it is live; a copy stored with no stream is fresh for the
// origin's lifetime from now.
export async function store (url, variant,
                             {version, parents, content_type, cache_control,
                              headers},
                             body, {via}) {
    var d = directives(cache_control), now = Date.now(),
        fresh = lifetime(d),
        stale = Math.min(Number.isFinite(d['stale-if-error'])
                             ? d['stale-if-error'] : 0,
                         MAX_STALE_SECONDS)
    if (!via && fresh + stale <= 0) return false
    headers = {
        ...kept_headers(headers),
        'Content-Type': content_type ?? 'application/octet-stream',
        'Date': new Date(now).toUTCString(),
        'Cache-Control': 'max-age=' + (fresh + stale
                                        + (via ? MAX_LIVE_SECONDS : 0)),
        'Braid-Fresh-Seconds': String(fresh),
        'Braid-Fresh-Until': String(now + fresh * 1000),
        'Braid-Origin-Cache-Control': cache_control ?? ''
    }
    if (via) headers['Braid-Live-Via'] = via
    if (version !== null && version !== undefined) headers['Version'] = version
    if (parents !== null && parents !== undefined) headers['Parents'] = parents
    if (version) headers['ETag'] = version
    await caches.default.put(key(url, variant), new Response(body, {headers}))
    return true
}

// The copy for a variant, with its state: live, fresh, or stale.  A copy
// fed by a stream is live while the stream's marker is up, and fresh for
// the origin's lifetime from the moment the marker went down or ended; a
// marker that is missing counts as ended when the copy was written.
export async function lookup (url, variant) {
    var response = await caches.default.match(key(url, variant))
    if (!response) return null
    var h = response.headers, now = Date.now(),
        stored_at = Date.parse(h.get('date')),
        fresh_until = +h.get('braid-fresh-until'),
        via = h.get('braid-live-via'), keeper_until = 0
    if (via) {
        var marker = await caches.default.match(marker_key(via)),
            m = name => marker?.headers.get(name),
            live_until = +(m('braid-live-until') ?? 0),
            ended_at = +(m('braid-ended-at') ?? 0),
            down_since = m('braid-state') === 'down' ? +m('braid-since') : 0
        keeper_until = +(m('braid-keeper-until') ?? 0)
        if (!ended_at && !down_since && now < live_until)
            return {response, state: 'live', age: 0, ttl: 0, keeper_until}
        stored_at = ended_at || down_since || Math.min(live_until, now)
                    || stored_at
        fresh_until = stored_at + 1000 * +h.get('braid-fresh-seconds')
    }
    var state = now < fresh_until ? 'fresh' : 'stale'
    return {
        response, state, keeper_until,
        age: Math.max(0, Math.round((now - stored_at) / 1000)),
        ttl: Math.max(0, Math.round((fresh_until - now) / 1000)),
        // Seconds since the copy went stale, against the seconds the
        // origin allows it to be served while a revalidation runs
        stale_for: Math.max(0, Math.round((now - fresh_until) / 1000)),
        revalidate_seconds: directives(h.get('braid-origin-cache-control'))['stale-while-revalidate'],
        origin_down: !!down_since
    }
}

// Whether a stale copy may be served while it is revalidated, by the
// origin's stale-while-revalidate window; not when the stream that fed
// it reported the origin down, which stale-if-error covers instead
export function serve_while_revalidating (found) {
    return found.state === 'stale' && !found.origin_down
        && found.stale_for < found.revalidate_seconds
}

// A copy as the sub-response it was stored from, for a subscription
// answered from this data center before the object's stream is attached
export function copy_as_update (found, body) {
    var h = found.response.headers,
        version = parse_versions(h.get('version')),
        parents = parse_versions(h.get('parents')),
        extra_headers = kept_headers(h)
    if (h.get('braid-origin-cache-control'))
        extra_headers['Cache-Control'] = h.get('braid-origin-cache-control')
    if (found.state !== 'live') extra_headers['Age'] = String(found.age)
    return serialize_update({status: 200, version, parents, extra_headers,
                             content_type: h.get('content-type'), body})
}

// Re-points a copy at a new stream's marker, for a keeper taking over from
// another before the old one ends
export async function adopt (url, marker) {
    var found = await lookup(url, PLAIN)
    if (!found || !found.response.headers.get('braid-live-via')) return
    var h = found.response.headers
    await store(url, PLAIN, {
        version: h.get('version'), parents: h.get('parents'),
        content_type: h.get('content-type'),
        cache_control: h.get('braid-origin-cache-control') || null,
        headers: h
    }, await found.response.arrayBuffer(), {via: marker.id})
}

// Marks one copy as fed by no stream, when the multiplexed response feeding
// it closes or reports the origin down while the others in the same stream
// carry on.  Only the copy the stream `via` wrote is touched; one another
// stream wrote is that stream's to keep live.
async function unlive (url, via) {
    var found = await lookup(url, PLAIN)
    if (!found || found.response.headers.get('braid-live-via') !== via) return
    var h = found.response.headers,
        kept = await store(url, PLAIN, {
            version: h.get('version'), parents: h.get('parents'),
            content_type: h.get('content-type'),
            cache_control: h.get('braid-origin-cache-control') || null,
            headers: h
        }, await found.response.arrayBuffer(), {via: null})
    // A copy the origin allows no life for once its stream is gone
    if (!kept) await remove(url, PLAIN)
}

// A response to the reader from a copy, with the origin's own Cache-Control
// back in place and a Cache-Status line saying what happened
export function serve (found, request, {fwd_status, revalidating} = {}) {
    var h = found.response.headers, version = h.get('version'),
        parents = h.get('parents'),
        status = found.state === 'live' ? 'braid-edge; hit; detail=live'
               : found.state === 'fresh'
                 ? `braid-edge; hit; detail=fresh; ttl=${found.ttl}`
               : revalidating
                 ? `braid-edge; hit; ttl=-${found.stale_for}; `
                   + 'detail=stale-while-revalidate'
               : `braid-edge; fwd=stale; fwd-status=${fwd_status ?? 0}; `
                 + 'detail=stale-if-error',
        headers = new Headers({
            ...kept_headers(h),
            'Content-Type': h.get('content-type'),
            'Cache-Control': h.get('braid-origin-cache-control')
                             || 'public, max-age=0',
            'Age': String(found.age),
            'Vary': 'Version, Parents, Subscribe',
            'Cache-Status': status
        })
    if (version !== null) headers.set('Version', version)
    if (parents !== null) headers.set('Parents', parents)
    if (version) headers.set('ETag', version)
    if (version && request.headers.get('if-none-match') === version)
        return new Response(null, {status: 304, headers})
    return new Response(found.response.body, {status: 200, headers})
}

export async function remove (url, variant) {
    await caches.default.delete(key(url, variant))
}

// One stream's marker: up or down as the object's 104s say, starting
// down until the first says up, renewed every REFRESH_SECONDS while bytes
// keep arriving, written as ended when the stream ends.  A keeper's marker
// also says when the keeper will end, so a hit can start its successor.
export function stream_marker ({keeper_until = 0} = {}) {
    var stream = crypto.randomUUID(), last_bytes_at = Date.now(), timer,
        state = 'down', since = Date.now(), ended_at = 0
    var write = () => caches.default.put(marker_key(stream),
        new Response(null, {headers: {
            'Cache-Control': 'max-age=' + MAX_LIVE_SECONDS,
            'Braid-Live-Until': String(Date.now() + CACHE_SECONDS * 1000),
            'Braid-State': state,
            'Braid-Since': String(since),
            'Braid-Ended-At': String(ended_at),
            'Braid-Keeper-Until': String(keeper_until)
        }})).catch(() => {})
    return {
        id: stream,
        start () {
            write()
            timer = setInterval(() => {
                if (Date.now() - last_bytes_at < CACHE_SECONDS * 1000) write()
            }, REFRESH_SECONDS * 1000)
        },
        saw_bytes () { last_bytes_at = Date.now() },
        up () { if (state !== 'up') { state = 'up'; since = Date.now(); write() } },
        down (at) { if (state !== 'down') { state = 'down'; since = at; write() } },
        end () {
            clearInterval(timer)
            ended_at = Date.now()
            write()
        }
    }
}

// What a sub-response does to a stream's marker: a 104 sets it up or down.
// Returns true when the sub-response was a status and not an edition.
function apply_status (update, marker) {
    var status = origin_status(update)
    if (!status) return update.status >= 100 && update.status < 200
    if (status.up) marker.up()
    else marker.down(status.date)
    return true
}

// What one sub-response does to the cache: a whole body becomes the plain
// variant's copy, a 410 removes it.  A sub-response's own Cache-Control
// governs it; failing that, the resource's.  Its headers are its own.
async function store_update (url, update, resource_cache_control, via) {
    if (update.status === 410) return remove(url, PLAIN)
    if (update.body === undefined) return
    var cache_control = update_header(update, 'cache-control')
                        ?? resource_cache_control
    if (!shareable(cache_control)) return
    var own_headers = update.headers ?? update.extra_headers
    await store(url, PLAIN, {
        version: update.version === undefined ? null
                                              : format_versions(update.version),
        parents: update.parents === undefined ? null
                                              : format_versions(update.parents),
        content_type: update.content_type,
        cache_control,
        headers: kept_headers(own_headers)
    }, update.body, {via})
}

// A pass-through for a reader's 209 stream that writes each edition into
// the cache as it goes by, under the stream's marker.  The reader stays the
// stream's only consumer, so when the reader stops pulling, so does this,
// and the object notices.
export function observer (url, resource_cache_control, marker) {
    var updates = parser()
    return new TransformStream({
        start () { marker.start() },
        async transform (chunk, controller) {
            controller.enqueue(chunk)
            marker.saw_bytes()
            for (var update of updates.feed(chunk))
                if (!apply_status(update, marker))
                    await store_update(url, update, resource_cache_control,
                                       marker.id)
        },
        flush () { marker.end() },
        cancel () { marker.end() }
    })
}

// Reads a 209 stream this Worker holds for itself, a post-GET subscription,
// writing each edition into the cache until the deadline.  It stops reading
// on its own, since aborting the fetch does not always reach the object,
// and the object notices a reader by its stopping.
export async function keep_fresh (stream, url, resource_cache_control,
                                  deadline, marker) {
    var reader = stream.getReader(),
        timeout = new Promise(resolve =>
            setTimeout(() => resolve({done: true}),
                       Math.max(0, deadline - Date.now())))
    marker.start()
    try {
        var updates = parser()
        for (;;) {
            var {value, done} = await Promise.race([reader.read(), timeout])
            if (done) return
            marker.saw_bytes()
            for (var update of updates.feed(value))
                if (!apply_status(update, marker))
                    await store_update(url, update, resource_cache_control,
                                       marker.id)
        }
    } catch (e) {}
    finally {
        marker.end()
        reader.cancel().catch(() => {})
    }
}

// A pass-through for a multiplexer's stream that writes each edition of
// each response in it into the cache as it goes by, all under the stream's
// one marker.  A response's URL comes from its Content-Location header.
export function demultiplexer (site, marker) {
    var frames = multiplexer_parser(), responses = new Map()  // rid -> state
    var handle = async event => {
        if (event.kind === 'start')
            responses.set(event.rid, {started: null, pending: new Uint8Array(0)})
        else if (event.kind === 'close') {
            // The copy this response fed is fed by nothing now
            var closed = responses.get(event.rid)
            responses.delete(event.rid)
            if (closed?.url) await unlive(closed.url, marker.id)
        } else if (event.kind === 'bytes') {
            var state = responses.get(event.rid)
            if (!state) return
            var bytes = event.bytes
            if (!state.started) {
                state.pending = concat_bytes(state.pending, bytes)
                var started = parse_status_and_headers(state.pending)
                if (!started) return
                state.started = started
                state.pending = null
                if (started.status !== 209
                    || !started.headers['content-location'])
                    return
                state.url = new URL(started.headers['content-location'], site)
                state.cache_control = started.headers['braid-cache-control']
                                      ?? null
                state.updates = parser()
                bytes = started.rest
            }
            if (!state.updates) return
            for (var update of state.updates.feed(bytes)) {
                // One response's status is one URL's, and the marker is
                // the stream's: an up marks the stream, so every copy it
                // feeds counts as live; a down un-marks that URL's copy
                // alone, until its next edition is stored under the stream
                var status = origin_status(update)
                if (status) {
                    if (status.up) marker.up()
                    else await unlive(state.url, marker.id)
                    continue
                }
                if (update.status >= 100 && update.status < 200) continue
                await store_update(state.url, update, state.cache_control,
                                   marker.id)
            }
        }
    }
    return new TransformStream({
        start () { marker.start() },
        async transform (chunk, controller) {
            controller.enqueue(chunk)
            marker.saw_bytes()
            for (var event of frames.feed(chunk)) await handle(event)
        },
        flush () { marker.end() },
        cancel () { marker.end() }
    })
}

function concat_bytes (a, b) {
    var out = new Uint8Array(a.byteLength + b.byteLength)
    out.set(a, 0); out.set(b, a.byteLength)
    return out
}
