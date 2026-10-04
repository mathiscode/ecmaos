/**
 * Message digests: the SHA family through the platform's `crypto.subtle`, and MD5, which it does not have,
 * written out here (RFC 1321). MD5 is for checking files against published sums, not for anything secret.
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

const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')

/** The digest of `bytes` as lower-case hex, for `md5`, `sha1`, `sha256`, `sha384` or `sha512`. */
export async function digestHex(algorithm, bytes) {
  if (algorithm === 'md5') return hex(md5(bytes))
  const name = SHA[algorithm]
  if (!name) throw new Error(`unsupported algorithm '${algorithm}'`)
  return hex(new Uint8Array(await crypto.subtle.digest(name, bytes)))
}

export const algorithms = ['md5', ...Object.keys(SHA)]
