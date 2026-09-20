// Fake News: a fictional news site that speaks Braid-HTTP, built to sit
// behind CDNs for braid-cdn-polyfills.  Three subscribable resources:
//
//   GET /        the front page, as complete HTML on every edition
//   GET /state   which articles are published, as JSON, for the admin page
//   GET /stats   open subscriptions and request counts, as JSON
//
// and one way to change things:
//
//   PUT /articles/<id>   {"published": true|false}
//
// Any request may carry `Subscribe: true`; it then gets a 209 Multiresponse
// that stays open and receives each new edition as it is published.
//
// For comparison, the same front page the way sites bolt live updates onto
// a CDN today, a static shell filled over a websocket:
//
//   GET /shell   the page's chrome with no articles, cacheable for an hour
//   GET /ws      a websocket that sends the articles on connect and on
//                every publish

var http = require('http'),
    fs = require('fs'),
    path = require('path'),
    crypto = require('crypto'),
    {braidify, free_cors} = require('braid-http'),
    articles = require('./articles'),
    render_front_page = require('./render')

var port = process.argv[2] || process.env.PORT || 8080,
    state_file = path.join(__dirname, 'state.json'),
    client_library = path.join(__dirname, 'node_modules/braid-http/braid-http-client.js')

// Runtime state is only the published flags, plus an edition number that
// every change increments.  It is mirrored to state.json so a restart keeps
// the current edition.
var state = {
    version: 1,
    edited_at: Date.now(),
    published: Object.fromEntries(articles.map(a => [a.id, a.published]))
}
try {
    var saved = JSON.parse(fs.readFileSync(state_file))
    state = {...state, ...saved, published: {...state.published, ...saved.published}}
} catch (e) {}

function save_state () {
    fs.writeFileSync(state_file, JSON.stringify(state, null, 2))
}

function current_articles () {
    return articles.map(a => ({...a, published: !!state.published[a.id]}))
}

function set_published (id, published) {
    state.published[id] = published
    state.version++
    state.edited_at = Date.now()
    save_state()
    broadcast('/')
    broadcast('/state')
    broadcast_websockets()
}

// Counters shown on the admin page
// The stats version starts from the clock so it keeps rising across restarts
var stats = {started_at: Date.now(), requests: 0, updates_sent: 0, stats_version: Date.now()}

var resources = {
    '/': {
        repr_type: 'text/html',
        version: () => String(state.version),
        body: () => render_front_page({
            version: String(state.version),
            edited_at: state.edited_at,
            articles: current_articles()
        })
    },
    '/state': {
        repr_type: 'application/json',
        version: () => String(state.version),
        body: () => JSON.stringify({
            version: String(state.version),
            edited_at: state.edited_at,
            articles: current_articles().map(
                ({id, title, byline, breaking, published}) =>
                    ({id, title, byline, breaking: !!breaking, published}))
        }, null, 2)
    },
    '/stats': {
        repr_type: 'application/json',
        version: () => String(stats.stats_version),
        body: () => JSON.stringify({
            subscriptions: Object.fromEntries(
                Object.entries(resources).map(([url, r]) => [url, r.subscribers.size])),
            websockets: websockets.size,
            requests: stats.requests,
            updates_sent: stats.updates_sent,
            uptime_seconds: Math.round((Date.now() - stats.started_at) / 1000)
        }, null, 2)
    }
}
for (var r of Object.values(resources)) r.subscribers = new Set()

function broadcast (url) {
    var resource = resources[url],
        update = {version: [resource.version()], body: resource.body()}
    for (var res of resource.subscribers) {
        res.sendUpdate(update)
        stats.updates_sent++
    }
    if (url !== '/stats') stats_changed()
}

// Stats change on every request and push, so pushes of the stats resource
// itself are coalesced: at most one every 250 ms.
var stats_push_timer = null
function stats_changed () {
    if (stats_push_timer) return
    stats_push_timer = setTimeout(() => {
        stats_push_timer = null
        stats.stats_version++
        broadcast('/stats')
    }, 250)
}

function serve_resource (req, res, resource) {
    var version = resource.version(),
        etag = JSON.stringify(version)

    res.setHeader('Repr-Type', resource.repr_type)
    res.setHeader('ETag', etag)

    // Caches that do not understand subscriptions must check every time,
    // and the ETag makes that a cheap 304; a Braid-aware cache serves from
    // its copy for as long as it holds a subscription instead.  If the
    // origin is down, any cache may serve what it has for a day.  Each
    // sub-response of a subscription carries this too, since braidify marks
    // the 209 itself no-store.
    var cache_control = 'public, max-age=0, stale-if-error=86400'
    res.setHeader('Cache-Control', cache_control)

    if (req.subscribe) {
        // Lets a subscriber resuming from the current edition tell "nothing
        // missed" from "nothing sent yet"
        res.setHeader('Current-Version', JSON.stringify(version))
        res.startSubscription({onClose: () => {
            resource.subscribers.delete(res)
            stats_changed()
        }})
        resource.subscribers.add(res)
        stats_changed()

        // A subscriber resuming from the current edition has missed nothing
        if (!req.parents || req.parents[0] !== version)
            res.sendUpdate({version: [version], body: resource.body(),
                            'Cache-Control': cache_control})

        // From here the subscriber has everything, and is told so with a
        // 104 Origin Status sub-response, which caches in between pass on.
        // Spelled out as an update so that any braidify sends it.
        res.sendUpdate({status: 104, state: 'up',
                        date: new Date().toUTCString(), body: ''})
    } else if (req.headers['if-none-match'] === etag) {
        res.statusCode = 304
        res.end()
    } else {
        res.statusCode = 200
        res.sendUpdate({version: [version], body: resource.body()})
        res.end()
    }
}

function serve_file (req, res, file, content_type, cache_control) {
    res.writeHead(200, {'Content-Type': content_type, 'Cache-Control': cache_control})
    fs.createReadStream(file).pipe(res)
}

function read_body (req) {
    return new Promise((resolve, reject) => {
        var chunks = []
        req.on('data', c => chunks.push(c))
        req.on('end', () => resolve(Buffer.concat(chunks).toString()))
        req.on('error', reject)
    })
}

// JSON answers, readable from any page: the admin and comparison pages
// may live on other hosts
function send_json (res, status, object) {
    free_cors(res)
    res.writeHead(status, {'Content-Type': 'application/json'})
    res.end(JSON.stringify(object, null, 2))
}

async function put_article (req, res, id) {
    var article = articles.find(a => a.id === id)
    if (!article) return send_json(res, 404, {error: `no article ${id}`})
    try { var change = JSON.parse(await read_body(req)) }
    catch (e) { return send_json(res, 400, {error: 'body must be JSON'}) }
    if (typeof change.published !== 'boolean')
        return send_json(res, 400, {error: 'body must be {"published": true|false}'})
    set_published(id, change.published)
    console.log(`  ${change.published ? 'published' : 'unpublished'} "${article.title}" (edition ${state.version})`)
    send_json(res, 200, {id, published: change.published, version: String(state.version)})
}

var server = http.createServer(braidify(async (req, res) => {
    stats.requests++
    stats_changed()
    var url = new URL(req.url, 'http://x').pathname
    console.log(`${new Date().toISOString()} ${req.method} ${url}${req.subscribe ? ' (subscribe)' : ''}`)
    try { await route(req, res, url) }
    catch (e) {
        console.error(`  failed: ${e.stack}`)
        if (!res.headersSent) send_json(res, 500, {error: String(e)})
        else res.end()
    }
}))

async function route (req, res, url) {
    if (req.method === 'OPTIONS') {
        // A page on another host asking whether it may PUT
        free_cors(res)
        res.writeHead(204)
        res.end()
    }
    else if (req.method === 'GET' && resources[url])
        serve_resource(req, res, resources[url])
    else if (req.method === 'PUT' && url.startsWith('/articles/'))
        await put_article(req, res, url.slice('/articles/'.length))
    else if (req.method === 'GET' && url === '/shell')
        serve_shell(req, res)
    else if (req.method === 'GET' && url === '/admin')
        serve_file(req, res, path.join(__dirname, 'admin.html'), 'text/html', 'no-cache')
    else if (req.method === 'GET' && url === '/braid-http-client.js')
        serve_file(req, res, client_library, 'text/javascript', 'public, max-age=3600')
    else
        send_json(res, 404, {error: 'not found'})
}

// ---- The static shell and its websocket ----

// The static part names the websocket to fill it from: `/ws` on whatever
// host the page was loaded from, which a CDN in front must pass through,
// or FAKE_NEWS_WS_URL when one cannot
function serve_shell (req, res) {
    var ws_url = process.env.FAKE_NEWS_WS_URL ?? '/ws',
        html = fs.readFileSync(path.join(__dirname, 'shell.html'), 'utf8')
                 .replace('{{ws_url}}', ws_url)
    res.writeHead(200, {'Content-Type': 'text/html',
                        'Cache-Control': 'public, max-age=3600'})
    res.end(html)
}

// The articles as the websocket sends them: everything the shell renders
function websocket_message () {
    return JSON.stringify({version: String(state.version),
                           edited_at: state.edited_at,
                           articles: current_articles()})
}

var websockets = new Set()

function broadcast_websockets () {
    var message = websocket_frame(1, websocket_message())
    for (var socket of websockets) {
        socket.write(message)
        stats.updates_sent++
    }
}

// The websocket protocol (RFC 6455), the little of it a push-only server
// needs: the opening handshake, unmasked text frames out, and reading the
// masked frames in for a close or a ping
server.on('upgrade', (req, socket) => {
    stats.requests++
    var url = new URL(req.url, 'http://x').pathname
    if (url !== '/ws' || req.headers.upgrade?.toLowerCase() !== 'websocket') {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
        return socket.destroy()
    }
    var accept = crypto.createHash('sha1')
        .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64')
    socket.write('HTTP/1.1 101 Switching Protocols\r\n'
                 + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
                 + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`)
    console.log(`${new Date().toISOString()} WEBSOCKET /ws`)
    websockets.add(socket)
    stats_changed()

    var unread = Buffer.alloc(0)
    socket.on('data', bytes => {
        var {frames, rest} = websocket_frames(Buffer.concat([unread, bytes]))
        unread = rest
        for (var frame of frames) {
            if (frame.opcode === 8) socket.end(websocket_frame(8, frame.payload))
            else if (frame.opcode === 9) socket.write(websocket_frame(10, frame.payload))
        }
    })
    socket.on('close', () => { websockets.delete(socket); stats_changed() })
    socket.on('error', () => {})
    socket.write(websocket_frame(1, websocket_message()))
    stats.updates_sent++
})

// One frame from this server, unmasked, in one piece
function websocket_frame (opcode, payload) {
    payload = Buffer.from(payload)
    var length = payload.length, head
    if (length < 126) head = Buffer.from([0x80 | opcode, length])
    else if (length < 65536) {
        head = Buffer.alloc(4)
        head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(length, 2)
    } else {
        head = Buffer.alloc(10)
        head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(length), 2)
    }
    return Buffer.concat([head, payload])
}

// The whole frames at the front of a client's bytes, unmasked, and the
// bytes of a frame still incomplete
function websocket_frames (bytes) {
    var frames = []
    for (;;) {
        if (bytes.length < 2) break
        var opcode = bytes[0] & 0x0f, masked = bytes[1] & 0x80,
            length = bytes[1] & 0x7f, at = 2
        if (length === 126) {
            if (bytes.length < 4) break
            length = bytes.readUInt16BE(2); at = 4
        } else if (length === 127) {
            if (bytes.length < 10) break
            length = Number(bytes.readBigUInt64BE(2)); at = 10
        }
        var mask = masked ? bytes.subarray(at, at + 4) : null
        if (masked) at += 4
        if (bytes.length < at + length) break
        var payload = Buffer.from(bytes.subarray(at, at + length))
        if (mask) for (var i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
        frames.push({opcode, payload})
        bytes = bytes.subarray(at + length)
    }
    return {frames, rest: bytes}
}

server.listen(port, () => console.log(`Fake News on http://localhost:${port}/  (admin at /admin)`))
