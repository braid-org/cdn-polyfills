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
redundant snapshot.  Plain responses carry an `ETag` for `If-None-Match`.

    curl -i -H 'Subscribe: true' http://localhost:8080/

## Files

- `server.js`: the server, using braid-http's `braidify` for subscriptions
- `client.html`: the front page, with its style and reader-side script, and placeholders for the edition
- `render.js`: fills client.html with the current articles
- `articles.js`: the stories
- `admin.html`: the admin page
