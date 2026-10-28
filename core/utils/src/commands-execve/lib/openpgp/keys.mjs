/**
 * OpenPGP v4 keys: key packets (RSA, EdDSA on Ed25519, ECDH on Curve25519), fingerprints, secret keys and their
 * protection (S2K usage 254 and 255; 0 is unprotected), signatures and their subpackets, the certifications that bind
 * user IDs and subkeys, generating keys, and transferable keys read from and written to a keyring.
 */

import { CIPHERS, cfb, concat, curveGenerate, ed25519Sign, ed25519Verify, fromBig, hash, random, rsaGenerate, rsaSign, rsaVerify, s2k, s2kCount, S2K_CODED_COUNT, toBig } from './crypto.mjs'
import { Reader, TAG, hex, mpi, packet, readPackets, u16, u32 } from './packets.mjs'

export const ALGO = { RSA: 1, RSA_E: 2, RSA_S: 3, ECDH: 18, EDDSA: 22 }
export const OID_ED25519 = Uint8Array.of(0x2b, 0x06, 0x01, 0x04, 0x01, 0xda, 0x47, 0x0f, 0x01)
export const OID_CV25519 = Uint8Array.of(0x2b, 0x06, 0x01, 0x04, 0x01, 0x97, 0x55, 0x01, 0x05, 0x01)
const sameBytes = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i])
const pad32 = bytes => bytes.length >= 32 ? bytes.slice(bytes.length - 32) : concat(new Uint8Array(32 - bytes.length), bytes)

/** A public key packet's body, parsed: `{ version, created, algo, fields, body, fingerprint, keyid }` */
export async function parseKey(body) {
  const r = new Reader(body)
  const version = r.u8()
  if (version !== 4) throw Object.assign(new Error(`key packet version ${version} is not supported`), { unsupported: true })
  const created = r.u32()
  const algo = r.u8()
  const fields = {}
  if (algo === ALGO.RSA || algo === ALGO.RSA_E || algo === ALGO.RSA_S) { fields.n = toBig(r.mpi()); fields.e = toBig(r.mpi()); fields.bits = fields.n.toString(2).length }
  else if (algo === ALGO.EDDSA || algo === ALGO.ECDH) {
    const oid = r.take(r.u8())
    fields.oid = oid
    const point = r.mpi()
    if (point[0] !== 0x40 || point.length !== 33) throw Object.assign(new Error('unsupported curve point'), { unsupported: true })
    fields.point = point.slice(1)
    if (algo === ALGO.ECDH) {
      const kdf = r.take(r.u8())
      fields.kdfHash = kdf[1]; fields.kdfCipher = kdf[2]
      if (!sameBytes(oid, OID_CV25519)) throw Object.assign(new Error('unsupported ECDH curve'), { unsupported: true })
    } else if (!sameBytes(oid, OID_ED25519)) throw Object.assign(new Error('unsupported EdDSA curve'), { unsupported: true })
  } else throw Object.assign(new Error(`public key algorithm ${algo} is not supported`), { unsupported: true })
  const publicLength = r.at
  const publicBody = body.subarray(0, publicLength)
  const fingerprint = await hash(2, concat(Uint8Array.of(0x99), u16(publicBody.length), publicBody))
  return { version, created, algo, fields, body: publicBody, fingerprint, keyid: fingerprint.slice(12), secretBody: body.subarray(publicLength) }
}

/** The name gpg gives a key's algorithm: rsa3072, ed25519, cv25519 */
export function algoName(key) {
  if (key.algo === ALGO.EDDSA) return 'ed25519'
  if (key.algo === ALGO.ECDH) return 'cv25519'
  return `rsa${key.fields.bits}`
}

/** What a key's packet body is, from its parts */
function keyBody(created, algo, fields) {
  const parts = [Uint8Array.of(4), u32(created), Uint8Array.of(algo)]
  if (algo === ALGO.RSA) parts.push(mpi(fromBig(fields.n)), mpi(fromBig(fields.e)))
  else if (algo === ALGO.EDDSA) parts.push(Uint8Array.of(OID_ED25519.length), OID_ED25519, mpi(concat(Uint8Array.of(0x40), fields.point)))
  else parts.push(Uint8Array.of(OID_CV25519.length), OID_CV25519, mpi(concat(Uint8Array.of(0x40), fields.point)), Uint8Array.of(3, 1, 8, 9))
  return concat(...parts)
}

// Secret keys ----------------------------------------------------------------------------------------------------------

/** The secret MPIs of a key, as bytes */
function secretMpis(key, secret) {
  if (key.algo === ALGO.RSA || key.algo === ALGO.RSA_S || key.algo === ALGO.RSA_E) return concat(mpi(fromBig(secret.d)), mpi(fromBig(secret.p)), mpi(fromBig(secret.q)), mpi(fromBig(secret.u)))
  // cv25519's secret is the native little-endian scalar read as a big-endian number
  if (key.algo === ALGO.ECDH) return mpi(Uint8Array.from(secret.scalar).reverse())
  return mpi(secret.seed)
}

function readSecretMpis(key, bytes) {
  const r = new Reader(bytes)
  if (key.algo === ALGO.EDDSA) return { seed: pad32(r.mpi()) }
  if (key.algo === ALGO.ECDH) return { scalar: pad32(r.mpi()).reverse() }
  return { d: toBig(r.mpi()), p: toBig(r.mpi()), q: toBig(r.mpi()), u: toBig(r.mpi()) }
}

const checksum16 = bytes => { let sum = 0; for (const byte of bytes) sum = (sum + byte) & 0xffff; return u16(sum) }

/** How a secret key is kept: `{ usage, cipher, s2k, iv, data }`, the data still encrypted */
export function parseSecret(key) {
  const r = new Reader(key.secretBody)
  const usage = r.u8()
  if (usage === 0) return { usage, data: r.rest() }
  if (usage !== 254 && usage !== 255) throw Object.assign(new Error('secret key protected in a way that is not supported'), { unsupported: true })
  const cipher = r.u8()
  const type = r.u8()
  const spec = { type }
  if (type === 101) return { usage, stub: true }
  spec.hash = r.u8()
  if (type === 1 || type === 3) spec.salt = r.take(8)
  if (type === 3) spec.count = s2kCount(r.u8())
  if (!CIPHERS[cipher]) throw Object.assign(new Error(`secret key cipher ${cipher} is not supported`), { unsupported: true })
  return { usage, cipher, s2k: spec, iv: r.take(16), data: r.rest() }
}

/** The secret parts of a key, with its passphrase when it has one; throws `badPassphrase` when that is wrong */
export async function unlock(key, passphrase) {
  const kept = parseSecret(key)
  if (kept.stub) throw Object.assign(new Error('the secret key is not available (a stub)'), { stub: true })
  if (kept.usage === 0) return readSecretMpis(key, kept.data.subarray(0, kept.data.length - 2))
  if (passphrase === undefined) throw Object.assign(new Error('a passphrase is needed'), { needPassphrase: true })
  const sessionKey = await s2k(kept.s2k, passphrase, CIPHERS[kept.cipher])
  const plain = cfb(sessionKey, kept.data, true, kept.iv)
  if (kept.usage === 254) {
    const body = plain.subarray(0, plain.length - 20)
    if (!sameBytes(await hash(2, body), plain.subarray(plain.length - 20))) throw Object.assign(new Error('Bad passphrase'), { badPassphrase: true })
    return readSecretMpis(key, body)
  }
  const body = plain.subarray(0, plain.length - 2)
  if (!sameBytes(checksum16(body), plain.subarray(plain.length - 2))) throw Object.assign(new Error('Bad passphrase'), { badPassphrase: true })
  return readSecretMpis(key, body)
}

export const isProtected = key => parseSecret(key).usage !== 0

/** A secret key packet's body: the public part, then the secret, protected with AES-256 and iterated SHA-256 when there is a passphrase */
export async function secretBody(key, secret, passphrase) {
  const mpis = secretMpis(key, secret)
  if (!passphrase) return concat(key.body, Uint8Array.of(0), mpis, checksum16(mpis))
  const salt = random(8)
  const coded = S2K_CODED_COUNT
  const spec = { type: 3, hash: 8, salt, count: s2kCount(coded) }
  const sessionKey = await s2k(spec, passphrase, 32)
  const iv = random(16)
  const data = cfb(sessionKey, concat(mpis, await hash(2, mpis)), false, iv)
  return concat(key.body, Uint8Array.of(254, 9, 3, 8), salt, Uint8Array.of(coded), iv, data)
}

// Signatures -----------------------------------------------------------------------------------------------------------

export const SUB = { CREATED: 2, SIG_EXPIRES: 3, EXPORTABLE: 4, REVOCABLE: 7, KEY_EXPIRES: 9, PREF_CIPHER: 11, ISSUER: 16, PREF_HASH: 21, PREF_COMPRESS: 22, SERVER_PREFS: 23, PRIMARY_UID: 25, KEY_FLAGS: 27, FEATURES: 30, EMBEDDED: 32, ISSUER_FPR: 33 }

function subpacketLength(n) {
  return n < 192 ? Uint8Array.of(n) : n < 8384 ? Uint8Array.of(((n - 192) >> 8) + 192, (n - 192) & 0xff) : concat(Uint8Array.of(255), u32(n))
}

export const subpacket = (type, data) => concat(subpacketLength(data.length + 1), Uint8Array.of(type), data)

function readSubpackets(bytes) {
  const list = []
  const r = new Reader(bytes)
  while (r.left) {
    const first = r.u8()
    let length
    if (first < 192) length = first
    else if (first < 255) length = ((first - 192) << 8) + r.u8() + 192
    else length = r.u32()
    const data = r.take(length)
    list.push({ type: data[0] & 0x7f, critical: !!(data[0] & 0x80), data: data.subarray(1) })
  }
  return list
}

/** A v4 signature packet's body, parsed */
export function parseSignature(body) {
  const r = new Reader(body)
  const version = r.u8()
  if (version !== 4) throw Object.assign(new Error(`signature packet version ${version} is not supported`), { unsupported: true })
  const type = r.u8(), algo = r.u8(), hashAlgo = r.u8()
  const hashedStart = r.at - 4
  const hashed = r.take(r.u16())
  const hashedEnd = r.at
  const unhashed = r.take(r.u16())
  const left16 = r.take(2)
  const values = []
  while (r.left) values.push(r.mpi())
  const sub = [...readSubpackets(hashed).map(s => ({ ...s, hashed: true })), ...readSubpackets(unhashed).map(s => ({ ...s, hashed: false }))]
  const find = t => sub.find(s => s.type === t)?.data
  const created = find(SUB.CREATED)
  const issuerFpr = find(SUB.ISSUER_FPR)
  const keyExpires = find(SUB.KEY_EXPIRES)
  const sigExpires = find(SUB.SIG_EXPIRES)
  const flags = find(SUB.KEY_FLAGS)
  return {
    version, type, algo, hashAlgo, left16, values, sub,
    trailer: body.subarray(hashedStart, hashedEnd),
    created: created ? new Reader(created).u32() : 0,
    issuer: find(SUB.ISSUER) ?? (issuerFpr ? issuerFpr.subarray(issuerFpr.length - 8) : undefined),
    issuerFpr: issuerFpr?.subarray(1),
    keyExpires: keyExpires ? new Reader(keyExpires).u32() : undefined,
    sigExpires: sigExpires ? new Reader(sigExpires).u32() : undefined,
    flags: flags ? flags[0] : undefined,
    primaryUid: find(SUB.PRIMARY_UID)?.[0] === 1,
    embedded: find(SUB.EMBEDDED),
    body
  }
}

const keyFrame = key => concat(Uint8Array.of(0x99), u16(key.body.length), key.body)
const uidFrame = uid => { const bytes = new TextEncoder().encode(uid); return concat(Uint8Array.of(0xb4), u32(bytes.length), bytes) }

/** What a signature of `type` covers, before its trailer */
export function signedData(type, { data, key, uid, subkey }) {
  if (type === 0x00 || type === 0x01) return data
  if (type >= 0x10 && type <= 0x13 || type === 0x30) return concat(keyFrame(key), uidFrame(uid))
  if (type === 0x18 || type === 0x19 || type === 0x28) return concat(keyFrame(key), keyFrame(subkey))
  if (type === 0x1f || type === 0x20) return keyFrame(key)
  return data ?? new Uint8Array()
}

async function digestOf(sig, covered) {
  const trailer = sig.trailer
  return await hash(sig.hashAlgo, concat(covered, trailer, Uint8Array.of(4, 0xff), u32(trailer.length)))
}

/** Whether `sig` is a good signature by `key` over `covered` */
export async function verifySignature(sig, key, covered) {
  const digest = await digestOf(sig, covered)
  if (digest[0] !== sig.left16[0] || digest[1] !== sig.left16[1]) return false
  if (key.algo === ALGO.EDDSA) {
    if (sig.values.length !== 2) return false
    return await ed25519Verify(key.fields.point, digest, concat(pad32(sig.values[0]), pad32(sig.values[1])))
  }
  if (key.algo === ALGO.RSA || key.algo === ALGO.RSA_S) return rsaVerify(key.fields, sig.hashAlgo, digest, toBig(sig.values[0]))
  return false
}

/** A signature packet by `key` (with its `secret`), of `type`, with these hashed subpackets */
export async function makeSignature({ key, secret, type, hashAlgo = 10, created = Math.floor(Date.now() / 1000), hashed = [], covered }) {
  const hashedBytes = concat(subpacket(SUB.CREATED, u32(created)), subpacket(SUB.ISSUER_FPR, concat(Uint8Array.of(4), key.fingerprint)), ...hashed)
  const trailer = concat(Uint8Array.of(4, type, key.algo, hashAlgo), u16(hashedBytes.length), hashedBytes)
  const digest = await hash(hashAlgo, concat(covered, trailer, Uint8Array.of(4, 0xff), u32(trailer.length)))
  let values
  if (key.algo === ALGO.EDDSA) {
    const signature = await ed25519Sign(key.fields.point, secret.seed, digest)
    values = [mpi(signature.subarray(0, 32)), mpi(signature.subarray(32))]
  } else values = [mpi(fromBig(rsaSign({ ...key.fields, ...secret }, hashAlgo, digest)))]
  const unhashed = subpacket(SUB.ISSUER, key.keyid)
  return packet(TAG.SIGNATURE, concat(trailer, u16(unhashed.length), unhashed, digest.subarray(0, 2), ...values))
}

// Transferable keys ----------------------------------------------------------------------------------------------------

/**
 * The keys in a stream of packets: `[{ primary, secret, uids: [{ uid, sigs }], subkeys: [{ key, secret, sigs }], sigs, packets }]`.
 * A key or subkey whose algorithm is not supported is kept as packets but cannot be used. Signatures are not checked here.
 */
export async function readKeys(bytes) {
  const keys = []
  let current
  let lastHolder
  for (const { tag, body } of readPackets(bytes)) {
    if (tag === TAG.PUBLIC_KEY || tag === TAG.SECRET_KEY) {
      let primary
      try { primary = await parseKey(body) } catch (error) { current = { unsupported: error.message, packets: [] }; keys.push(current); lastHolder = undefined; continue }
      current = { primary, secret: tag === TAG.SECRET_KEY, uids: [], subkeys: [], sigs: [], packets: [] }
      keys.push(current)
      lastHolder = current
    } else if (!current) continue
    else if (tag === TAG.USER_ID) { lastHolder = { uid: new TextDecoder().decode(body), sigs: [] }; current.uids?.push(lastHolder) }
    else if (tag === TAG.USER_ATTRIBUTE) lastHolder = { attribute: true, sigs: [] }
    else if (tag === TAG.PUBLIC_SUBKEY || tag === TAG.SECRET_SUBKEY) {
      try { lastHolder = { key: await parseKey(body), secret: tag === TAG.SECRET_SUBKEY, sigs: [] }; current.subkeys?.push(lastHolder) } catch { lastHolder = { unsupported: true, sigs: [] } }
    } else if (tag === TAG.SIGNATURE && lastHolder) {
      try { lastHolder.sigs.push(parseSignature(body)) } catch { /* a signature we cannot read */ }
    }
    current.packets.push({ tag, body })
  }
  return keys.filter(key => key.primary)
}

/** A transferable key as packets: public (`secret` false) or secret */
export function writeKey(key, secret) {
  const out = []
  for (const { tag, body } of key.packets) {
    if (!secret && (tag === TAG.SECRET_KEY || tag === TAG.SECRET_SUBKEY)) {
      const publicTag = tag === TAG.SECRET_KEY ? TAG.PUBLIC_KEY : TAG.PUBLIC_SUBKEY
      out.push(packet(publicTag, body.subarray(0, publicLength(body))))
    } else if (tag !== TAG.TRUST) out.push(packet(tag, body))
  }
  return concat(...out)
}

/** How long the public part of a key packet's body is */
function publicLength(body) {
  const r = new Reader(body)
  r.u8(); r.u32()
  const algo = r.u8()
  if (algo === ALGO.RSA || algo === ALGO.RSA_E || algo === ALGO.RSA_S) { r.mpi(); r.mpi() }
  else { r.take(r.u8()); r.mpi(); if (algo === ALGO.ECDH) r.take(r.u8()) }
  return r.at
}

/** Checks the self-signatures: which user IDs and subkeys are bound, and when the key and each subkey expire */
export async function validate(key, now = Math.floor(Date.now() / 1000)) {
  const result = { uids: [], subkeys: [], expires: undefined, revoked: false, flags: undefined }
  for (const sig of key.sigs ?? []) {
    if (sig.type === 0x20 && await verifySignature(sig, key.primary, signedData(0x20, { key: key.primary })).catch(() => false)) result.revoked = true
  }
  for (const holder of key.uids) {
    let best
    for (const sig of holder.sigs) {
      if (sig.type < 0x10 || sig.type > 0x13 || !sameBytes(sig.issuer ?? new Uint8Array(), key.primary.keyid)) continue
      if (!await verifySignature(sig, key.primary, signedData(sig.type, { key: key.primary, uid: holder.uid })).catch(() => false)) continue
      if (!best || sig.created > best.created) best = sig
    }
    const revoked = holder.sigs.some(sig => sig.type === 0x30)
    if (best) {
      result.uids.push({ uid: holder.uid, sig: best, revoked })
      if (best.keyExpires !== undefined && (result.expires === undefined || best.primaryUid)) result.expires = best.keyExpires ? key.primary.created + best.keyExpires : undefined
      if (best.flags !== undefined && (result.flags === undefined || best.primaryUid)) result.flags = best.flags
    }
  }
  for (const holder of key.subkeys) {
    let best
    for (const sig of holder.sigs) {
      if (sig.type !== 0x18) continue
      if (!await verifySignature(sig, key.primary, signedData(0x18, { key: key.primary, subkey: holder.key })).catch(() => false)) continue
      if (!best || sig.created > best.created) best = sig
    }
    if (best) {
      result.subkeys.push({
        holder, key: holder.key, sig: best, flags: best.flags ?? 0,
        expires: best.keyExpires ? holder.key.created + best.keyExpires : undefined,
        revoked: holder.sigs.some(sig => sig.type === 0x28)
      })
    }
  }
  result.expired = result.expires !== undefined && result.expires <= now
  return result
}

/** `[SC]`-style capability letters of key flags */
export function usageLetters(flags, primary) {
  if (flags === undefined) return primary ? 'SC' : ''
  return `${flags & 0x02 ? 'S' : ''}${flags & 0x01 ? 'C' : ''}${flags & 0x0c ? 'E' : ''}${flags & 0x20 ? 'A' : ''}`
}

/**
 * A new key: a primary for signing and certifying, a subkey for encrypting, a user ID, and their self-signatures.
 * `algo` is `ed25519` (with a cv25519 subkey) or `rsa2048`, `rsa3072`, `rsa4096`. Returns a transferable secret key.
 */
export async function generateKey({ uid, algo = 'ed25519', expireSeconds, passphrase, created = Math.floor(Date.now() / 1000) }) {
  let primary, primarySecret, sub, subSecret
  if (algo === 'ed25519' || algo === 'default' || algo === 'future-default') {
    const sign = await curveGenerate('Ed25519')
    const enc = await curveGenerate('X25519')
    primary = await parseKey(keyBody(created, ALGO.EDDSA, { point: sign.publicKey }))
    primarySecret = { seed: sign.secret }
    sub = await parseKey(keyBody(created, ALGO.ECDH, { point: enc.publicKey }))
    subSecret = { scalar: enc.secret }
  } else {
    const bits = Number(/^rsa(\d+)?$/.exec(algo)?.[1] ?? 3072)
    if (![2048, 3072, 4096].includes(bits)) throw new Error(`invalid algorithm '${algo}'`)
    const a = await rsaGenerate(bits), b = await rsaGenerate(bits)
    primary = await parseKey(keyBody(created, ALGO.RSA, a))
    primarySecret = a
    sub = await parseKey(keyBody(created, ALGO.RSA, b))
    subSecret = b
  }
  const expiry = expireSeconds ? [subpacket(SUB.KEY_EXPIRES, u32(expireSeconds))] : []
  const certification = await makeSignature({
    key: primary, secret: primarySecret, type: 0x13, created,
    covered: signedData(0x13, { key: primary, uid }),
    hashed: [subpacket(SUB.KEY_FLAGS, Uint8Array.of(0x03)), ...expiry, subpacket(SUB.PREF_CIPHER, Uint8Array.of(9, 8, 7)), subpacket(SUB.PREF_HASH, Uint8Array.of(10, 9, 8, 11, 2)),
      subpacket(SUB.PREF_COMPRESS, Uint8Array.of(2, 1, 0)), subpacket(SUB.FEATURES, Uint8Array.of(1)), subpacket(SUB.SERVER_PREFS, Uint8Array.of(0x80))]
  })
  const binding = await makeSignature({
    key: primary, secret: primarySecret, type: 0x18, created,
    covered: signedData(0x18, { key: primary, subkey: sub }),
    hashed: [subpacket(SUB.KEY_FLAGS, Uint8Array.of(0x0c)), ...expiry]
  })
  const bytes = concat(
    packet(TAG.SECRET_KEY, await secretBody(primary, primarySecret, passphrase)),
    packet(TAG.USER_ID, new TextEncoder().encode(uid)),
    certification,
    packet(TAG.SECRET_SUBKEY, await secretBody(sub, subSecret, passphrase)),
    binding
  )
  return (await readKeys(bytes))[0]
}

export const fingerprintText = key => hex(key.fingerprint)
export const keyidText = key => hex(key.keyid)

/** Whether a key matches what a user named it by: fingerprint, long or short key ID (with or without 0x), or part of a user ID */
export function matches(key, spec) {
  const text = spec.replace(/^0x/i, '').replace(/\s+/g, '').toUpperCase()
  const ids = [key.primary, ...key.subkeys.map(holder => holder.key)]
  if (/^[0-9A-F]{8,40}!?$/.test(text)) {
    const want = text.replace(/!$/, '')
    if (ids.some(k => hex(k.fingerprint) === want || hex(k.fingerprint).endsWith(want))) return true
  }
  const needle = spec.replace(/^[<=@]/, '').replace(/>$/, '').toLowerCase()
  if (spec.startsWith('=')) return key.uids.some(holder => holder.uid === spec.slice(1))
  return key.uids.some(holder => holder.uid.toLowerCase().includes(needle))
}
