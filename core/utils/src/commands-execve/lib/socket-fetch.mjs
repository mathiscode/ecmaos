/**
 * `fetch` for a server on this machine. The browser's `fetch` goes out to the network and cannot reach a program
 * listening inside ecmaOS, so a loopback URL (`http://localhost:8000/`, `127.0.0.1`, `[::1]`) is fetched over a TCP
 * socket of the kernel's instead (`ecmaosSyscalls.connect`): HTTP/1.1 with `Connection: close`, a fixed-length or
 * chunked body, and redirects followed as `fetch` follows them. It answers with a `Response`, as `fetch` does.
 */

const { connect, shutdown, read, writeAll, close } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Whether `url` is plain HTTP to this machine, which only a socket reaches */
export function isLoopbackUrl(url) {
  let parsed
  try { parsed = new URL(url) } catch { return false }
  if (parsed.protocol !== 'http:') return false
  const host = parsed.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase()
  return host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

/** `fetch` when the URL is a loopback one, the browser's otherwise; a redirect away from this machine goes out too */
export function fetchAny(url, init) {
  return isLoopbackUrl(String(url)) ? socketFetch(url, init) : fetch(url, init)
}

const REDIRECTS = new Set([301, 302, 303, 307, 308])

/** Reads from `fd` until `until(buffered)` says enough, or the other end closes; what is past the mark stays buffered */
function makeReader(fd) {
  let buffered = new Uint8Array(0)
  let ended = false
  const more = () => {
    if (ended) return false
    const chunk = new Uint8Array(65536)
    const n = read(fd, chunk, -1)
    if (n <= 0) { ended = true; return false }
    const joined = new Uint8Array(buffered.length + n)
    joined.set(buffered)
    joined.set(chunk.subarray(0, n), buffered.length)
    buffered = joined
    return true
  }
  return {
    /** The bytes up to and including `mark`, or `undefined` if the stream ends first */
    until(mark) {
      for (;;) {
        const at = indexOf(buffered, mark)
        if (at >= 0) {
          const head = buffered.subarray(0, at + mark.length)
          buffered = buffered.slice(at + mark.length)
          return head
        }
        if (!more()) return undefined
      }
    },
    /** `count` bytes, or fewer if the stream ends first */
    take(count) {
      while (buffered.length < count && more()) { /* reading */ }
      const head = buffered.subarray(0, Math.min(count, buffered.length))
      buffered = buffered.slice(head.length)
      return head
    },
    /** What is buffered and then whatever comes, a chunk at a time; `null` at the end */
    next() {
      if (!buffered.length && !more()) return null
      const chunk = buffered
      buffered = new Uint8Array(0)
      return chunk
    }
  }
}

function indexOf(bytes, mark) {
  outer: for (let i = 0; i + mark.length <= bytes.length; i++) {
    for (let j = 0; j < mark.length; j++) if (bytes[i + j] !== mark[j]) continue outer
    return i
  }
  return -1
}

const CRLF = encoder.encode('\r\n')
const HEADERS_END = encoder.encode('\r\n\r\n')

/** The body the request carries, as bytes, with the content type it implies when the caller named none */
async function bodyOf(body) {
  if (body === undefined || body === null) return {}
  if (typeof body === 'string') return { bytes: encoder.encode(body), type: 'text/plain;charset=UTF-8' }
  if (body instanceof URLSearchParams) return { bytes: encoder.encode(body.toString()), type: 'application/x-www-form-urlencoded;charset=UTF-8' }
  if (body instanceof Uint8Array) return { bytes: body }
  if (body instanceof ArrayBuffer) return { bytes: new Uint8Array(body) }
  return { bytes: new Uint8Array(await new Response(body).arrayBuffer()) }
}

/** One request and its response, over a connection of its own */
async function exchange(url, method, headers, body) {
  const fd = connect(url.hostname.replace(/^\[(.*)\]$/, '$1'), Number(url.port || 80))
  let open = true
  const finish = () => { if (open) { open = false; try { close(fd) } catch { /* gone */ } } }
  try {
    const { bytes, type } = await bodyOf(body)
    const lines = [`${method} ${url.pathname || '/'}${url.search} HTTP/1.1`, `Host: ${url.host}`]
    const names = new Set([...headers.keys()])
    if (!names.has('user-agent')) lines.push('User-Agent: ecmaOS')
    if (!names.has('accept')) lines.push('Accept: */*')
    for (const [name, value] of headers) if (name !== 'host' && name !== 'connection') lines.push(`${name}: ${value}`)
    if (bytes) {
      if (!names.has('content-type') && type) lines.push(`Content-Type: ${type}`)
      lines.push(`Content-Length: ${bytes.length}`)
    }
    lines.push('Connection: close', '', '')
    writeAll(fd, encoder.encode(lines.join('\r\n')))
    if (bytes?.length) writeAll(fd, bytes)
    try { shutdown(fd, 1) } catch { /* a server that already closed answers anyway */ }

    const reader = makeReader(fd)
    let head = reader.until(HEADERS_END)
    // an informational answer (100 Continue) comes before the real one
    while (head && /^HTTP\/\d(\.\d)? 1\d\d/.test(decoder.decode(head.subarray(0, 12)))) head = reader.until(HEADERS_END)
    if (!head) throw new TypeError(`${url.host}: the server closed the connection without an answer`)
    const [statusLine, ...headerLines] = decoder.decode(head).split('\r\n').filter(Boolean)
    const status = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\s*(.*)$/.exec(statusLine ?? '')
    if (!status) throw new TypeError(`${url.host}: not an HTTP answer: ${JSON.stringify(statusLine)}`)
    const responseHeaders = new Headers()
    for (const line of headerLines) {
      const colon = line.indexOf(':')
      if (colon > 0) responseHeaders.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim())
    }
    const code = Number(status[1])
    const empty = method === 'HEAD' || code === 204 || code === 304
    const chunked = /chunked/i.test(responseHeaders.get('transfer-encoding') ?? '')
    const length = responseHeaders.has('content-length') ? Number(responseHeaders.get('content-length')) : undefined

    let left = length
    let chunkLeft = 0
    let done = empty
    const pull = controller => {
      try {
        if (done) { finish(); controller.close(); return }
        if (chunked) {
          if (chunkLeft === 0) {
            const sizeLine = reader.until(CRLF)
            const size = sizeLine ? parseInt(decoder.decode(sizeLine), 16) : 0
            if (!size) { done = true; finish(); controller.close(); return }
            chunkLeft = size
          }
          const part = reader.take(chunkLeft)
          if (!part.length) { done = true; finish(); controller.close(); return }
          chunkLeft -= part.length
          if (chunkLeft === 0) reader.take(2)
          controller.enqueue(part.slice())
          return
        }
        if (left !== undefined) {
          if (left <= 0) { done = true; finish(); controller.close(); return }
          const part = reader.take(Math.min(left, 65536))
          if (!part.length) { done = true; finish(); controller.close(); return }
          left -= part.length
          controller.enqueue(part.slice())
          return
        }
        const part = reader.next()
        if (!part) { done = true; finish(); controller.close(); return }
        controller.enqueue(part.slice())
      } catch (error) {
        finish()
        controller.error(error)
      }
    }
    const stream = empty ? null : new ReadableStream({ pull, cancel: finish })
    if (empty) finish()
    // `Response` takes 200 to 599; the status line's own words are kept
    const response = new Response(stream, { status: code >= 200 && code <= 599 ? code : 200, statusText: status[2] ?? '', headers: responseHeaders })
    return response
  } catch (error) {
    finish()
    throw error
  }
}

/** `fetch(url, init)` over a socket: `method`, `headers`, `body` and `redirect` (`follow`, `manual` or `error`) */
export async function socketFetch(input, init = {}) {
  let url = new URL(String(input))
  let method = (init.method ?? 'GET').toUpperCase()
  let body = init.body
  const headers = new Headers(init.headers ?? {})
  const redirect = init.redirect ?? 'follow'
  for (let hops = 0; ; hops++) {
    const response = await exchange(url, method, headers, body)
    if (!REDIRECTS.has(response.status) || redirect === 'manual' || !response.headers.get('location')) {
      Object.defineProperty(response, 'url', { value: url.href })
      if (hops) Object.defineProperty(response, 'redirected', { value: true })
      return response
    }
    if (redirect === 'error') throw new TypeError(`${url.href}: redirected, and redirects were refused`)
    if (hops >= 20) throw new TypeError(`${url.href}: too many redirects`)
    await response.body?.cancel()
    const next = new URL(response.headers.get('location'), url)
    // 303, and a 301 or 302 to a POST, become a GET without the body, as fetch does
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      if (method !== 'HEAD') method = 'GET'
      body = undefined
      headers.delete('content-type')
    }
    if (!isLoopbackUrl(next.href)) return fetch(next.href, { method, headers, body, redirect })
    url = next
  }
}
