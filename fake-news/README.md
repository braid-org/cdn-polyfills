# Fake News

A fictional news site that speaks Braid-HTTP to push live updates.  We test our Braid-enabled CDNs in front of it.

The `/admin` page publishes and unpublishes stories, and can put up a
breaking-news story.  Every change is pushed to open readers through
a Braid subscription, and a plain reload gets the new edition as an ordinary
GET.

## Run it

    npm install
    node server.js 3458         # http://localhost:3458/ and /admin

## Resources

| URL | What | Changes when |
|---|---|---|
| `GET /` | the front page, complete HTML | an article is published or unpublished |
| `GET /state` | which articles are published, JSON | same |
| `GET /stats` | open subscriptions and request counts, JSON | any request or push arrives, at most 4 times a second |
| `PUT /articles/<id>` | `{"published": true}` or `false` | |

Every `GET` accepts `Subscribe: true` and answers with a `209 Multiresponse`
that stays open, sending the complete new representation each time the
resource changes.  Each response carries `Version: "<edition>"`, and a
subscriber that sends `Parents: "<edition>"` for the current edition gets no
redundant snapshot, only a `104 Origin Status` sub-response saying
`State: up`; one that gets a snapshot gets the 104 after it.  Plain
responses carry an `ETag` for `If-None-Match`.

    curl -i -H 'Subscribe: true' http://localhost:8080/

The front page's script subscribes to the page's own URL.  With
`/?poll=<ms>` it polls the URL instead, the way a page behind a CDN that
knows nothing of subscriptions would.

## The same page over a websocket

For comparison, the way sites bolt live updates onto a CDN today:

| URL | What |
|---|---|
| `GET /shell` | the front page's masthead, style and footer with no articles, cacheable for an hour |
| `GET /ws` | a websocket that sends the articles as JSON on connect and on every publish |

The static part names the websocket to fill it from as `/ws` on whatever
host it was loaded from, so a CDN in front must pass websocket upgrades
through; `FAKE_NEWS_WS_URL` in the environment names another URL when one
cannot.  `/stats` counts open websockets too.

Framed by a comparison page, both pages report their timings to it with
`postMessage`: the browser's time to first and last byte, when the page
became live, and each edition's delay from publish to screen.

## Files

- `server.js`: the server, using braid-http's `braidify` for subscriptions
- `client.html`: the front page, with its style and reader-side script, and placeholders for the edition
- `shell.html`: the front page's static part, filled over the websocket
- `render.js`: fills client.html with the current articles
- `articles.js`: the stories
- `admin.html`: the admin page

## Purging a plain CDN on every edit

A CDN that knows nothing of subscriptions learns of a new edition the
way such CDNs do, by a purge.  With these three in the environment, every
edition purges the named URLs through Cloudflare's purge-by-URL API, and
`/stats` counts the purges and reports how long the last one took:

    PURGE_URLS="https://cdn.example.com/ https://cdn.example.com/?poll=5000"
    CLOUDFLARE_ZONE_ID=<the zone's id>
    CLOUDFLARE_PURGE_TOKEN=<an API token with only Cache Purge on that zone>

Cloudflare caches each URL with its query string separately and a purge
names exact URLs, so the list must name every URL readers fetch.  Without
all three settings nothing is purged.
