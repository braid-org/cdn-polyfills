# Braid Polyfills for CDNs

These polyfills give the Braid-HTTP power of *subscriptions* to CDNs:

  - Cloudflare
  - Fastly `planned`
  - Bunny.net `planned`

This provides two major performance improvements:

1. **Regular pages** get updates pushed to the cache in **0.5 RTT**, rather than the existing **1.5 RTT** that it takes to:
   - Tell the CDN to purge a cache entry (in 0.5 RTT)
   - Have a client try to GET it again
   - And then (in 1 RTT) have the CDN go to the origin to fetch the new value
2. **Dynamic pages** that use a WebSocket or SSE today (bypassing the CDN) can instead *fan out through* the CDN, and *cache* updates there
   - First load is way faster, because the page doesn't have to wait on a WebSocket to open to the origin and fetch the data after the page has loaded.
   - The subscriptions can fan out through the CDN to N clients, requiring only 1 subscription to the origin server

## How to use

- Add the polyfill to your CDN (see below)
- Now you can put it in front of any origin server that speaks Braid-HTTP, and it will become a distributed *synchronized* cache that fans out subscriptions to clients, keeping everyone up to date with minimal load on your server.

## Implementation Status

Thus far, we've implemented a polyfill for Cloudflare.  It adds a Cloudflare edge Worker that reads the Braid headers and routes requests to an internal Durable Object, which maintains a persistent subscription upstream to the Braid-HTTP origin.

## Cloudflare Instructions

You need a Cloudflare account on the Workers Paid plan (the Free plan's
CPU limit ends a streaming subscription within a minute) and an origin
that speaks Braid-HTTP, such as a node server using
[braidify](https://github.com/braid-org/braid-http).  Then:

1. `cd cloudflare && npm install && npx wrangler login`
2. In `wrangler.toml`, set `ORIGIN` to your origin's URL.
3. `npx wrangler deploy`

Your site is now served through the worker's `workers.dev` address, or
through a custom domain you add to the worker in the dashboard.  Every
answer carries a `Cache-Status` header saying whether it came from a
live copy at the edge, from the regional object, or from the origin.
The settings, the cost, and `npm test` are described in
[`cloudflare/README.md`](cloudflare/README.md).

## Demo app: Fake News

The `./fake-news/` directory holds a demo Braid-HTTP app: a fictional
news site whose front page is pushed to every open reader as soon as an
editor changes it.

To install and run:

    cd fake-news
    npm install
    node server.js 8080

Open `http://localhost:8080/` to see the front page.  Go to `/admin` to
publish and unpublish stories, and watch the front page update live.

To try it through the polyfill, run Fake News where Cloudflare can reach
it and set `ORIGIN` in `cloudflare/wrangler.toml` to its URL.  The
resources it serves, the same page over a websocket for comparison, and
the settings that make it purge a plain CDN on every edit are described
in [`fake-news/README.md`](fake-news/README.md).
