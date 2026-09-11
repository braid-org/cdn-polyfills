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

var http = require('http'),
    fs = require('fs'),
    path = require('path'),
    {braidify} = require('braid-http'),
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
}

// Counters shown on the admin page
var stats = {started_at: Date.now(), requests: 0, updates_sent: 0, stats_version: 0}

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

    // Caches that do not understand subscriptions must revalidate every
    // time; the ETag makes that a cheap 304.  A Braid-aware cache serves
    // from its copy for as long as it holds a subscription instead.
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate')

    if (req.subscribe) {
        res.startSubscription({onClose: () => {
            resource.subscribers.delete(res)
            stats_changed()
        }})
        resource.subscribers.add(res)
        stats_changed()

        // A subscriber resuming from the current edition has missed nothing
        if (!req.parents || req.parents[0] !== version)
            res.sendUpdate({version: [version], body: resource.body()})
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

function send_json (res, status, object) {
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
    if (req.method === 'GET' && resources[url])
        serve_resource(req, res, resources[url])
    else if (req.method === 'PUT' && url.startsWith('/articles/'))
        await put_article(req, res, url.slice('/articles/'.length))
    else if (req.method === 'GET' && url === '/admin')
        serve_file(req, res, path.join(__dirname, 'admin.html'), 'text/html', 'no-cache')
    else if (req.method === 'GET' && url === '/braid-http-client.js')
        serve_file(req, res, client_library, 'text/javascript', 'public, max-age=3600')
    else
        send_json(res, 404, {error: 'not found'})
}

server.listen(port, () => console.log(`Fake News on http://localhost:${port}/  (admin at /admin)`))
