/**
 * OpenPGP messages: signing (inline with a one-pass signature, cleartext, detached), verifying them, and encrypting to
 * public keys (RSA, or ECDH on Curve25519 with RFC 6637's key wrap) or with a passphrase into a v1 SEIPD packet (CFB with
 * a modification detection code), and decrypting. Compressed data (ZIP and ZLIB) is read through the platform's
 * DecompressionStream; what this writes is not compressed.
 */

import { CIPHERS, CIPHER_NAMES, aesUnwrap, aesWrap, cfb, concat, curveGenerate, fromBig, hash, random, rsaDecrypt, rsaEncrypt, s2k, s2kCount, S2K_CODED_COUNT, toBig, x25519 } from './crypto.mjs'
import { ALGO, OID_CV25519, makeSignature, parseSignature, signedData, verifySignature } from './keys.mjs'
import { Reader, TAG, mpi, packet, readPackets, u16, u32 } from './packets.mjs'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const sameBytes = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i])

/** Text as a text signature covers it: lines ending CR LF; with `trim`, trailing blanks removed (cleartext signatures) */
export function canonicalText(text, trim = false) {
  const lines = text.replace(/\r\n/g, '\n').split('\n').map(line => (trim ? line.replace(/[ \t]+$/, '') : line))
  return encoder.encode(lines.join('\r\n'))
}

export function literal(data, { name = '', format = 'b', date = Math.floor(Date.now() / 1000) } = {}) {
  const fileName = encoder.encode(name).subarray(0, 255)
  return packet(TAG.LITERAL, concat(Uint8Array.of(format.charCodeAt(0), fileName.length), fileName, u32(date), data))
}

function onePass(type, hashAlgo, key) {
  return packet(TAG.ONE_PASS, concat(Uint8Array.of(3, type, hashAlgo, key.algo), key.keyid, Uint8Array.of(1)))
}

/** An inline signed message: one-pass signature, literal data, signature */
export async function signInline({ key, secret, data, name, text = false, hashAlgo = 10 }) {
  const type = text ? 0x01 : 0x00
  const covered = text ? canonicalText(decoder.decode(data)) : data
  const signature = await makeSignature({ key, secret, type, hashAlgo, covered })
  return concat(onePass(type, hashAlgo, key), literal(data, { name, format: text ? 't' : 'b' }), signature)
}

export async function signDetached({ key, secret, data, text = false, hashAlgo = 10 }) {
  const type = text ? 0x01 : 0x00
  return await makeSignature({ key, secret, type, hashAlgo, covered: text ? canonicalText(decoder.decode(data)) : data })
}

const HASH_ARMOR = { 2: 'SHA1', 8: 'SHA256', 9: 'SHA384', 10: 'SHA512', 11: 'SHA224' }

/** The signed text and its signature packet for a cleartext signature */
export async function signClear({ key, secret, text, hashAlgo = 10 }) {
  const signature = await makeSignature({ key, secret, type: 0x01, hashAlgo, covered: canonicalText(text, true) })
  // the text as it is, a final line break included, then the line break that ends it
  const escaped = text.replace(/\r\n/g, '\n').split('\n').map(line => (/^(-|From )/.test(line) ? `- ${line}` : line)).join('\n')
  return { header: `-----BEGIN PGP SIGNED MESSAGE-----\nHash: ${HASH_ARMOR[hashAlgo]}\n\n${escaped}\n`, signature }
}

async function inflate(algo, data) {
  if (algo === 0) return data
  const format = algo === 1 ? 'deflate-raw' : algo === 2 ? 'deflate' : undefined
  if (!format) throw Object.assign(new Error(`compression algorithm ${algo} (BZIP2) is not supported`), { unsupported: true })
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream(format))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * The parts of a message, with what is compressed opened: `{ literal: { data, format, name, date }, signatures,
 * onePass }`. A message that is encrypted comes back with `encrypted` set and the packets that say how.
 */
export async function openMessage(bytes) {
  const packets = readPackets(bytes)
  const result = { signatures: [], onePass: [], literal: undefined, encrypted: undefined }
  for (const { tag, body } of packets) {
    if (tag === TAG.COMPRESSED) {
      const inner = await openMessage(await inflate(body[0], body.subarray(1)))
      result.signatures.push(...inner.signatures)
      result.onePass.push(...inner.onePass)
      result.literal ??= inner.literal
      result.encrypted ??= inner.encrypted
    } else if (tag === TAG.LITERAL) {
      const r = new Reader(body)
      const format = String.fromCharCode(r.u8())
      const name = decoder.decode(r.take(r.u8()))
      const date = r.u32()
      result.literal = { format, name, date, data: r.rest() }
    } else if (tag === TAG.SIGNATURE) {
      try { result.signatures.push(parseSignature(body)) } catch (error) { result.signatures.push({ error }) }
    } else if (tag === TAG.ONE_PASS) result.onePass.push(body)
    else if (tag === TAG.PKESK || tag === TAG.SKESK || tag === TAG.SEIPD || tag === TAG.SED) {
      result.encrypted ??= { pkesk: [], skesk: [], data: undefined }
      if (tag === TAG.PKESK) result.encrypted.pkesk.push(body)
      else if (tag === TAG.SKESK) result.encrypted.skesk.push(body)
      else result.encrypted.data = { tag, body }
    }
  }
  return result
}

/** What a signature covers of a message's data, as its type says */
export const coveredData = (sig, data) => (sig.type === 0x01 ? canonicalText(decoder.decode(data)) : data)

/** Checks a signature against the keys `lookup` finds by key ID: `{ status: 'good' | 'bad' | 'nokey', key }` */
export async function checkSignature(sig, data, lookup, cleartext = false) {
  const found = sig.issuer ? lookup(sig.issuer) : undefined
  if (!found) return { status: 'nokey', sig }
  const covered = cleartext ? canonicalText(decoder.decode(data), true) : coveredData(sig, data)
  const ok = await verifySignature(sig, found.signer, signedData(sig.type, { data: covered })).catch(() => false)
  return { status: ok ? 'good' : 'bad', sig, ...found }
}

// Encryption -----------------------------------------------------------------------------------------------------------

const checksum16 = bytes => { let sum = 0; for (const byte of bytes) sum = (sum + byte) & 0xffff; return u16(sum) }

/** RFC 6637's KDF: the key that wraps the session key */
async function ecdhKek(shared, key) {
  const fields = key.fields
  const param = concat(Uint8Array.of(OID_CV25519.length), OID_CV25519, Uint8Array.of(ALGO.ECDH, 3, 1, fields.kdfHash, fields.kdfCipher), encoder.encode('Anonymous Sender    '), key.fingerprint)
  const digest = await hash(fields.kdfHash, concat(Uint8Array.of(0, 0, 0, 1), shared, param))
  return digest.subarray(0, CIPHERS[fields.kdfCipher])
}

/** A public-key encrypted session key packet for `key` */
async function pkesk(key, cipher, sessionKey) {
  const m = concat(Uint8Array.of(cipher), sessionKey, checksum16(sessionKey))
  let fields
  if (key.algo === ALGO.RSA || key.algo === ALGO.RSA_E) fields = mpi(fromBig(rsaEncrypt(key.fields, m)))
  else if (key.algo === ALGO.ECDH) {
    const ephemeral = await curveGenerate('X25519')
    const shared = await x25519(ephemeral.secret, key.fields.point, ephemeral.publicKey)
    const kek = await ecdhKek(shared, key)
    const padLength = 8 - (m.length % 8)
    const wrapped = aesWrap(kek, concat(m, new Uint8Array(padLength).fill(padLength)))
    fields = concat(mpi(concat(Uint8Array.of(0x40), ephemeral.publicKey)), Uint8Array.of(wrapped.length), wrapped)
  } else throw new Error(`cannot encrypt to a key of algorithm ${key.algo}`)
  return packet(TAG.PKESK, concat(Uint8Array.of(3), key.keyid, Uint8Array.of(key.algo), fields))
}

async function seipd(sessionKey, plaintext) {
  const prefix = random(16)
  const withPrefix = concat(prefix, prefix.subarray(14), plaintext, Uint8Array.of(0xd3, 0x14))
  const mdc = await hash(2, withPrefix)
  return packet(TAG.SEIPD, concat(Uint8Array.of(1), cfb(sessionKey, concat(withPrefix, mdc), false)))
}

/** An encrypted message: to each public key in `recipients` and/or with `passphrase`, of the packets in `plaintext` */
export async function encrypt({ recipients = [], passphrase, plaintext, cipher = 9 }) {
  const parts = []
  let sessionKey
  if (passphrase !== undefined && recipients.length === 0) {
    // the passphrase's S2K output is the session key itself
    const salt = random(8)
    const spec = { type: 3, hash: 8, salt, count: s2kCount(S2K_CODED_COUNT) }
    sessionKey = await s2k(spec, passphrase, CIPHERS[cipher])
    parts.push(packet(TAG.SKESK, concat(Uint8Array.of(4, cipher, 3, 8), salt, Uint8Array.of(S2K_CODED_COUNT))))
  } else {
    sessionKey = random(CIPHERS[cipher])
    for (const key of recipients) parts.push(await pkesk(key, cipher, sessionKey))
    if (passphrase !== undefined) {
      const salt = random(8)
      const spec = { type: 3, hash: 8, salt, count: s2kCount(S2K_CODED_COUNT) }
      const kek = await s2k(spec, passphrase, CIPHERS[cipher])
      const encryptedKey = cfb(kek, concat(Uint8Array.of(cipher), sessionKey), false)
      parts.push(packet(TAG.SKESK, concat(Uint8Array.of(4, cipher, 3, 8), salt, Uint8Array.of(S2K_CODED_COUNT), encryptedKey)))
    }
  }
  parts.push(await seipd(sessionKey, plaintext))
  return concat(...parts)
}

/** The session key in a PKESK, with the matching secret key */
export async function sessionFromPkesk(body, key, secret) {
  const r = new Reader(body)
  if (r.u8() !== 3) throw new Error('unsupported PKESK version')
  r.take(8)
  const algo = r.u8()
  let m
  if (algo === ALGO.RSA || algo === ALGO.RSA_E) m = rsaDecrypt({ ...key.fields, ...secret }, toBig(r.mpi()))
  else if (algo === ALGO.ECDH) {
    const ephemeral = r.mpi().subarray(1)
    const wrapped = r.take(r.u8())
    const shared = await x25519(secret.scalar, ephemeral, key.fields.point)
    const padded = aesUnwrap(await ecdhKek(shared, key), wrapped)
    m = padded.subarray(0, padded.length - padded[padded.length - 1])
  } else throw new Error(`public key algorithm ${algo} is not supported`)
  const cipher = m[0]
  const sessionKey = m.subarray(1, m.length - 2)
  if (!sameBytes(checksum16(sessionKey), m.subarray(m.length - 2))) throw new Error('public key decryption failed: wrong secret key')
  return { cipher, sessionKey }
}

/** The session key an SKESK gives with `passphrase` */
export async function sessionFromSkesk(body, passphrase) {
  const r = new Reader(body)
  if (r.u8() !== 4) throw new Error('unsupported SKESK version')
  const cipher = r.u8()
  const type = r.u8()
  const spec = { type, hash: r.u8() }
  if (type === 1 || type === 3) spec.salt = r.take(8)
  if (type === 3) spec.count = s2kCount(r.u8())
  const key = await s2k(spec, passphrase, CIPHERS[cipher])
  if (!r.left) return { cipher, sessionKey: key }
  const decrypted = cfb(key, r.rest(), true)
  return { cipher: decrypted[0], sessionKey: decrypted.subarray(1) }
}

/** The plaintext packets of an SEIPD packet; throws when the key is wrong or the message was changed */
export async function decryptData(data, { cipher, sessionKey }) {
  if (!CIPHERS[cipher] || CIPHERS[cipher] !== sessionKey.length) throw Object.assign(new Error(`cipher algorithm ${cipher} is not supported`), { unsupported: true })
  if (data.tag !== TAG.SEIPD) throw Object.assign(new Error('the message is not integrity protected; refusing to decrypt it'), { noMdc: true })
  if (data.body[0] !== 1) throw new Error('unsupported SEIPD version')
  const plain = cfb(sessionKey, data.body.subarray(1), true)
  if (plain[14] !== plain[16] || plain[15] !== plain[17]) throw Object.assign(new Error('decryption failed: Bad session key'), { badKey: true })
  const mdc = plain.subarray(plain.length - 20)
  if (plain[plain.length - 22] !== 0xd3 || plain[plain.length - 21] !== 0x14 || !sameBytes(await hash(2, plain.subarray(0, plain.length - 20)), mdc)) throw Object.assign(new Error('WARNING: message was manipulated!'), { manipulated: true })
  return plain.subarray(18, plain.length - 22)
}

export const cipherName = id => CIPHER_NAMES[id] ?? `cipher ${id}`
