// The Braid-HTTP polyfill for Cloudflare, Worker half: the router.  It
// decides where each request goes, and holds nothing itself.
// Subscriptions and plain GETs of shareable resources go to the Durable
// Object for their site, which holds the one subscription to the origin for
// each of the site's URLs.
// On the way through, every edition pushed to a reader at this data center
// is written into the data center's cache (edge-cache.js), and a plain GET
// that finds no copy starts a subscription of this data center's own for a
// while, so reloads stay local with no tab open.  Requests that must not
// be shared, and anything the object declines, are relayed to the origin
// one-to-one.
//
// An operator's worker.js is:
//
//     import {braid_polyfill, BraidResource} from './router.js'
//     export {BraidResource}
//     export default braid_polyfill()
//
// with wrangler.toml binding BRAID_RESOURCE to the BraidResource class.
// Settings come from wrangler.toml vars: ORIGIN (optional on a route),
// IDLE_SECONDS, POST_GET_SUBSCRIPTION_SECONDS, REGIONS, MODE,
// ORIGIN_SENDS_STATUS, READER_STATUS.

import {BraidResource, origin_url, wants_relay, forwardable_headers}
    from './resource.js'
import * as edge from './edge-cache.js'
import {CRLF, parse_versions, format_versions, versions_match}
    from './http-history.js'
export {BraidResource}

// A request to a Durable Object can fail on its way there, and the object
// comes back on the next request, so a failure is retried this many times,
// with growing pauses, before the reader is told to try again later
var OBJECT_ATTEMPTS = 3, OBJECT_PAUSE_MS = 300

// A plain GET that hits a copy kept live by a post-GET subscription with
// this long left starts the subscription's successor, so a page read
// steadily never lapses, and one read in a quiet spell keeps nothing going
var HANDOFF_SECONDS = 5

// Where a site's objects live: one object per home, placed by the Durable
// Object location hint of the same name.  Where an object actually lands
// is the platform's choice: the probe found a "sam" hint landing in
// Chicago (2026-09-21) while "enam" lands in Miami, so South America is
// served from enam, and Africa and the Middle East from the homes nearest
// them.  With REGIONS = "reader", a reader is served by the object in its
// own region; set to one home's name, every reader is served by the
// object there.
var HOMES = ['wnam', 'enam', 'weur', 'eeur', 'apac', 'oc'],
    FALLBACK_HOME = 'wnam'  // a reader whose location is unknown
export function region_of (request, env) {
    if (env.REGIONS && env.REGIONS !== 'reader')
        return HOMES.includes(env.REGIONS) ? env.REGIONS : FALLBACK_HOME
    // The data center that took the request is the surest sign of where
    // the reader is: Cloudflare routes readers to a nearby one, while the
    // geography of the reader's address can be wrong, as it is for a
    // request from another Worker, which carries the geography of whatever
    // request set that Worker going, wherever the Worker itself runs
    var cf = request.cf, longitude = parseFloat(cf?.longitude)
    if (REGION_OF_COLO[cf?.colo]) return REGION_OF_COLO[cf.colo]
    switch (cf?.continent) {
        case 'NA': return longitude < -90 ? 'wnam' : 'enam'  // Dallas is wnam
        case 'SA': return 'enam'
        case 'EU': return longitude < 15 ? 'weur' : 'eeur'
        case 'AF': return 'weur'
        case 'AS': return longitude < 60 ? 'eeur' : 'apac'
        case 'OC': return 'oc'
        default: return FALLBACK_HOME
    }
}

// The home of each data center.  Data centers are named by their nearest
// airport; this covers the busy ones, drawn by the same longitude lines
// as above, and a request from one not listed is placed by the geography
// of its address instead.
var REGION_OF_COLO = Object.fromEntries(Object.entries({
    wnam: 'SEA PDX SFO SJC SMF LAX SAN LAS PHX DEN SLC ABQ ELP DFW AUS SAT '
        + 'HOU IAH OKC MCI MSP OMA YVR YYC YEG YWG GDL MEX QRO HNL ANC',
    enam: 'ORD ATL MIA TPA MCO JAX IAD DCA BWI EWR JFK LGA BOS PHL PIT CLT '
        + 'RDU RIC BNA MEM STL IND CMH CLE CVG DTW MKE BUF MSY YYZ YUL YOW '
        + 'YHZ GRU GIG EZE SCL BOG LIM UIO MDE CWB POA FOR BSB CNF PTY SJO '
        + 'GUA SDQ SJU KIN',
    weur: 'LHR MAN EDI DUB AMS BRU CDG MRS MAD BCN LIS OPO OSL CPH GOT HAM '
        + 'BER FRA DUS MUC ZRH GVA MXP FCO PRG LUX JNB CPT LOS NBO CAI CMN '
        + 'ACC DAR MPM',
    eeur: 'VIE WAW ARN HEL ATH BUD OTP SOF IST KBP RIX TLL VNO ZAG BEG SKP '
        + 'TIA KIV DXB DOH BAH KWI RUH JED TLV AMM BEY TBS BAK EVN',
    apac: 'SIN KUL BKK HKG TPE NRT KIX ICN MNL CGK SGN HAN PNH BOM DEL MAA '
        + 'BLR HYD CCU KHI ISB LHE DAC CMB KTM ULN CEB DPS SUB JHB',
    oc: 'SYD MEL BNE PER ADL CBR AKL CHC NOU SUV PPT GUM'
}).flatMap(([home, colos]) => colos.split(' ').map(colo => [colo, home])))

// How the objects reach the origin: flat, each region's object subscribes
// to the origin itself.  Reported in Cache-Status; tree, where regions
// subscribe to one central object, is not built yet.
function mode_of (env) {
    return env.MODE || 'flat'
}

export function braid_polyfill () {
    return {
        async fetch (request, env, ctx) {
            ask_object.env = env
            var url = new URL(request.url),
                multiplexing = url.pathname.startsWith('/.well-known/multiplexer/')
            if (request.method !== 'GET' && !multiplexing)
                return relay(request, env, 'method')

            // A request with credentials may get an answer meant for one
            // user, which a shared cache must not keep or hand to others
            if (request.headers.has('authorization')
                || request.headers.has('cookie'))
                return relay(request, env, 'private-request')

            // What the polyfill knows about where a request came from,
            // where it would send it, and whether this data center's
            // cache answers for it: a request arriving from another Worker
            // may find the Cache API a no-op
            if (url.pathname === '/.braid-polyfill/whoami') {
                // Within one request the Cache API is checked as put then
                // match; across requests, `?probe=<id>&put` stores and a
                // later `?probe=<id>` looks, which tells whether two
                // requests at one data center share a cache
                var id = url.searchParams.get('probe') ?? crypto.randomUUID(),
                    probe = new Request('https://braid-polyfill.cache/whoami/' + id)
                if (!url.searchParams.has('probe') || url.searchParams.has('put'))
                    await caches.default.put(probe, new Response('probe',
                        {headers: {'Cache-Control': 'max-age=60'}}))
                var cached = await caches.default.match(probe)
                return Response.json({
                    colo: request.cf?.colo, continent: request.cf?.continent,
                    country: request.cf?.country,
                    longitude: request.cf?.longitude,
                    region: region_of(request, env), mode: mode_of(env),
                    cache_api: cached ? 'works' : 'no-op'
                })
            }

            var region = region_of(request, env),
                object = env.BRAID_RESOURCE.get(
                    env.BRAID_RESOURCE.idFromName(
                        'site:' + site_of(url, env) + '|' + region),
                    {locationHint: region}
                )
            if (multiplexing) return multiplexer(request, object, url, env)
            if (request.headers.has('subscribe'))
                return subscribe(request, object, url, env, ctx)
            return plain_get(request, object, url, env, ctx)
        }
    }
}

// The multiplexer's own routes: creating a multiplexer, whose stream is relayed
// from the object through a demultiplexer that keeps this data center's
// copies current, and closing one response in it
async function multiplexer (request, object, url, env) {
    try {
        var response = await ask_object(object, request)
    } catch (error) {
        return finish(try_later(), request, env)
    }
    if (request.method !== 'POST' || response.status !== 200)
        return finish(response, request, env)
    var body = response.body.pipeThrough(
        edge.demultiplexer(url.origin, edge.stream_marker()))
    return finish(new Response(body, {status: 200, headers: response.headers}),
                  request, env)
}

// The site a request belongs to, which names its object: the origin's
// host when ORIGIN is set, else the host the request came in on
function site_of (url, env) {
    return env.ORIGIN ? new URL(env.ORIGIN).host : url.host
}

// A reader's subscription, relayed from the object through an observer that
// keeps this data center's copy current for as long as the reader stays
async function subscribe (request, object, url, env, ctx) {
    // A live copy here answers the first sub-response without waiting for
    // the object; the object's stream follows, resuming from that version.
    // So does a stale copy inside the origin's stale-while-revalidate
    // window, and the object's stream is then the revalidation.  A
    // response bound for a multiplexer is the object's to send.
    var variant = edge.variant_of(request)
    if (!variant.version && !variant.parents
        && !request.headers.has('multiplex-through')) {
        var found = await edge.lookup(url, edge.PLAIN)
        if (found?.state === 'live' || (found && edge.serve_while_revalidating(found)))
            return finish(await subscribe_from_copy(found, request, object, url,
                                                    env), request, env)
    }
    try {
        var response = await ask_object(object, request)
    } catch (error) {
        return finish(try_later(), request, env)
    }
    if (wants_relay(response))
        return relay(request, env, wants_relay(response))
    if (response.status !== 209) return finish(response, request, env)
    var body = response.body.pipeThrough(
            edge.observer(url, response.headers.get('braid-cache-control'),
                          edge.stream_marker())),
        headers = new Headers(response.headers)
    headers.delete('braid-cache-control')
    return finish(new Response(body, {status: 209,
                                      statusText: 'Multiresponse', headers}),
                  request, env)
}

// A subscription's 209 sent from this data center's copy: the copy as
// the first sub-response, unless the reader has that version already,
// then everything the object sends from that version on.  A stale copy
// goes out marked stale, with its age and without a claim to the current
// version, and the object's stream that follows is what brings it, and
// the reader, current; the copy is then fed by this reader's stream.
async function subscribe_from_copy (found, request, object, url, env) {
    var copy_headers = found.response.headers,
        version = parse_versions(copy_headers.get('version')),
        known = parse_versions(request.headers.get('parents')),
        body = await found.response.arrayBuffer(),
        resume = new Headers(request.headers),
        live = found.state === 'live',
        send_copy = !(known !== undefined && version !== undefined
                      && versions_match(known, version))
    if (version !== undefined) resume.set('Parents', format_versions(version))

    // The object's stream is opened once the reader has taken the copy, and
    // read a chunk at a time from then on; if the object cannot answer, the
    // stream ends and the reader reconnects
    var upstream = null
    var readable = new ReadableStream({
        start (controller) {
            // The copy is the first byte when it is sent; a bare CRLF is
            // the first byte otherwise
            controller.enqueue(send_copy ? edge.copy_as_update(found, body) : CRLF)
        },
        async pull (controller) {
            if (!upstream) {
                var response = await ask_object(
                    object, new Request(request, {headers: resume}), request)
                if (response.status !== 209)
                    throw new Error('the object answered ' + response.status)
                var marker = edge.stream_marker()
                upstream = response.body.pipeThrough(edge.observer(
                    url, response.headers.get('braid-cache-control'),
                    marker)).getReader()
                if (!live) await edge.adopt(url, marker)
            }
            var {value, done} = await upstream.read()
            if (done) controller.close()
            else controller.enqueue(value)
        },
        cancel () { upstream?.cancel().catch(() => {}) }
    })

    var headers = {
        'Content-Type': 'application/http-history',
        'Subscribe': 'true',
        'Cache-Control': 'no-store',
        'Vary': 'Subscribe',
        'Cache-Status': live ? 'braid-edge; hit; detail=live'
                             : `braid-edge; hit; ttl=-${found.stale_for}; detail=stale-while-revalidate`
    }
    if (request.headers.has('heartbeats'))
        headers['Heartbeats'] = request.headers.get('heartbeats')
    if (live && version !== undefined) headers['Current-Version'] = format_versions(version)
    return new Response(readable, {status: 209, statusText: 'Multiresponse',
                                   headers})
}

async function plain_get (request, object, url, env, ctx) {
    var variant = edge.variant_of(request),
        found = await edge.lookup(url, variant)
    // A request naming a version is answered by the plain copy when that
    // copy is that version
    if (!found && variant.version && !variant.parents) {
        var plain = await edge.lookup(url, edge.PLAIN)
        if (plain && edge.version_key(plain.response.headers.get('version'))
                     === variant.version)
            found = plain
    }
    if (found && found.state !== 'stale') {
        if (found.state === 'live' && found.keeper_until
            && found.keeper_until - Date.now() < HANDOFF_SECONDS * 1000
            && !variant.version && !variant.parents && post_get_window(env) > 0)
            ctx.waitUntil(post_get_subscription(
                request, object, url, found.response.headers.get('version'),
                found.response.headers.get('braid-origin-cache-control'), env,
                edge.stream_marker({keeper_until: Date.now()
                                    + 1000 * post_get_window(env)})))
        return finish(edge.serve(found, request), request, env)
    }
    // A stale copy inside the origin's stale-while-revalidate window is
    // served as it is, and revalidated behind the answer by a keeper, the
    // subscription that brings the copy live again.  A keeper still coming
    // up owns the copy already and is left to it.
    if (found && edge.serve_while_revalidating(found)
        && !variant.version && !variant.parents && post_get_window(env) > 0) {
        if (!(found.keeper_until > Date.now()))
            ctx.waitUntil(post_get_subscription(
                request, object, url, found.response.headers.get('version'),
                found.response.headers.get('braid-origin-cache-control'), env,
                edge.stream_marker({keeper_until: Date.now()
                                    + 1000 * post_get_window(env)})))
        return finish(edge.serve(found, request, {revalidating: true}),
                      request, env)
    }

    try {
        var {response, from_object} = await answer(request, object, env)
    } catch (error) {
        // Neither the object nor, for a relayed request, the origin could
        // be reached: the stale copy if there is one, else try again later
        return finish(found ? edge.serve(found, request, {fwd_status: 503})
                            : try_later(), request, env)
    }
    if (response.status >= 500 && found)
        return finish(edge.serve(found, request,
                                 {fwd_status: response.status}), request, env)
    if (response.status !== 200)
        return finish(appended(response, 'braid-edge; fwd=uri-miss'), request, env)

    var body = await response.arrayBuffer(),
        cache_control = response.headers.get('cache-control'),
        plain_variant = !variant.version && !variant.parents,
        stale = /fwd=stale/.test(response.headers.get('cache-status') ?? '')
    if (edge.shareable(cache_control) && !stale) {
        // Stored live when a post-GET subscription is about to keep it so,
        // which only a resource the object holds a subscription for gets.
        // A keeper still coming up owns the copy already: the answer is
        // stored under its marker and no second keeper starts, or GETs
        // arriving faster than the object answers would each start one
        // and re-point the copy before any marker had come up.
        var keepable = from_object && plain_variant && post_get_window(env) > 0
                && /detail=(live|subscribed)/.test(
                       response.headers.get('cache-status') ?? ''),
            pending_keeper = found?.keeper_until > Date.now()
                             ? found.response.headers.get('braid-live-via')
                             : null,
            keep = keepable && !pending_keeper,
            marker = keep ? edge.stream_marker({keeper_until: Date.now()
                                + 1000 * post_get_window(env)}) : null
        await edge.store(url, variant, {
            version: response.headers.get('version'),
            parents: response.headers.get('parents'),
            content_type: response.headers.get('content-type'),
            cache_control,
            headers: response.headers
        }, body, {via: keep ? marker.id : keepable ? pending_keeper : null})
        if (keep)
            ctx.waitUntil(post_get_subscription(
                request, object, url, response.headers.get('version'),
                cache_control, env, marker))
    }
    var served = new Response(body, {status: 200, headers: response.headers})
    return finish(appended(served, 'braid-edge; fwd=uri-miss'), request, env)
}

// The object's answer, or the origin's if the object declines
async function answer (request, object, env) {
    var response = await ask_object(object, request)
    if (!wants_relay(response)) return {response, from_object: true}
    return {response: await relay(request, env, wants_relay(response),
                                  {raw: true}),
            from_object: false}
}

// The object's answer, after retrying a failed request to it.  Every
// request tells the object which region it is and which data center asked.
async function ask_object (object, request, original = request) {
    var env = ask_object.env, headers = new Headers(request.headers)
    headers.set('Braid-Region', region_of(original, env))
    headers.set('Braid-Colo', original.cf?.colo ?? 'local')
    request = new Request(request, {headers})
    for (var attempt = 1; ; attempt++) {
        try {
            return await object.fetch(request)
        } catch (error) {
            console.error(`object ${new URL(request.url).pathname}: `
                          + `attempt ${attempt} of ${OBJECT_ATTEMPTS}: ${error}`)
            if (attempt === OBJECT_ATTEMPTS) throw error
            await new Promise(resolve =>
                setTimeout(resolve, OBJECT_PAUSE_MS * attempt))
        }
    }
}

// Told to a reader when nothing here can answer right now.  braid-http's
// client, and any other, retries a 503 after Retry-After.
function try_later () {
    return new Response('try again shortly', {
        status: 503,
        headers: {'Retry-After': '1',
                  'Cache-Status': 'braid-edge; fwd=uri-miss; fwd-status=0'}
    })
}

// A subscription held after a plain GET, for POST_GET_SUBSCRIPTION_SECONDS,
// writing each pushed edition into the cache.  It is made on that GET's
// behalf and carries its headers.  A setting of 0 turns it off.
function post_get_window (env) {
    var seconds = parseFloat(env.POST_GET_SUBSCRIPTION_SECONDS)
    return Number.isFinite(seconds) ? seconds : 30
}
async function post_get_subscription (request, object, url, version,
                                      cache_control, env, marker) {
    var aborter = new AbortController(),
        deadline = Date.now() + 1000 * post_get_window(env)
    setTimeout(() => aborter.abort(), deadline - Date.now())
    try {
        // The copy is this keeper's from now, before the one it succeeds ends
        await edge.adopt(url, marker)
        var response = await ask_object(object, new Request(url, {
            headers: {...forwardable_headers(request),
                      'Subscribe': 'true',
                      'Parents': version,
                      'Heartbeats': `${edge.REFRESH_SECONDS}s`,
                      'Braid-Keeper': request.cf?.colo ?? 'local'},
            signal: aborter.signal
        }), request)
        if (response.status === 209)
            await edge.keep_fresh(response.body, url, cache_control, deadline,
                                  marker)
        else marker.end()
    } catch (e) { marker.end() }
}

// Straight to the origin, one-to-one, with a Cache-Status line saying why
async function relay (request, env, reason, {raw} = {}) {
    var headers = new Headers(request.headers)
    headers.delete('host')
    var init = {method: request.method, headers, body: request.body,
                redirect: 'manual'}
    // Subscriptions and credentialed requests stay out of Cloudflare's cache
    if (headers.has('subscribe') || reason === 'private-request')
        init.cache = 'no-store'
    try {
        var response = await fetch(origin_url(request, env), init)
    } catch (error) {
        console.error(`relay (${reason}) ${new URL(request.url).pathname}: `
                      + error)
        if (raw) throw error
        return finish(new Response('origin unreachable', {
            status: 502,
            headers: {'Cache-Status':
                      `braid-edge; fwd=bypass; fwd-status=0; detail=${reason}`}
        }), request, env)
    }
    if (raw) return response
    return finish(appended(response, `braid-edge; fwd=bypass; detail=${reason}`),
                  request, env)
}

function appended (response, cache_status) {
    var headers = new Headers(response.headers)
    headers.append('Cache-Status', cache_status)
    return new Response(response.body, {status: response.status,
                                        statusText: response.statusText,
                                        headers})
}

// Names the data center that answered, and stamps HTML with a <meta> the
// page can show after a plain navigation, when script cannot read headers
function finish (response, request, env) {
    var headers = new Headers(response.headers),
        colo = request.cf?.colo ?? 'local'
    headers.set('X-Cloudflare-Colo', colo)
    // The object's entries say which region's object answered, and how the
    // objects reach the origin
    var status = headers.get('cache-status'),
        where = `region=${region_of(request, env)}; mode=${mode_of(env)}`
    if (status && env)
        headers.set('Cache-Status', status.split(/,\s*(?=braid-)/).map(entry =>
            entry.startsWith('braid-object') ? `${entry}; ${where}` : entry
        ).join(', '))
    var out = new Response(response.body, {status: response.status,
                                           statusText: response.statusText,
                                           headers})
    if (response.status !== 200
        || !/text\/html/.test(headers.get('content-type') ?? ''))
        return out
    var status = (headers.get('cache-status') ?? '').replace(/"/g, ''),
        tag = `<meta name="served-by" content="${status} at ${colo}">`
    return new HTMLRewriter()
        .on('head', {element (head) { head.append(tag, {html: true}) }})
        .transform(out)
}
