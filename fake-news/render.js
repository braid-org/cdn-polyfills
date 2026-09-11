// Fills client.html with the current edition.  The server sends the whole
// document again on every change, so any HTTP cache can hold the latest
// edition as an ordinary GET response.  client.html is reread on every
// render so edits to it show without a restart.

var fs = require('fs'),
    path = require('path')

var template_file = path.join(__dirname, 'client.html')

module.exports = function render_front_page ({version, edited_at, articles}) {
    var breaking = articles.find(a => a.breaking && a.published),
        published = articles.filter(a => !a.breaking && a.published),
        [lead, ...rest] = published

    var content =
        (breaking ? render_breaking(breaking) : '')
        + (published.length === 0
           ? '<div class="empty">Nothing to report.  Check back soon.</div>'
           : `<div class="grid">${render_article(lead, 'lead')}${rest.map(a => render_article(a)).join('')}</div>`)

    var fields = {
        version: escape(version),
        edited_at: String(edited_at),
        dateline: escape(dateline(edited_at)),
        content
    }
    return fs.readFileSync(template_file, 'utf8')
             .replace(/{{(\w+)}}/g, (match, name) => fields[name] ?? match)
}

function render_breaking (article) {
    return `<section class="breaking">
  <div class="label">BREAKING NEWS</div>
  <h2>${escape(article.title)}</h2>
  <div class="byline">${escape(article.byline)}</div>
  <p class="dek">${escape(article.dek)}</p>
  <div class="body">${article.body.map(p => `<p>${escape(p)}</p>`).join('')}</div>
</section>`
}

function render_article (article, cls = '') {
    return `<article class="${cls}" id="article-${escape(article.id)}">
  <h2>${escape(article.title)}</h2>
  <div class="byline">${escape(article.byline)}</div>
  <p class="dek">${escape(article.dek)}</p>
  <div class="body">${article.body.map(p => `<p>${escape(p)}</p>`).join('')}</div>
</article>`
}

function dateline (ms) {
    return new Date(ms).toLocaleDateString('en-US',
        {weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'})
}

function escape (text) {
    return String(text).replace(/[&<>"']/g,
        c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]))
}
