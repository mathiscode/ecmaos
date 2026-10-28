/**
 * Message digests: the SHA family through the platform's `crypto.subtle`, and what it does not have written out here:
 * MD5 (RFC 1321), SHA-224 (FIPS 180-4) and BLAKE2b-512 (RFC 7693). MD5 is for checking files against published sums,
 * not for anything secret.
 */

const SHA = { sha1: 'SHA-1', sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' }

const K = new Uint32Array(64).map((_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32))
const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]

export function md5(bytes) {
  const length = bytes.length
  const padded = new Uint8Array(((length + 8) >> 6 << 6) + 64)
  padded.set(bytes)
  padded[length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, (length << 3) >>> 0, true)
  view.setUint32(padded.length - 4, Math.floor(length / 2 ** 29), true)
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476
  const m = new Uint32Array(16)
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) m[i] = view.getUint32(offset + i * 4, true)
    let a = a0, b = b0, c = c0, d = d0
    for (let i = 0; i < 64; i++) {
      let f, g
      if (i < 16) { f = (b & c) | (~b & d); g = i }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16 }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16 }
      else { f = c ^ (b | ~d); g = (7 * i) % 16 }
      f = (f + a + K[i] + m[g]) >>> 0
      a = d; d = c; c = b
      const shift = S[(i >> 4) * 4 + (i % 4)]
      b = (b + ((f << shift) | (f >>> (32 - shift)))) >>> 0
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0
  }
  const out = new Uint8Array(16)
  const outView = new DataView(out.buffer)
  ;[a0, b0, c0, d0].forEach((word, i) => outView.setUint32(i * 4, word, true))
  return out
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
])

/** SHA-224: SHA-256 with its own starting values, cut to seven words */
export function sha224(bytes) {
  const length = bytes.length
  const padded = new Uint8Array(((length + 8) >> 6 << 6) + 64)
  padded.set(bytes)
  padded[length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(length / 2 ** 29), false)
  view.setUint32(padded.length - 4, (length << 3) >>> 0, false)
  const h = new Uint32Array([0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939, 0xffc00b31, 0x68581511, 0x64f98fa7, 0xbefa4fa4])
  const w = new Uint32Array(64)
  const rotr = (x, n) => (x >>> n) | (x << (32 - n))
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, k] = h
    for (let i = 0; i < 64; i++) {
      const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[i] + w[i]) >>> 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      k = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    ;[a, b, c, d, e, f, g, k].forEach((value, i) => { h[i] = (h[i] + value) >>> 0 })
  }
  const out = new Uint8Array(28)
  const outView = new DataView(out.buffer)
  for (let i = 0; i < 7; i++) outView.setUint32(i * 4, h[i], false)
  return out
}

const BLAKE2B_IV = [0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n, 0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n]
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4], [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13], [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11], [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5], [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0]
]
const MASK64 = (1n << 64n) - 1n
const rotr64 = (x, n) => ((x >> n) | (x << (64n - n))) & MASK64

/** BLAKE2b with a 64-byte digest and no key, as `b2sum` computes it */
export function blake2b(bytes, outLength = 64) {
  const h = BLAKE2B_IV.slice()
  h[0] ^= 0x01010000n ^ BigInt(outLength)
  const block = new Uint8Array(128)
  const m = new Array(16)
  const v = new Array(16)
  let counter = 0n
  const compress = last => {
    const view = new DataView(block.buffer)
    for (let i = 0; i < 16; i++) m[i] = view.getBigUint64(i * 8, true)
    for (let i = 0; i < 8; i++) { v[i] = h[i]; v[i + 8] = BLAKE2B_IV[i] }
    v[12] ^= counter & MASK64
    v[13] ^= counter >> 64n
    if (last) v[14] ^= MASK64
    const g = (a, b, c, d, x, y) => {
      v[a] = (v[a] + v[b] + x) & MASK64; v[d] = rotr64(v[d] ^ v[a], 32n)
      v[c] = (v[c] + v[d]) & MASK64; v[b] = rotr64(v[b] ^ v[c], 24n)
      v[a] = (v[a] + v[b] + y) & MASK64; v[d] = rotr64(v[d] ^ v[a], 16n)
      v[c] = (v[c] + v[d]) & MASK64; v[b] = rotr64(v[b] ^ v[c], 63n)
    }
    for (let round = 0; round < 12; round++) {
      const s = SIGMA[round % 10]
      g(0, 4, 8, 12, m[s[0]], m[s[1]]); g(1, 5, 9, 13, m[s[2]], m[s[3]]); g(2, 6, 10, 14, m[s[4]], m[s[5]]); g(3, 7, 11, 15, m[s[6]], m[s[7]])
      g(0, 5, 10, 15, m[s[8]], m[s[9]]); g(1, 6, 11, 12, m[s[10]], m[s[11]]); g(2, 7, 8, 13, m[s[12]], m[s[13]]); g(3, 4, 9, 14, m[s[14]], m[s[15]])
    }
    for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8]
  }
  let offset = 0
  // every block but the last is compressed as it fills; the last, even if full or empty, is compressed as last
  while (bytes.length - offset > 128) {
    block.set(bytes.subarray(offset, offset + 128))
    counter += 128n
    compress(false)
    offset += 128
  }
  block.fill(0)
  block.set(bytes.subarray(offset))
  counter += BigInt(bytes.length - offset)
  compress(true)
  const out = new Uint8Array(outLength)
  const outView = new DataView(new ArrayBuffer(64))
  h.forEach((word, i) => outView.setBigUint64(i * 8, word, true))
  out.set(new Uint8Array(outView.buffer).subarray(0, outLength))
  return out
}

const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')

/** The digest of `bytes` as lower-case hex, for `md5`, `sha1`, `sha256`, `sha384` or `sha512`. */
export async function digestHex(algorithm, bytes) {
  if (algorithm === 'md5') return hex(md5(bytes))
  if (algorithm === 'sha224') return hex(sha224(bytes))
  if (algorithm === 'blake2b') return hex(blake2b(bytes))
  const name = SHA[algorithm]
  if (!name) throw new Error(`unsupported algorithm '${algorithm}'`)
  return hex(new Uint8Array(await crypto.subtle.digest(name, bytes)))
}

export const algorithms = ['md5', 'sha224', 'blake2b', ...Object.keys(SHA)]
