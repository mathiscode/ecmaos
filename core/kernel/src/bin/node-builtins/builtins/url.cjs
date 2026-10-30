/** Node's `url`: the legacy `parse`/`format`/`resolve` from the `url` package, with the WHATWG classes and file URL helpers */
const legacy = require('@polyfill/url')

function fileURLToPath(url) {
  const parsed = typeof url === 'string' ? new URL(url) : url
  if (parsed.protocol !== 'file:') throw Object.assign(new TypeError('The URL must be of scheme file'), { code: 'ERR_INVALID_URL_SCHEME' })
  return decodeURIComponent(parsed.pathname)
}

function pathToFileURL(path) {
  const resolved = require('node:path').resolve(path)
  return new URL('file://' + resolved.split('/').map(encodeURIComponent).join('/').replace(/%2F/g, '/') + (path.endsWith('/') && !resolved.endsWith('/') ? '/' : ''))
}

module.exports = {
  ...legacy,
  URL: globalThis.URL,
  URLSearchParams: globalThis.URLSearchParams,
  fileURLToPath,
  pathToFileURL,
  urlToHttpOptions: url => ({ protocol: url.protocol, hostname: url.hostname.replace(/^\[|\]$/g, ''), hash: url.hash, search: url.search, pathname: url.pathname, path: `${url.pathname || ''}${url.search || ''}`, href: url.href, port: url.port === '' ? undefined : Number(url.port), ...(url.username || url.password ? { auth: `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}` } : {}) }),
  domainToASCII: domain => new URL(`http://${domain}`).hostname,
  domainToUnicode: domain => domain
}
