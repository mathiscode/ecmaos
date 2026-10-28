/**
 * The cryptography OpenPGP needs that WebCrypto does not give in the form it needs: AES as a block function (OpenPGP's
 * CFB mode encrypts block by block), CFB itself, the AES key wrap of RFC 3394, the string-to-key functions of RFC 4880
 * 3.7, and RSA as plain modular arithmetic on BigInts (OpenPGP pads RSA with PKCS #1 v1.5, which WebCrypto only does for
 * signatures). Hashes are WebCrypto's, with SHA-224 from `../digest.mjs`. Ed25519 and X25519 are WebCrypto's.
 */

import { sha224 } from '../digest.mjs'

// AES (FIPS 197) -------------------------------------------------------------------------------------------------------

const SBOX = new Uint8Array(256)
const INV_SBOX = new Uint8Array(256)
{
  let p = 1, q = 1
  do {
    p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0)
    q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff
    if (q & 0x80) q ^= 0x09
    const x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4))
    SBOX[p] = (x ^ 0x63) & 0xff
  } while (p !== 1)
  SBOX[0] = 0x63
  for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i
}
const xtime = b => ((b << 1) ^ (b & 0x80 ? 0x1b : 0)) & 0xff
const mul = (a, b) => { let r = 0; while (b) { if (b & 1) r ^= a; a = xtime(a); b >>= 1 } return r }

/** The round keys of a 16, 24 or 32-byte key */
export function aesKey(key) {
  const nk = key.length / 4
  if (![4, 6, 8].includes(nk)) throw new Error(`AES key of ${key.length} bytes`)
  const rounds = nk + 6
  const w = new Uint8Array(16 * (rounds + 1))
  w.set(key)
  let rcon = 1
  for (let i = nk; i < 4 * (rounds + 1); i++) {
    let t = w.slice((i - 1) * 4, i * 4)
    if (i % nk === 0) {
      t = Uint8Array.of(SBOX[t[1]] ^ rcon, SBOX[t[2]], SBOX[t[3]], SBOX[t[0]])
      rcon = xtime(rcon)
    } else if (nk > 6 && i % nk === 4) t = t.map(b => SBOX[b])
    for (let j = 0; j < 4; j++) w[i * 4 + j] = w[(i - nk) * 4 + j] ^ t[j]
  }
  return { w, rounds }
}

/** Encrypts one 16-byte block in place */
export function aesEncryptBlock({ w, rounds }, s) {
  for (let i = 0; i < 16; i++) s[i] ^= w[i]
  for (let round = 1; round <= rounds; round++) {
    for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]]
    // shift rows
    let t = s[1]; s[1] = s[5]; s[5] = s[9]; s[9] = s[13]; s[13] = t
    t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t
    t = s[15]; s[15] = s[11]; s[11] = s[7]; s[7] = s[3]; s[3] = t
    if (round !== rounds) {
      for (let c = 0; c < 16; c += 4) {
        const a0 = s[c], a1 = s[c + 1], a2 = s[c + 2], a3 = s[c + 3], all = a0 ^ a1 ^ a2 ^ a3
        s[c] ^= all ^ xtime(a0 ^ a1); s[c + 1] ^= all ^ xtime(a1 ^ a2); s[c + 2] ^= all ^ xtime(a2 ^ a3); s[c + 3] ^= all ^ xtime(a3 ^ a0)
      }
    }
    for (let i = 0; i < 16; i++) s[i] ^= w[round * 16 + i]
  }
  return s
}

/** Decrypts one 16-byte block in place */
export function aesDecryptBlock({ w, rounds }, s) {
  for (let i = 0; i < 16; i++) s[i] ^= w[rounds * 16 + i]
  for (let round = rounds - 1; round >= 0; round--) {
    let t = s[13]; s[13] = s[9]; s[9] = s[5]; s[5] = s[1]; s[1] = t
    t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t
    t = s[3]; s[3] = s[7]; s[7] = s[11]; s[11] = s[15]; s[15] = t
    for (let i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]]
    for (let i = 0; i < 16; i++) s[i] ^= w[round * 16 + i]
    if (round !== 0) {
      for (let c = 0; c < 16; c += 4) {
        const a0 = s[c], a1 = s[c + 1], a2 = s[c + 2], a3 = s[c + 3]
        s[c] = mul(a0, 14) ^ mul(a1, 11) ^ mul(a2, 13) ^ mul(a3, 9)
        s[c + 1] = mul(a0, 9) ^ mul(a1, 14) ^ mul(a2, 11) ^ mul(a3, 13)
        s[c + 2] = mul(a0, 13) ^ mul(a1, 9) ^ mul(a2, 14) ^ mul(a3, 11)
        s[c + 3] = mul(a0, 11) ^ mul(a1, 13) ^ mul(a2, 9) ^ mul(a3, 14)
      }
    }
  }
  return s
}

/** OpenPGP's symmetric algorithms that are AES: id to key size in bytes */
export const CIPHERS = { 7: 16, 8: 24, 9: 32 }
export const CIPHER_NAMES = { 7: 'AES', 8: 'AES192', 9: 'AES256' }

/** CFB with a zero IV and no resynchronisation, as SEIPD and secret-key protection use it */
export function cfb(key, data, decrypt, iv = new Uint8Array(16)) {
  const schedule = aesKey(key)
  const out = new Uint8Array(data.length)
  let feedback = Uint8Array.from(iv)
  for (let i = 0; i < data.length; i += 16) {
    const block = aesEncryptBlock(schedule, Uint8Array.from(feedback))
    const chunk = data.subarray(i, i + 16)
    for (let j = 0; j < chunk.length; j++) out[i + j] = chunk[j] ^ block[j]
    feedback = decrypt ? Uint8Array.from(chunk) : out.slice(i, i + 16)
    if (feedback.length < 16) break
  }
  return out
}

/** AES key wrap (RFC 3394), for the session key of an ECDH message */
export function aesWrap(kek, data) {
  const schedule = aesKey(kek)
  const n = data.length / 8
  let a = new Uint8Array(8).fill(0xa6)
  const r = Array.from({ length: n }, (_, i) => data.slice(i * 8, i * 8 + 8))
  for (let j = 0; j < 6; j++) {
    for (let i = 0; i < n; i++) {
      const b = aesEncryptBlock(schedule, Uint8Array.from([...a, ...r[i]]))
      const t = BigInt(n * j + i + 1)
      a = b.slice(0, 8)
      for (let k = 0; k < 8; k++) a[7 - k] ^= Number((t >> BigInt(8 * k)) & 0xffn)
      r[i] = b.slice(8)
    }
  }
  return Uint8Array.from([...a, ...r.flatMap(block => [...block])])
}

export function aesUnwrap(kek, data) {
  const schedule = aesKey(kek)
  const n = data.length / 8 - 1
  let a = data.slice(0, 8)
  const r = Array.from({ length: n }, (_, i) => data.slice((i + 1) * 8, (i + 2) * 8))
  for (let j = 5; j >= 0; j--) {
    for (let i = n - 1; i >= 0; i--) {
      const t = BigInt(n * j + i + 1)
      const x = Uint8Array.from(a)
      for (let k = 0; k < 8; k++) x[7 - k] ^= Number((t >> BigInt(8 * k)) & 0xffn)
      const b = aesDecryptBlock(schedule, Uint8Array.from([...x, ...r[i]]))
      a = b.slice(0, 8)
      r[i] = b.slice(8)
    }
  }
  if (!a.every(byte => byte === 0xa6)) throw new Error('key unwrap failed: wrong key')
  return Uint8Array.from(r.flatMap(block => [...block]))
}

// Hashes ---------------------------------------------------------------------------------------------------------------

export const HASHES = { 2: 'SHA-1', 8: 'SHA-256', 9: 'SHA-384', 10: 'SHA-512', 11: 'SHA-224' }
export const HASH_NAMES = { 2: 'SHA1', 8: 'SHA256', 9: 'SHA384', 10: 'SHA512', 11: 'SHA224' }
export const HASH_IDS = { SHA1: 2, SHA256: 8, SHA384: 9, SHA512: 10, SHA224: 11 }

export async function hash(id, data) {
  if (id === 11) return sha224(data)
  const name = HASHES[id]
  if (!name) throw new Error(`unsupported hash algorithm ${id}`)
  return new Uint8Array(await crypto.subtle.digest(name, data))
}

export const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) { out.set(part, at); at += part.length }
  return out
}

/** String-to-key (RFC 4880 3.7.1): simple (0), salted (1) or iterated and salted (3), as many bytes as `size` */
export async function s2k(spec, passphrase, size) {
  const pass = new TextEncoder().encode(passphrase)
  const out = []
  let length = 0
  for (let round = 0; length < size; round++) {
    const prefix = new Uint8Array(round)
    let input
    if (spec.type === 0) input = concat(prefix, pass)
    else if (spec.type === 1) input = concat(prefix, spec.salt, pass)
    else if (spec.type === 3) {
      const unit = concat(spec.salt, pass)
      const count = Math.max(spec.count, unit.length)
      input = new Uint8Array(round + count)
      for (let at = round; at < input.length; at += unit.length) input.set(unit.subarray(0, Math.min(unit.length, input.length - at)), at)
    } else throw new Error(`unsupported S2K type ${spec.type}`)
    const digest = await hash(spec.hash, input)
    out.push(digest)
    length += digest.length
  }
  return concat(...out).slice(0, size)
}

/** The octet count of an iterated S2K's coded count */
export const s2kCount = coded => (16 + (coded & 15)) << ((coded >> 4) + 6)

/** The coded count used for what is protected here: 16 MiB hashed per passphrase, which a page can hold at once */
export const S2K_CODED_COUNT = 0xe0

// RSA ------------------------------------------------------------------------------------------------------------------

export const toBig = bytes => bytes.length ? BigInt('0x' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')) : 0n
export function fromBig(n, length) {
  let hex = n.toString(16)
  if (hex.length % 2) hex = '0' + hex
  const bytes = Uint8Array.from(hex.match(/../g) ?? [], h => parseInt(h, 16))
  if (length === undefined || bytes.length >= length) return bytes
  return concat(new Uint8Array(length - bytes.length), bytes)
}
export function modPow(base, exponent, modulus) {
  let result = 1n
  base %= modulus
  while (exponent > 0n) {
    if (exponent & 1n) result = (result * base) % modulus
    base = (base * base) % modulus
    exponent >>= 1n
  }
  return result
}
const modInverse = (a, m) => {
  let [x, y, r0, r1] = [1n, 0n, a % m, m]
  while (r1) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [x, y] = [y, x - q * y] }
  return ((x % m) + m) % m
}

/** DER prefixes of DigestInfo, for PKCS #1 v1.5 signatures */
const DIGEST_INFO = {
  2: [0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x0e, 0x03, 0x02, 0x1a, 0x05, 0x00, 0x04, 0x14],
  8: [0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20],
  9: [0x30, 0x41, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x02, 0x05, 0x00, 0x04, 0x30],
  10: [0x30, 0x51, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x03, 0x05, 0x00, 0x04, 0x40],
  11: [0x30, 0x2d, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x04, 0x05, 0x00, 0x04, 0x1c]
}

function emsaPkcs1(hashId, digest, length) {
  const t = concat(Uint8Array.from(DIGEST_INFO[hashId]), digest)
  if (length < t.length + 11) throw new Error('RSA key too short for this hash')
  return concat(Uint8Array.of(0, 1), new Uint8Array(length - t.length - 3).fill(0xff), Uint8Array.of(0), t)
}

const bytesOf = n => Math.ceil(n.toString(2).length / 8)

export function rsaSign({ n, d, p, q, u }, hashId, digest) {
  const k = bytesOf(n)
  const m = toBig(emsaPkcs1(hashId, digest, k))
  // CRT: OpenPGP's u is p^-1 mod q
  const dp = d % (p - 1n), dq = d % (q - 1n)
  const m1 = modPow(m, dp, p), m2 = modPow(m, dq, q)
  const h = (u * ((m2 - m1 + q) % q)) % q
  return m1 + h * p
}

export function rsaVerify({ n, e }, hashId, digest, signature) {
  const k = bytesOf(n)
  const decoded = fromBig(modPow(signature, e, n), k)
  const expected = emsaPkcs1(hashId, digest, k)
  return decoded.length === expected.length && decoded.every((b, i) => b === expected[i])
}

export function rsaEncrypt({ n, e }, message) {
  const k = bytesOf(n)
  if (message.length > k - 11) throw new Error('message too long for RSA key')
  const padding = new Uint8Array(k - message.length - 3)
  for (let i = 0; i < padding.length; i++) {
    do { padding[i] = crypto.getRandomValues(new Uint8Array(1))[0] } while (padding[i] === 0)
  }
  return modPow(toBig(concat(Uint8Array.of(0, 2), padding, Uint8Array.of(0), message)), e, n)
}

export function rsaDecrypt({ n, d, p, q, u }, c) {
  const k = bytesOf(n)
  const dp = d % (p - 1n), dq = d % (q - 1n)
  const m1 = modPow(c, dp, p), m2 = modPow(c, dq, q)
  const m = m1 + ((u * ((m2 - m1 + q) % q)) % q) * p
  const em = fromBig(m, k)
  if (em[0] !== 0 || em[1] !== 2) throw new Error('RSA decryption failed')
  const zero = em.indexOf(0, 2)
  if (zero < 10) throw new Error('RSA decryption failed')
  return em.slice(zero + 1)
}

/** An RSA key pair from WebCrypto, as OpenPGP's n, e, d, p, q, u */
export async function rsaGenerate(bits) {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: bits, publicExponent: Uint8Array.of(1, 0, 1), hash: 'SHA-256' }, true, ['sign', 'verify'])
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  const b64 = text => toBig(Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=')), c => c.charCodeAt(0)))
  let p = b64(jwk.p), q = b64(jwk.q)
  // OpenPGP wants p < q, with u = p^-1 mod q
  if (p > q) [p, q] = [q, p]
  return { n: b64(jwk.n), e: b64(jwk.e), d: b64(jwk.d), p, q, u: modInverse(p, q) }
}

// Curve25519 -----------------------------------------------------------------------------------------------------------

const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unbase64url = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=')), c => c.charCodeAt(0))

/** A fresh Ed25519 or X25519 key: `{ publicKey, secret }`, both 32 bytes as RFC 8032 and 7748 write them */
export async function curveGenerate(name) {
  const pair = await crypto.subtle.generateKey({ name }, true, name === 'Ed25519' ? ['sign', 'verify'] : ['deriveBits'])
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  return { publicKey: unbase64url(jwk.x), secret: unbase64url(jwk.d) }
}

const curveKey = (name, publicKey, secret, usages) => crypto.subtle.importKey('jwk', { kty: 'OKP', crv: name, x: base64url(publicKey), ...(secret ? { d: base64url(secret) } : {}) }, { name }, false, usages)

export async function ed25519Sign(publicKey, secret, message) {
  return new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, await curveKey('Ed25519', publicKey, secret, ['sign']), message))
}

export async function ed25519Verify(publicKey, message, signature) {
  return await crypto.subtle.verify({ name: 'Ed25519' }, await curveKey('Ed25519', publicKey, undefined, ['verify']), signature, message)
}

/** The X25519 shared secret of a secret and a public key */
export async function x25519(secret, publicKey, ownPublic) {
  const priv = await curveKey('X25519', ownPublic, secret, ['deriveBits'])
  const pub = await crypto.subtle.importKey('raw', publicKey, { name: 'X25519' }, false, [])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: pub }, priv, 256))
}

/** The public key of an X25519 secret, through a key pair WebCrypto can describe */
export async function x25519Public(secret) {
  // the base point is 9; the public key is secret * 9
  const base = new Uint8Array(32); base[0] = 9
  const priv = await crypto.subtle.importKey('pkcs8', concat(Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]), secret), { name: 'X25519' }, true, ['deriveBits'])
  const pub = await crypto.subtle.importKey('raw', base, { name: 'X25519' }, false, [])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: pub }, priv, 256))
}

export const random = n => crypto.getRandomValues(new Uint8Array(n))
