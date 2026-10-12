/**
 * A user's ECDSA P-384 key pair, kept as `ssh` would: `~/.ssh/id_ecdsa` (private key encrypted with a key derived
 * from the login password, mode 0600) and `~/.ssh/id_ecdsa.pub` (`ecdsa-p384 <public JWK, base64> <name>`, mode
 * 0644). Made the first time something needs it; not used for logging in.
 */

import { deriveAesKey, fromBase64, generateKeySalt, toBase64 } from './credentials.ts'

export const PRIVATE_KEY_FILE = '.ssh/id_ecdsa'
export const PUBLIC_KEY_FILE = '.ssh/id_ecdsa.pub'
const ALGORITHM = 'ecdsa-p384'

/** The encrypted private key as stored: AES-256-GCM, its key derived from the password (PBKDF2-SHA256) with `salt` */
export interface WrappedKey {
  v: 1
  alg: 'ECDSA-P-384'
  kdf: 'pbkdf2-sha256'
  salt: string
  iv: string
  data: string
}

/** Encrypts a private key under a password */
export async function wrapKey(privateKey: JsonWebKey, password: string): Promise<WrappedKey> {
  const salt = generateKeySalt()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const aesKey = await deriveAesKey(password, salt)
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, new TextEncoder().encode(JSON.stringify(privateKey)))
  return { v: 1, alg: 'ECDSA-P-384', kdf: 'pbkdf2-sha256', salt: toBase64(salt), iv: toBase64(iv), data: toBase64(new Uint8Array(data)) }
}

/** Decrypts a private key, or `null` when the password is wrong or the key is not one this reads */
export async function unwrapKey(wrapped: WrappedKey, password: string): Promise<JsonWebKey | null> {
  try {
    const aesKey = await deriveAesKey(password, fromBase64(wrapped.salt))
    const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(wrapped.iv) as BufferSource }, aesKey, fromBase64(wrapped.data) as BufferSource)
    return JSON.parse(new TextDecoder().decode(data)) as JsonWebKey
  } catch {
    return null
  }
}

/** Reads the file's text as a wrapped key, or `null` if it is not one */
export function parseWrappedKey(text: string): WrappedKey | null {
  try {
    const value = JSON.parse(text) as Partial<WrappedKey>
    if (value.v !== 1 || value.alg !== 'ECDSA-P-384' || typeof value.salt !== 'string' || typeof value.iv !== 'string' || typeof value.data !== 'string') return null
    return value as WrappedKey
  } catch {
    return null
  }
}

/** A new key pair, the private half already encrypted under `password` */
export async function generateKeyPair(password: string): Promise<{ publicKey: JsonWebKey, wrapped: WrappedKey }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, true, ['sign', 'verify'])
  const publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const privateKey = await crypto.subtle.exportKey('jwk', pair.privateKey)
  return { publicKey, wrapped: await wrapKey(privateKey, password) }
}

/** The text of `id_ecdsa.pub` */
export function publicKeyLine(publicKey: JsonWebKey, comment: string): string {
  return `${ALGORITHM} ${btoa(JSON.stringify(publicKey))} ${comment}\n`
}

/** The public key in an `id_ecdsa.pub` (or an `authorized_keys` line), or `null` */
export function parsePublicKeyLine(text: string): JsonWebKey | null {
  const [algorithm, body] = text.trim().split(/\s+/)
  if (algorithm !== ALGORITHM || !body) return null
  try { return JSON.parse(atob(body)) as JsonWebKey } catch { return null }
}

export const AUTHORIZED_KEYS_FILE = '.ssh/authorized_keys'

/**
 * The keys in an `authorized_keys` file: one per line, the same shape as `id_ecdsa.pub`; blank lines, comments and
 * lines this does not read are skipped
 */
export function parseAuthorizedKeys(text: string): JsonWebKey[] {
  const keys: JsonWebKey[] = []
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const key = parsePublicKeyLine(line)
    if (key) keys.push(key)
  }
  return keys
}
