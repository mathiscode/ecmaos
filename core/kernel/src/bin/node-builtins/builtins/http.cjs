/**
 * Node's `http` client over `fetch` (`stream-http`): `get` and `request` with streaming responses. There is no server
 * here; `createServer` says so.
 */
// stream-http reads `location.protocol` to default a request's protocol; a worker without one has none to give
if (typeof globalThis.location === 'undefined') globalThis.location = { protocol: 'http:', hostname: 'localhost', host: 'localhost', href: 'http://localhost/' }
const http = require('@polyfill/http')

const unavailable = what => Object.assign(new Error(`${what} is not available: ecmaOS programs cannot listen with http yet`), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' })

/** A request holds the program open from the call until its response has ended, or it failed */
function hold(request) {
  const release = process.__ecmaos.hold()
  request.on('error', release).on('close', release).on('abort', release)
  request.on('response', response => { response.on('end', release).on('close', release).on('error', release) })
  return request
}

module.exports = {
  ...http,
  request: (...args) => hold(http.request(...args)),
  get: (...args) => { const request = hold(http.request(...args)); request.end(); return request },
  createServer: () => { throw unavailable('http.createServer') },
  Server: class Server { constructor() { throw unavailable('http.Server') } },
  maxHeaderSize: 16384,
  METHODS: ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'],
  globalAgent: http.globalAgent ?? new http.Agent()
}
