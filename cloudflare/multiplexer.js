// The multiplexer, terminated in the site's object.  braid-http's client
// creates a multiplexer with POST /.well-known/multiplexer/<id>, whose
// response is a stream that stays open, then sends each subscription as a
// GET carrying Multiplex-Through: /.well-known/multiplexer/<id>/<request-id>.
// The GET is answered 293 and its 209 is written into the multiplexer's
// stream in framed chunks, `N bytes for response <id>`, with a
// Content-Location header naming its URL so the Worker relaying the stream
// can keep the data center's copies current.  DELETE on a request's URL
// closes it.  Heartbeats go on the multiplexer's stream, so multiplexed
// responses carry no Heartbeats header, which braid-http's client would
// otherwise time per response.  Spec: https://braid.org/protocol/multiplexing

import {CRLF, multiplexer_line, multiplexer_frame, serialize_status_and_headers}
    from './http-history.js'
import {stalled} from './resource.js'

var MULTIPLEX_VERSION = '1.0',
    EARLY_GET_WAIT_MS = 10,        // a GET may arrive before its multiplexer's POST
    MULTIPLEXER_HEARTBEAT_SECONDS = 1

// The multiplexer routes are meant to be reachable from any page, so their
// responses, errors included, are CORS-free
var FREE_CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': '*'
}

export class Multiplexers {
    constructor () {
        this.multiplexers = new Map()   // id -> multiplexer
        this.waiting = new Map()   // id -> functions to call when it is created
        // How many were made and how each ended, for the status endpoint
        this.counts = {created: 0, destroyed: {}}
    }

    // Which multiplexer request this is, or null: creating a multiplexer,
    // closing one response, or a subscription to send through one
    static route (request) {
        var url = new URL(request.url),
            version = request.headers.get('multiplex-version'),
            path = /^\/\.well-known\/multiplexer\/([\w-]+)(?:\/([\w-]+))?$/
                   .exec(url.pathname)
        if (path && request.method === 'POST' && !path[2])
            return {kind: 'create', id: path[1], version}
        if (path && request.method === 'DELETE' && path[2])
            return {kind: 'close', id: path[1], rid: path[2], version}
        var through = /^\/\.well-known\/multiplexer\/([\w-]+)\/([\w-]+)$/
                      .exec(request.headers.get('multiplex-through') ?? '')
        if (through && request.method === 'GET'
            && request.headers.has('subscribe')
            && version === MULTIPLEX_VERSION)
            return {kind: 'through', id: through[1], rid: through[2]}
        return null
    }

    create (route, request) {
        if (route.version !== MULTIPLEX_VERSION)
            return reply(400, 'Bad Multiplexer Version', '')
        if (this.multiplexers.has(route.id))
            return conflict('Multiplexer already exists',
                `Cannot create duplicate multiplexer with ID '${route.id}'`)

        var multiplexer = {id: route.id, responses: new Map()},
            stream = new ReadableStream({
                start: controller => {
                    // Its reader is judged as a lone stream's is: gone
                    // once the queue has stayed unread for STALL_SECONDS,
                    // which a page's burst of subscriptions never does
                    multiplexer.write = bytes => {
                        if (stalled(multiplexer, controller))
                            return this.destroy(multiplexer, 'stalled')
                        try { controller.enqueue(bytes) }
                        catch (e) { this.destroy(multiplexer, 'enqueue-failed') }
                    }
                    multiplexer.end = () => {
                        try { controller.close() } catch (e) {}
                    }
                },
                cancel: () => this.destroy(multiplexer, 'cancelled')
            })
        this.multiplexers.set(route.id, multiplexer)
        this.counts.created++
        multiplexer.write(CRLF)
        multiplexer.heartbeat = setInterval(() => multiplexer.write(CRLF),
                                       MULTIPLEXER_HEARTBEAT_SECONDS * 1000)
        for (var wake of this.waiting.get(route.id) ?? []) wake()
        this.waiting.delete(route.id)
        // A media type Cloudflare does not compress: gzip would hold every
        // small frame back in the compressor until it had a block's worth
        return new Response(stream, {status: 200, headers: {
            'Multiplex-Version': MULTIPLEX_VERSION,
            'Incremental': '?1',
            'Content-Type': 'application/octet-stream',
            'Cache-Control': 'no-store, no-transform',
            ...FREE_CORS
        }})
    }

    // The multiplexer's reader is gone: every response through it is closed
    destroy (multiplexer, why) {
        if (this.multiplexers.has(multiplexer.id))
            this.counts.destroyed[why] = (this.counts.destroyed[why] ?? 0) + 1
        clearInterval(multiplexer.heartbeat)
        this.multiplexers.delete(multiplexer.id)
        for (var {resource, subscriber} of multiplexer.responses.values()) {
            subscriber.close = null
            resource.remove_subscriber(subscriber)
        }
        multiplexer.responses.clear()
        multiplexer.end?.()
    }

    async through (route, request, resource) {
        var multiplexer = this.multiplexers.get(route.id)
        if (!multiplexer) {
            // The POST creating the multiplexer may be a few milliseconds behind
            await new Promise(wake => {
                this.waiting.set(route.id,
                                 [...(this.waiting.get(route.id) ?? []), wake])
                setTimeout(wake, EARLY_GET_WAIT_MS)
            })
            multiplexer = this.multiplexers.get(route.id)
        }
        if (!multiplexer)
            return reply(424, 'Multiplexer not found',
                         `multiplexer ${route.id} does not exist`,
                         {'Bad-Multiplexer': route.id})
        if (multiplexer.responses.has(route.rid))
            return conflict('Request already multiplexed',
                `Cannot multiplex request with duplicate ID '${route.rid}' `
                + `for multiplexer '${route.id}'`)

        // The response is written into the multiplexer's stream: its status
        // line and headers first, then every byte of its body, framed under
        // its request id
        var url = new URL(request.url), frame = bytes =>
            multiplexer.write(multiplexer_frame(route.rid, bytes))
        var subscriber = {
            start: started => frame(serialize_status_and_headers({
                ...started,
                headers: {...started.headers,
                          'Content-Location': url.pathname + url.search}
            })),
            write: frame,
            close: () => {
                multiplexer.responses.delete(route.rid)
                multiplexer.write(multiplexer_line('close', route.rid))
            }
        }
        multiplexer.responses.set(route.rid, {resource, subscriber})
        multiplexer.write(multiplexer_line('start', route.rid))
        var started = await resource.open_subscription(request, subscriber,
                                                       {heartbeats: false})
        if (started instanceof Response) {
            // No 209 to multiplex: the answer goes back on the GET itself
            multiplexer.responses.delete(route.rid)
            multiplexer.write(multiplexer_line('close', route.rid))
            return started
        }
        return reply(293, 'Responded via multiplexer', 'Ok.', {
            'Multiplex-Through': request.headers.get('multiplex-through'),
            'Cache-Control': 'no-store'
        })
    }

    close (route) {
        if (route.version !== MULTIPLEX_VERSION)
            return reply(400, 'Bad Multiplexer Version', '')
        var multiplexer = this.multiplexers.get(route.id)
        if (!multiplexer)
            return reply(404, 'Multiplexer not found',
                         `multiplexer ${route.id} does not exist`,
                         {'Bad-Multiplexer': route.id})
        var entry = multiplexer.responses.get(route.rid)
        if (!entry)
            return reply(404, 'Multiplexed request not found',
                         `request ${route.rid} is not multiplexed`,
                         {'Bad-Request': route.rid})
        entry.resource.remove_subscriber(entry.subscriber)
        return reply(200, 'OK', '')
    }
}

function reply (status, statusText, body, headers = {}) {
    return new Response(body, {status, statusText, headers: {
        'Multiplex-Version': MULTIPLEX_VERSION, ...FREE_CORS, ...headers
    }})
}

function conflict (error, details) {
    return new Response(JSON.stringify({error, details}), {
        status: 409, statusText: 'Conflict',
        headers: {'Content-Type': 'application/json',
                  'Multiplex-Version': MULTIPLEX_VERSION, ...FREE_CORS}
    })
}
