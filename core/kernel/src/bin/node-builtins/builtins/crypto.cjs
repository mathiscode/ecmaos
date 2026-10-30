/**
 * Node's `crypto`: hashes, HMACs, PBKDF2, ciphers and signatures from `crypto-browserify`, random values and the Web
 * Crypto API from the browser's own. Everything here is synchronous, as Node's is.
 */
const polyfill = require('@polyfill/crypto-browserify')
const web = globalThis.crypto

const randomInt = (min, max, callback) => {
  if (max === undefined || typeof max === 'function') { callback = max; max = min; min = 0 }
  const range = max - min
  const limit = Math.floor(0x100000000 / range) * range
  let value
  do { value = web.getRandomValues(new Uint32Array(1))[0] } while (value >= limit)
  const result = min + (value % range)
  if (typeof callback === 'function') { setTimeout(callback, 0, null, result); return undefined }
  return result
}

module.exports = {
  ...polyfill,
  webcrypto: web,
  subtle: web.subtle,
  getRandomValues: array => web.getRandomValues(array),
  randomUUID: () => web.randomUUID(),
  randomInt,
  timingSafeEqual: (a, b) => {
    if (a.byteLength !== b.byteLength) throw Object.assign(new RangeError('Input buffers must have the same byte length'), { code: 'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH' })
    let difference = 0
    for (let i = 0; i < a.byteLength; i++) difference |= a[i] ^ b[i]
    return difference === 0
  },
  hash: (algorithm, data, encoding = 'hex') => polyfill.createHash(algorithm).update(data).digest(encoding)
}
