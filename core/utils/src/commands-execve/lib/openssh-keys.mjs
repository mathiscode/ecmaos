/**
 * OpenSSH keys, the `openssh-key-v1` private format and the one-line public format, over WebCrypto: generating ed25519, RSA
 * and ECDSA keys, reading an unencrypted private key (or a public one), and fingerprints. A passphrase is not supported.
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const concat = parts => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) { out.set(part, at); at += part.length }
  return out
}
const u32 = n => Uint8Array.of(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255)
const str = bytes => concat([u32(bytes.length), bytes])
const text = s => str(encoder.encode(s))
/** a big-endian unsigned number as an SSH mpint: no leading zeros, a zero byte first when the high bit is set */
const mpint = bytes => {
  let start = 0
  while (start < bytes.length && bytes[start] === 0) start++
  const body = bytes.subarray(start)
  return str(body.length && body[0] & 0x80 ? concat([Uint8Array.of(0), body]) : body)
}

export const toBase64 = bytes => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s) }
export const fromBase64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0))
const fromBase64Url = s => fromBase64(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='))

const CURVES = { 256: 'nistp256', 384: 'nistp384', 521: 'nistp521' }
const CURVE_NAMES = { 256: 'P-256', 384: 'P-384', 521: 'P-521' }

/** A reader over an SSH wire-format buffer */
function reader(bytes) {
  let at = 0
  const take = n => { if (at + n > bytes.length) throw new Error('invalid key format'); const out = bytes.subarray(at, at + n); at += n; return out }
  return {
    u32: () => { const b = take(4); return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0 },
    string() { return take(this.u32()) },
    rest: () => bytes.subarray(at)
  }
}

/** The public blob of a key: `string type, ...` */
function publicBlob(key) {
  if (key.type === 'ssh-ed25519') return concat([text('ssh-ed25519'), str(key.pub)])
  if (key.type === 'ssh-rsa') return concat([text('ssh-rsa'), mpint(key.e), mpint(key.n)])
  return concat([text(key.type), text(key.curve), str(key.q)])
}

/** `ssh-ed25519 AAAA... comment` */
export const publicLine = (key, comment = '') => `${key.type} ${toBase64(publicBlob(key))}${comment ? ` ${comment}` : ''}`

/** `SHA256:...`, the digest of the public blob in base64 without padding */
export async function fingerprint(key) {
  return 'SHA256:' + toBase64(new Uint8Array(await crypto.subtle.digest('SHA-256', publicBlob(key)))).replace(/=+$/, '')
}

/** The size OpenSSH shows with a fingerprint */
export function bitsOf(key) {
  if (key.type === 'ssh-ed25519') return 256
  if (key.type === 'ssh-rsa') { const n = key.n; let i = 0; while (i < n.length && n[i] === 0) i++; return (n.length - i) * 8 - Math.clz32(n[i]) + 24 }
  return Number(key.curve.slice(-3))
}

export const labelOf = key => (key.type === 'ssh-ed25519' ? 'ED25519' : key.type === 'ssh-rsa' ? 'RSA' : 'ECDSA')

/** @returns a key with its parts as bytes: ed25519 `{ pub, seed }`, rsa `{ n, e, d, p, q, iqmp }`, ecdsa `{ curve, q, d }` */
export async function generate(kind, bits) {
  if (kind === 'ed25519') {
    let pair
    try { pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) } catch { throw new Error('this browser cannot make ed25519 keys') }
    const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
    return { type: 'ssh-ed25519', pub: fromBase64Url(jwk.x), seed: fromBase64Url(jwk.d) }
  }
  if (kind === 'rsa') {
    bits = bits ?? 3072
    if (!Number.isInteger(bits) || bits < 1024 || bits > 16384) throw new Error(`Invalid RSA key length: minimum is 1024 bits`)
    const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: bits, publicExponent: Uint8Array.of(1, 0, 1), hash: 'SHA-256' }, true, ['sign', 'verify'])
    const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
    const [n, e, d, p, q, qi] = ['n', 'e', 'd', 'p', 'q', 'qi'].map(field => fromBase64Url(jwk[field]))
    return { type: 'ssh-rsa', n, e, d, p, q, iqmp: qi }
  }
  if (kind === 'ecdsa') {
    bits = bits ?? 256
    if (!CURVES[bits]) throw new Error('Invalid ECDSA key length: valid lengths are 256, 384 or 521 bits')
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: CURVE_NAMES[bits] }, true, ['sign', 'verify'])
    const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
    return { type: `ecdsa-sha2-${CURVES[bits]}`, curve: CURVES[bits], q: concat([Uint8Array.of(4), fromBase64Url(jwk.x), fromBase64Url(jwk.y)]), d: fromBase64Url(jwk.d) }
  }
  throw new Error(`unknown key type ${kind}`)
}

/** The `-----BEGIN OPENSSH PRIVATE KEY-----` file for an unencrypted key */
export function privateFile(key, comment = '') {
  const check = crypto.getRandomValues(new Uint8Array(4))
  let body
  if (key.type === 'ssh-ed25519') body = concat([text('ssh-ed25519'), str(key.pub), str(concat([key.seed, key.pub]))])
  else if (key.type === 'ssh-rsa') body = concat([text('ssh-rsa'), mpint(key.n), mpint(key.e), mpint(key.d), mpint(key.iqmp), mpint(key.p), mpint(key.q)])
  else body = concat([text(key.type), text(key.curve), str(key.q), mpint(key.d)])
  let block = concat([check, check, body, text(comment)])
  const pad = (8 - (block.length % 8)) % 8
  block = concat([block, Uint8Array.from({ length: pad }, (_, i) => i + 1)])
  const blob = concat([encoder.encode('openssh-key-v1\0'), text('none'), text('none'), text(''), u32(1), str(publicBlob(key)), str(block)])
  const lines = toBase64(blob).match(/.{1,70}/g)
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`
}

/** Reads a private key file; throws `Error('passphrase')` when it is encrypted and `Error('invalid format')` when it is not an OpenSSH key */
export function parsePrivate(fileText) {
  const match = /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/.exec(fileText)
  if (!match) throw new Error('invalid format')
  const bytes = fromBase64(match[1].replace(/\s+/g, ''))
  const magic = encoder.encode('openssh-key-v1\0')
  if (!magic.every((b, i) => bytes[i] === b)) throw new Error('invalid format')
  const r = reader(bytes.subarray(magic.length))
  const cipher = decoder.decode(r.string())
  const kdf = decoder.decode(r.string())
  r.string()
  if (r.u32() !== 1) throw new Error('invalid format')
  r.string()
  if (cipher !== 'none' || kdf !== 'none') throw new Error('passphrase')
  const inner = reader(r.string())
  if (inner.u32() !== inner.u32()) throw new Error('invalid format')
  const type = decoder.decode(inner.string())
  if (type === 'ssh-ed25519') {
    const pub = inner.string()
    const both = inner.string()
    return { key: { type, pub: new Uint8Array(pub), seed: both.slice(0, 32) }, comment: decoder.decode(inner.string()) }
  }
  if (type === 'ssh-rsa') {
    const [n, e, d, iqmp, p, q] = [0, 1, 2, 3, 4, 5].map(() => inner.string())
    return { key: { type, n, e, d, iqmp, p, q }, comment: decoder.decode(inner.string()) }
  }
  if (type.startsWith('ecdsa-sha2-')) {
    const curve = decoder.decode(inner.string())
    const q = inner.string()
    const d = inner.string()
    return { key: { type, curve, q, d }, comment: decoder.decode(inner.string()) }
  }
  throw new Error(`unsupported key type ${type}`)
}

/** Reads a public key line (`TYPE BASE64 [comment]`) */
export function parsePublic(line) {
  const parts = line.trim().split(/\s+/)
  if (parts.length < 2) throw new Error('invalid format')
  const r = reader(fromBase64(parts[1]))
  const type = decoder.decode(r.string())
  if (type !== parts[0]) throw new Error('invalid format')
  const comment = parts.slice(2).join(' ')
  if (type === 'ssh-ed25519') return { key: { type, pub: r.string() }, comment }
  if (type === 'ssh-rsa') { const e = r.string(); const n = r.string(); return { key: { type, e, n }, comment } }
  if (type.startsWith('ecdsa-sha2-')) { const curve = decoder.decode(r.string()); return { key: { type, curve, q: r.string() }, comment } }
  throw new Error(`unsupported key type ${type}`)
}
