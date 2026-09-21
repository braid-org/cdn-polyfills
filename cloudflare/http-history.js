// The application/http-history format, the body of a 209 Multiresponse: a
// sequence of sub-responses, each framed like an HTTP response without the
// protocol on its first line, separated by blank lines that double as
// heartbeats.  Framing here matches braidify byte for byte; reading uses
// the braid client's parser.  The object frames, the Worker reads.

import braid from './node_modules/braid-http/braid-http-client.js'

var encoder = new TextEncoder(), decoder = new TextDecoder()
export var CRLF = encoder.encode('\r\n')

// Version and Parents header values are comma-separated JSON strings.  An
// absent header is undefined; a present but empty one is the empty set,
// which is itself a version.
export function parse_versions (header) {
    if (header === null || header === undefined) return undefined
    try { return JSON.parse('[' + header + ']') }
    catch (e) { return [] }
}

// Whether two version lists, either possibly absent, name the same set
export function versions_match (a, b) {
    if (a === undefined || b === undefined) return a === b
    return same_versions(a, b)
}

export function format_versions (versions) {
    return versions.map(v => JSON.stringify(v)).join(', ')
}

// Set equality of two version lists; a missing list is the empty set
export function same_versions (a = [], b = []) {
    return a.length === b.length && a.every(v => b.includes(v))
}

// A header of a parsed update, whichever of the client's two update shapes
// it came in
export function update_header (update, name) {
    return update.headers?.[name] ?? update.extra_headers?.[name]
}

export function serialize_update (update) {
    var status = update.status ?? 200,
        reason = {104: 'Origin Status', 200: 'OK', 410: 'Gone'}[status] ?? '',
        lines = [`HTTP ${status} ${reason}`],
        parts = []
    if (update.version)
        lines.push('Version: ' + format_versions(update.version))
    if (update.parents?.length)
        lines.push('Parents: ' + format_versions(update.parents))
    for (var [name, value] of Object.entries(update.extra_headers ?? {}))
        lines.push(`${name}: ${value}`)

    if (update.body !== undefined) {
        var body = binary(update.body)
        if (update.content_type)
            lines.push('Content-Type: ' + update.content_type)
        lines.push('Content-Length: ' + body.byteLength)
        parts.push(encoder.encode(lines.join('\r\n') + '\r\n\r\n'), body)
    } else if (update.patches?.length === 1) {
        var patch = update.patches[0], content = binary(patch.content)
        if (update.content_type)
            lines.push('Content-Type: ' + update.content_type)
        lines.push('Content-Length: ' + content.byteLength,
                   `Content-Range: ${patch.unit} ${patch.range}`)
        parts.push(encoder.encode(lines.join('\r\n') + '\r\n\r\n'), content)
    } else if (update.patches) {
        lines.push('Content-Type: application/http-patches; count='
                   + update.patches.length,
                   `Patches: ${update.patches.length}`)
        parts.push(encoder.encode(lines.join('\r\n') + '\r\n\r\n'))
        update.patches.forEach((patch, i) => {
            var content = binary(patch.content)
            if (i > 0) parts.push(encoder.encode('\r\n\r\n'))
            parts.push(encoder.encode(`Content-Length: ${content.byteLength}\r\n`
                                      + `Content-Range: ${patch.unit} `
                                      + `${patch.range}\r\n\r\n`),
                       content)
        })
    } else
        parts.push(encoder.encode(lines.join('\r\n') + '\r\n\r\n'))

    parts.push(encoder.encode('\r\n\r\n'))
    return concat(parts)
}

// An incremental parser: feed it the bytes of a 209 body as they arrive
// and it returns each completed sub-response as the client's parser leaves
// it: version, parents, status, content_type, headers, and body or patches
export function parser () {
    var state = {input: new Uint8Array(0)}
    return {
        feed (chunk) {
            var updates = []
            state.input = concat([state.input, chunk])
            while (state.input.length) {
                state = braid.parse_update(state)
                if (state.result !== 'success') break
                updates.push(state)
                state = {input: state.input}
            }
            return updates
        }
    }
}

// Bytes of a string, a typed array, or an ArrayBuffer, as a view that
// Uint8Array.set can copy from; set() copies nothing from a bare
// ArrayBuffer and leaves zeros where the bytes should be
function binary (data) {
    return typeof data === 'string' ? encoder.encode(data)
         : data instanceof ArrayBuffer ? new Uint8Array(data)
         : data
}

export function concat (parts) {
    var out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0)),
        offset = 0
    for (var part of parts) { out.set(part, offset); offset += part.byteLength }
    return out
}

// ---- The multiplexer's framing ----
//
// A multiplexer's stream is a sequence of lines, each `start response <id>`,
// `close response <id>`, or `<n> bytes for response <id>` followed by n
// bytes, with any number of bare CRLFs between them as heartbeats.

export function multiplexer_line (kind, rid) {
    return encoder.encode(`${kind} response ${rid}\r\n`)
}

export function multiplexer_frame (rid, bytes) {
    bytes = binary(bytes)
    var line = `${bytes.byteLength} bytes for response ${rid}\r\n`
    return concat([encoder.encode(line), bytes])
}

// A response's status line and header section, as a multiplexed response
// begins
export function serialize_status_and_headers ({status, statusText, headers}) {
    return encoder.encode(`HTTP/1.1 ${status} ${statusText}\r\n`
        + Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`)
                .join('')
        + '\r\n')
}

// Splits a multiplexer's stream into events as chunks are fed:
// {kind: 'start' | 'close', rid} and {kind: 'bytes', rid, bytes}
var LINE = /^[\r\n]*((\d+) bytes for|close|start) response ([A-Za-z0-9_-]+)\r\n/
export function multiplexer_parser () {
    var input = new Uint8Array(0),
        pending = null  // {rid, size} once a chunk line has been read
    return {
        feed (chunk) {
            var events = []
            input = concat([input, chunk])
            for (;;) {
                if (pending) {
                    if (input.byteLength < pending.size) break
                    events.push({kind: 'bytes', rid: pending.rid,
                                 bytes: input.slice(0, pending.size)})
                    input = input.slice(pending.size)
                    pending = null
                    continue
                }
                var text = decoder.decode(input.slice(0, 200)),
                    line = LINE.exec(text)
                if (!line) {
                    // Not a whole line yet, or only heartbeats so far
                    if (!/^[\r\n]*$/.test(text) && !text.includes('\n')) break
                    if (/^[\r\n]*$/.test(text)) { input = new Uint8Array(0); break }
                    break
                }
                input = input.slice(encoder.encode(line[0]).byteLength)
                if (line[1] === 'start' || line[1] === 'close')
                    events.push({kind: line[1], rid: line[3]})
                else pending = {rid: line[3], size: +line[2]}
            }
            return events
        }
    }
}

// A multiplexed response's status line and header section, once its bytes
// hold the blank line that ends them: {status, headers (lowercased names),
// rest (the bytes after)}, or null while incomplete.  The status line may
// carry the protocol version or not.
export function parse_status_and_headers (bytes) {
    var text = decoder.decode(bytes), end = text.indexOf('\r\n\r\n')
    if (end === -1) return null
    var lines = text.slice(0, end).split('\r\n'),
        status = parseInt(/^(?:HTTP\/\S+ )?(\d+)/.exec(lines[0])?.[1]),
        headers = {}
    for (var line of lines.slice(1)) {
        var colon = line.indexOf(':')
        if (colon > 0)
            headers[line.slice(0, colon).trim().toLowerCase()] =
                line.slice(colon + 1).trim()
    }
    var length = encoder.encode(text.slice(0, end + 4)).byteLength
    return {status, headers, rest: bytes.slice(length)}
}

// A 104 Origin Status sub-response as {up, because, date}, or null for any
// other sub-response.  `State: up`, or `State: down; because=<why>; ...`.
export function origin_status (update) {
    if (update.status !== 104) return null
    var headers = update.extra_headers ?? update.headers ?? {},
        state = headers.state ?? headers.State ?? '',
        parts = state.split(';').map(part => part.trim()),
        because = parts.find(part => part.startsWith('because='))
    return {
        up: parts[0] === 'up',
        because: because ? because.slice(8) : null,
        date: Date.parse(headers.date ?? headers.Date ?? '') || Date.now()
    }
}
