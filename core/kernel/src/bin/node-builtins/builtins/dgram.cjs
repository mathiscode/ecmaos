/** `dgram`: loads, so a package that only mentions it works; using it says it is not there */
const unavailable = what => Object.assign(new Error(`${what} is not available in ecmaOS programs yet`), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' })
const refuse = name => function () { throw unavailable('dgram.' + name) }

const isIPv4 = text => /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?!$)|$)){4}$/.test(String(text))
const isIPv6 = text => { try { return new URL(`http://[${text}]`).hostname.length > 2 && String(text).includes(':') } catch { return false } }

module.exports = {
  isIP: text => (isIPv4(text) ? 4 : isIPv6(text) ? 6 : 0),
  isIPv4,
  isIPv6,
  Socket: class Socket { constructor() { throw unavailable('dgram.Socket') } },
  Server: class Server { constructor() { throw unavailable('dgram.Server') } },
  createServer: refuse('createServer'),
  createConnection: refuse('createConnection'),
  connect: refuse('connect'),
  isPrimary: true,
  isMaster: true,
  isWorker: false
}
