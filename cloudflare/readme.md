# Braid-HTTP polyfill for Cloudflare

Makes Cloudflare understood [Braid-HTTP](https://braid.org) subscriptions.

Just install it in front of a Braid-HTTP website, and:

- Subscriptions fan out at the edge: a thousand subscribed browsers cost the
  origin one connection per URL.
- Caches stay current by push instead of purge: every edition the origin
  publishes is written into the cache of each data center that has readers.
- Plain reloads never reach the origin while anyone nearby is reading.

Neither the origin nor the browser changes or learns Cloudflare is involved.
When Cloudflare supports subscriptions itself, remove the polyfill and the
site works the same.  That is what makes it a polyfill.

## Installation

Into your own Cloudflare account, on your own bill.

1. Your site's DNS is on Cloudflare, your account is on the Workers Paid
   plan, and your origin speaks Braid-HTTP (for instance with
   [braidify](https://github.com/braid-org/braid-http)).  The Paid plan
   matters: a Worker streaming a subscription accrues CPU for the life of
   the stream, and the Free plan's 10 ms per invocation ends every
   subscription within a minute.  The origin must also be reachable
   without Cloudflare's cache in the way, which means a DNS-only record
   for its hostname, or, if the hostname is proxied, a cache rule that
   bypasses the cache for requests carrying a `Subscribe` header, such
   as `(len(http.request.headers["subscribe"]) > 0 and http.host eq
   "origin.example.com")`.  Cloudflare's cache ignores `Vary` and would
   otherwise answer the polyfill's subscriptions with a stored page.
2. Take this directory as your project: `npm install` in it.  The
   polyfill is the six source files, and `worker.js` is three lines:

       import {braid_polyfill, BraidResource} from './router.js'
       export {BraidResource}
       export default braid_polyfill()
3. In `wrangler.toml`, set `name` to what the worker should be called in
   your account and `ORIGIN` to your origin's address.  To run on a route
   in your zone instead, replace `workers_dev = true` with a `routes` entry
   such as `example.com/*` and leave `ORIGIN` unset; to give the worker
   a hostname of its own, add
   `routes = [{ pattern = "cdn.example.com", custom_domain = true }]` and
   Cloudflare makes the DNS record and the certificate.  The other
   settings are explained beside them in the file; `REGIONS = "reader"`
   gives each of six regions its own object for your site, each holding
   its own subscriptions to your origin, and a region's name instead puts
   every reader on the object there.
4. `npx wrangler login`, then `npx wrangler deploy`.  The first deploy runs
   the migration that creates the `BraidResource` Durable Object class.

Cost: the Workers Paid plan, $5 a month, plus about half a cent per hour
for each region in which the site has readers, at most six.  An idle
object costs nothing.

The demo's own deployments, Fake News and the others, live in
`demo/wrangler.toml` and are deployed with
`npx wrangler deploy --config demo/wrangler.toml --env <name>`, so that
the polyfill's `wrangler.toml` carries nothing of ours.

## What you get

Measured from Dallas against an origin about 75 ms away.  Your numbers will
differ with distance, but the shape will not.

**For the origin.**

- One subscription per URL, no matter how many readers.  Whatever a held
  subscription costs your server, a socket, or a thread in a PHP-style
  server, you pay it once per page, not once per reader.
- Plain page loads mostly never reach you.  At a Cloudflare data center where
  someone is reading, or has read in the last half minute or so, a load is
  served from that data center's own copy.  At any other data center, a load
  is served by the object for the reader's region, as long as it still holds
  a subscription, which it does while anyone in that region is subscribed
  and for a minute after.  Only the first load of a page nobody in the
  region has read recently reaches you.
- Publishing costs one push per URL, into the object.  Fan-out to readers
  happens inside Cloudflare.

**For readers.**

- A subscribed page updates within one push: origin to the region's object,
  object to the reader's data center, data center to browser.  Measured: 45
  to 70 ms from edit to screen in the origin's own region.
- A plain reload gets the newest edition, never more than one in-flight push
  behind the origin.  No purge, and no waiting for a TTL to expire.  After a
  publish, every data center with readers has the new edition within a few
  hundred milliseconds.
- A new subscriber gets the current edition from its own data center's
  copy when that is live, else from its region's object, one hop away,
  without a round trip to the origin.
- A reader that reconnects resumes from the version it has.  If it is
  already current, it receives nothing but heartbeats.

**How your origin's `Cache-Control` interacts with this.**  The polyfill is
a shared HTTP cache, so your headers still mean what they mean.  A page with
`max-age` is served for that long even with no subscription.  A page with
`max-age=0` is served without contacting you only while the polyfill holds a
subscription for it, and revalidated with a conditional request otherwise.
`no-store` and `private` pages are never stored, never served to another
reader, and never fanned out.

**Where the numbers come from Cloudflare's limits, not the design.**

- The half-minute window after a plain load, during which a data center
  keeps itself current with no reader present, is 30 seconds because
  Cloudflare lets a Worker keep running for at most 30 seconds after it has
  answered.
- A data center's copy is its own, not shared with other data centers,
  because the cache a Worker can write is the cache of the data center it
  runs in.
- Objects live in six regions, since those are the Durable Object locations
  with capacity of their own; a reader in South America, Africa or the
  Middle East is served from the region its hint would land in anyway.  A
  reader is placed by the data center that took its request, which
  Cloudflare picks for nearness; only a request from a data center the
  polyfill does not list is placed by the geography of its address, which
  can mislead: a request from another Worker carries the geography of
  whatever request set that Worker going, wherever the Worker itself runs.
- The object releases its origin subscription a minute after the last
  reader leaves, because Cloudflare bills an object for every second it
  holds a stream, about half a cent an hour.
- A reader that vanishes without a proper disconnect is noticed after a few
  missed heartbeats, because a disconnect does not always reach the
  object's stream.

## Features

- `209 Multiresponse` subscriptions pass through Cloudflare with status,
  headers, streaming and heartbeats intact.
- Fan-out: one Durable Object per site per region holds one subscription to
  the origin for each of its URLs and relays every update to every reader
  in the region.  Regions are chosen from the reader's location, and the
  `Cache-Status` line names the region and the mode, `flat`, in which each
  region subscribes to the origin itself.
- Resume: a reader whose `Parents` names the current version gets no
  redundant snapshot, from a warm object or a cold one.
- Plain GETs are answered from the object's copy while it is live, with
  `ETag` and `304`.
- Each data center keeps its own copy of a page, written from every
  subscription relayed through it, and from a subscription the Worker
  holds for 30 s after a plain GET (a post-GET subscription).  Plain GETs
  are served from that copy while anything keeps it live.  A page read
  steadily never lapses: a read in a post-GET subscription's last 5 s
  starts its successor, the object keeps one such subscription per data
  center per URL, and a page nobody reads keeps nothing going.  A
  subscription arriving while the copy is live is answered from it: the
  copy is the first sub-response, and the object's stream follows from
  that version.
- The origin subscription is released a minute after the last reader
  leaves, and a reader that stops reading is noticed within a few
  heartbeats even if its disconnect never reaches the object.
- Every response says what answered it, in the standard `Cache-Status`
  header (RFC 9211): one entry from the object (`braid-object`) and one
  from the data center (`braid-edge`), with `hit`, `fwd=uri-miss`,
  `fwd=bypass`, or `fwd=stale`, and `detail=live` or `detail=fresh`.  Also
  `X-Cloudflare-Colo`, and for HTML a `<meta name="served-by">` carrying
  the same, which the page can show after a plain load.
- Responses that must not be shared are passed through one-to-one:
  requests with `Cookie` or `Authorization` never reach the object or the
  cache, and a resource whose origin answers `private` or `no-store` is
  relayed from then on.
- The origin's `Cache-Control` is honored.  A copy is live while a
  subscription keeps it so and fresh for the origin's `max-age` after,
  with `Age` counted from the moment it stopped being live; `no-cache`
  copies are fresh only while live; a stale copy inside the origin's
  `stale-while-revalidate` window is served at once, to a plain GET and
  as the first sub-response of a subscription alike, while a subscription
  behind it brings it live again; `stale-if-error` copies are served,
  marked stale, when the origin fails.  The policy is read from each
  sub-response's own `Cache-Control`.
- Copies are keyed on the request's `Version` and `Parents` as well as the
  URL, so a versioned request is never answered with another version's
  copy, which Cloudflare's own cache gets wrong.
- Versions are never interpreted.  The object keeps the frontier as a set
  of strings, resumes with all of it, and serves plain GETs from its copy
  only while the frontier is exactly the copy's version and the copy is a
  whole body.
- `410 Gone` clears the object's copy and the cached copy.
- Every GET the object sends to the origin carries `Subscribe: true`,
  whether or not the reader asked for a subscription.  An origin with
  subscriptions for the resource answers 209, and the first plain GET makes
  the resource live.  An origin without answers as it would any GET, and
  the reader gets that answer.  Nothing is probed and nothing is remembered
  about which resources are which.
- `Current-Version` on every 209 the object sends, and used from the
  origin's to know when a resumed copy is current again.
- `104 Origin Status` sub-responses on every stream the object serves:
  `State: up`, with the current version, when the copy is what the origin
  has, and `State: down; because=connecting | catching-up |
  connection-failed | status; status=N; from=<region>` otherwise, each
  with a `Date`.  A new reader gets one right after its snapshot.  The data
  center's copies follow them exactly, live on `up` and not from the
  `Date` of a `down`, so a copy never claims to be current after the origin
  has gone.  With `ORIGIN_SENDS_STATUS = "false"`, the object takes an
  origin's sub-responses as current on arrival and speaks for it; set it to
  `"true"` for an origin that sends its own.  Heartbeats say only that a
  connection is alive.
- A reader's 209 is sent once the origin has answered the object's own
  subscription, so it carries the origin's 209 headers, and a resource the
  origin answers plainly is relayed on that first request.  A subscriber
  waits for that answer as long as it likes, since an origin may hold a
  subscription open until the resource exists; a plain GET gets a 503
  with `Retry-After` after 15 s.
- The object makes its own connection attempts to the origin: a failed
  attempt answers waiting readers at once, with the stale copy or a 503,
  and the next attempt comes after 1, 2, then 3 seconds while anyone is
  subscribed.  An origin answering 408, 409, 423, 425, 429, 309, 432, 500,
  502, 503, 504 or 507 is tried again after its `Retry-After` or the same
  pause, as http_bus classifies those statuses; readers still get the
  answer, or the stale copy, at once.  A failed request to the object is
  retried three times before the reader is told to try again later.
- Passes the Braid suites of [cache-tests](https://github.com/braid-org/cache-tests)
  as deployed on Cloudflare (`results/cloudflare-polyfill.json` there, the
  "Cloudflare with polyfill" column): all 26 required tests of the two
  versioning suites, 4 of 5 optional ones, and 15 of 16 subscription tests.
  The two misses are inferring the current version from the `Parents`
  chains of stored variants (optional), and forwarding a reader's `Parents`
  to the origin unchanged (informational: the object sends its own, since
  it subscribes for every reader).
- Multiplexing.  braid-http's client sends a page's subscriptions through
  one connection: `POST /.well-known/multiplexer/<id>` creates a
  multiplexer, and each subscription carries a `Multiplex-Through` header
  naming it.  The multiplexer terminates in the site's object, which answers
  each subscription 293 and writes its 209 into the multiplexer's stream,
  and the Worker relaying that stream splits it on the way through to keep
  the data center's copies current; a response closed with `DELETE` stops
  keeping its copy live.  A page with hundreds of subscriptions costs the
  browser one stream.
- A test suite: `npm test` runs the polyfill's own scenarios against
  wrangler's local runtime and a local Fake News (`test/run.cjs`), including
  braid-http's own client multiplexing through the polyfill; `npm test --
  <text>` runs only the scenarios whose names contain the text.
  `experiments/` holds the region and latency measurements.

## Limitations

- The origin serves one subscription per URL per region with readers, up
  to six, rather than one in all, and sends each update that many times.
  A tree mode, where regions subscribe to one central object, is not
  built; see `plan.md`.
- A data center's copy is current only where a stream is flowing: a
  reader's subscription or a post-GET subscription, which lives 30 seconds.
  Under steady plain traffic one load in every half minute takes the long
  way to the object.  Two loads that miss at the same moment start two
  post-GET subscriptions.
- A copy fed by a stream that dies without ending cleanly, a Worker
  evicted mid-stream, can be served as current for a second or two after,
  until its marker lapses.  A copy fed by two streams at once is marked by
  the one that wrote it last, so when that stream ends the copy is treated
  as not current until the next update or load re-marks it.
- The `104 Origin Status` sub-responses reach every reader unless
  `READER_STATUS` is `"false"`, and the published braid-http client, 1.5.1,
  hands them to the application as bodiless updates; an application that
  expects patches on every update breaks on them, as mail.braid.org's page
  did.  Fake News's page ignores them.  With the setting off, only the
  polyfill's own keepers get them, so a copy fed by a reader's stream is
  never marked live; keepers keep plain loads local as before.
- A 404 or 410 from the origin to a subscription is passed to the reader
  and not retried by the object.
- A resource that sends patches rather than whole pages is not served from
  a copy, and a reader subscribing to it while the object's copy is not
  whole receives that copy as a snapshot before the patches that follow.
- Requests naming a `Version` or `Parents` go to the origin unless a live
  copy is exactly that version.
- Cost is per site per region with readers, about half a cent per
  object-hour, and one object carries all of a site's traffic in its region
  on one thread.
- Route-based installation with no `ORIGIN` setting is written and untried.

Each of these is addressed in `plan.md`.

## How it works

`router.js` is the Worker half, and runs at whichever Cloudflare data
center a request lands on.  It decides where each request goes:
subscriptions and plain GETs of shareable resources to the Durable Object
for their site, everything else to the origin one-to-one.  On the way
through a data center, every edition pushed to a reader is also written
into that data center's cache.  Each stream through a data center, a
reader's 209, a multiplexer's stream, or a post-GET subscription, keeps one
marker entry there that says it is flowing, and a copy is served as current
while the marker of the stream that fed it is live.  A stream that ends
writes its marker as ended, and every copy it fed stops being current at
that moment.

`edge-cache.js` is that copy: its key, which includes the request's
`Version` and `Parents`; its states, live, fresh, or stale; its `Age`; and
its `Cache-Status` line.

`http-history.js` frames and parses the body of a 209 and a multiplexer's
stream, for both halves.

`multiplexer.js` is the multiplexer, held by the site's object: the multiplexers,
the subscriptions written into them, and the well-known routes that create
and close them.

`resource.js` is the Durable Object, `BraidResource`, one per site,
holding a `Resource` for each URL that has been asked for.  A `Resource`
subscribes to the origin with the braid-http client library, keeps the
newest whole-body update as its copy and the frontier of versions as a
set, and writes its own `209` stream to each reader, framed the way
braidify frames it.  It sends heartbeats only while its own origin
subscription is answered, which is what lets a data center's copy lapse
when the origin goes away.  `GET /.braid-polyfill/status` on the polyfill
lists what the site's object holds, and `GET /.braid-polyfill/whoami`
says which data center saw the request, what it knew of where the request
came from, and which region's object it would use.

## Running the demo

The origin in `demo/wrangler.toml` is Fake News (`../fake-news`), a
fictional news site.  Its admin page shows the origin's subscriber and
request counts live, which is where the polyfill's effect is visible.

    npx wrangler dev                                          # against a local origin, see .dev.vars
    npx wrangler deploy --config demo/wrangler.toml --env v2  # the polyfill at bcdn.fake.braid.news
    npx wrangler tail --config demo/wrangler.toml --env v2
