import { PeerError } from './errors.ts'

/** The only key type on the wire: an ECDSA P-384 public key, as a JWK with nothing but its parts */
export interface PublicKey { kty: 'EC', crv: 'P-384', x: string, y: string }

/** A key pair as kept on disk (the host key) */
export interface KeyPair { publicKey: PublicKey, privateKey: JsonWebKey }

const encoder = new TextEncoder()
const Algorithm = { name: 'ECDSA', namedCurve: 'P-384' } as const
const Signature = { name: 'ECDSA', hash: 'SHA-384' } as const

/** Strips a JWK down to a public key this protocol accepts, or `null` if it is not one */
export function publicKeyOf(value: unknown): PublicKey | null {
  if (!value || typeof value !== 'object') return null
  const { kty, crv, x, y } = value as Record<string, unknown>
  if (kty !== 'EC' || crv !== 'P-384' || typeof x !== 'string' || typeof y !== 'string') return null
  // P-384 coordinates are 48 bytes, 64 base64url characters
  if (!/^[A-Za-z0-9_-]{64}$/.test(x) || !/^[A-Za-z0-9_-]{64}$/.test(y)) return null
  return { kty, crv, x, y }
}

export function sameKey(a: PublicKey, b: PublicKey) { return a.x === b.x && a.y === b.y }

/** `SHA256:` and the unpadded base64 of the SHA-256 of the key's canonical text, as `ssh-keygen -l` shows them */
export async function fingerprint(key: PublicKey): Promise<string> {
  const canonical = JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x, y: key.y })
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(canonical)))
  let text = ''
  for (const byte of digest) text += String.fromCharCode(byte)
  return `SHA256:${btoa(text).replace(/=+$/, '')}`
}

export async function generateKeyPair(): Promise<KeyPair> {
  const pair = await crypto.subtle.generateKey(Algorithm, true, ['sign', 'verify'])
  const publicKey = publicKeyOf(await crypto.subtle.exportKey('jwk', pair.publicKey))!
  return { publicKey, privateKey: await crypto.subtle.exportKey('jwk', pair.privateKey) }
}

export async function sign(privateKey: JsonWebKey, data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('jwk', privateKey, Algorithm, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign(Signature, key, data as BufferSource))
}

/** Never throws: a key or signature that does not parse simply does not verify */
export async function verify(publicKey: PublicKey, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('jwk', { ...publicKey, ext: true }, Algorithm, false, ['verify'])
    return await crypto.subtle.verify(Signature, key, signature as BufferSource, data as BufferSource)
  } catch {
    return false
  }
}

/** What each side signs. Everything that identifies this exchange goes in, so a signature is good for nothing else. */
export function transcript(label: 'host' | 'auth' | 'pair', clientNonce: Uint8Array, serverNonce: Uint8Array, extra = ''): Uint8Array {
  const head = encoder.encode(`ecmaos-${label}-v1\0`)
  const tail = encoder.encode(`\0${extra}`)
  const out = new Uint8Array(head.length + clientNonce.length + serverNonce.length + tail.length)
  out.set(head); out.set(clientNonce, head.length); out.set(serverNonce, head.length + clientNonce.length); out.set(tail, head.length + clientNonce.length + serverNonce.length)
  return out
}

export function randomNonce() { return crypto.getRandomValues(new Uint8Array(32)) }

export function requireKey(value: unknown): PublicKey {
  const key = publicKeyOf(value)
  if (!key) throw new PeerError('protocol', 'not a P-384 public key')
  return key
}
