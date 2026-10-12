/**
 * Password hashing and key derivation. Passwords are hashed with PBKDF2-SHA256 and a random per-user salt, stored as
 * passlib's `$pbkdf2-sha256$<rounds>$<salt>$<hash>` (adapted base64, so no `:` or `$`). Two older forms still verify
 * and are upgraded at the next login: `pbkdf2$<rounds>$<saltB64>$<hashB64>` and an unsalted SHA-256 hex digest. The
 * AES-GCM key that wraps a user's ECDSA private key is derived from the password with a distinct derivation.
 */

const PBKDF2_ITERATIONS = 210_000
const SALT_BYTES = 16
const HASH_BYTES = 32

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))
const fromBase64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), c => c.charCodeAt(0))

/** passlib's "adapted base64": standard base64 with `.` for `+` and no padding */
const toAb64 = (bytes: Uint8Array): string => toBase64(bytes).replace(/=+$/, '').replace(/\+/g, '.')
const fromAb64 = (text: string): Uint8Array => fromBase64(text.replace(/\./g, '+') + '='.repeat((4 - text.length % 4) % 4))

const HASH_TAG = '$pbkdf2-sha256$'

/** An unsalted SHA-256 hex digest with no `pbkdf2$` tag: the older, weaker hash format. */
export function isLegacyHash(stored: string): boolean {
  return /^[0-9a-f]{64}$/i.test(stored)
}

/** The first PBKDF2 format, `pbkdf2$<rounds>$<saltB64>$<hashB64>` */
export function isOldPbkdf2Hash(stored: string): boolean {
  return stored.startsWith('pbkdf2$')
}

/**
 * Whether a stored hash is a real password hash in an older form (or with fewer rounds), to be upgraded at the next
 * login
 */
export function needsRehash(stored: string): boolean {
  if (isLegacyHash(stored) || isOldPbkdf2Hash(stored)) return true
  if (!stored.startsWith(HASH_TAG)) return false // locked, disabled, empty: nothing to upgrade
  return Number(stored.split('$')[2]) < PBKDF2_ITERATIONS
}

async function pbkdf2Bits(password: string, salt: Uint8Array, iterations: number, bits: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    keyMaterial,
    bits
  )
  return new Uint8Array(derived)
}

/** Hash a password for storage in /etc/shadow. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const hash = await pbkdf2Bits(password.trim(), salt, PBKDF2_ITERATIONS, HASH_BYTES * 8)
  return `${HASH_TAG}${PBKDF2_ITERATIONS}$${toAb64(salt)}$${toAb64(hash)}`
}

/** The older, unsalted SHA-256 hash, kept only to verify and upgrade existing shadow entries. */
async function hashPasswordLegacy(password: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password.trim()))
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Verify a password against a stored hash: the current format, the first PBKDF2 format, or unsalted hex. A locked,
 * disabled or empty hash never verifies.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (isLegacyHash(stored)) return (await hashPasswordLegacy(password)) === stored

  const parts = stored.split('$')
  let iterationsStr: string | undefined
  let expected: Uint8Array
  let salt: Uint8Array
  try {
    if (parts.length === 5 && parts[0] === '' && parts[1] === 'pbkdf2-sha256') {
      iterationsStr = parts[2]
      salt = fromAb64(parts[3]!)
      expected = fromAb64(parts[4]!)
    } else if (parts.length === 4 && parts[0] === 'pbkdf2') {
      iterationsStr = parts[1]
      salt = fromBase64(parts[2]!)
      expected = fromBase64(parts[3]!)
    } else return false
  } catch {
    return false // not valid base64
  }
  const iterations = Number(iterationsStr)
  if (!Number.isFinite(iterations) || iterations <= 0 || expected.length === 0) return false

  const actual = await pbkdf2Bits(password.trim(), salt, iterations, expected.length * 8)
  if (actual.length !== expected.length) return false

  // constant-time compare
  let diff = 0
  for (let i = 0; i < actual.length; i++) diff |= actual[i]! ^ expected[i]!
  return diff === 0
}

/**
 * Derive an AES-256-GCM key from a password for wrapping a user's private key. Uses its own
 * salt (distinct from the password-hash salt) and a lower iteration count is not used here -
 * every derivation, hash or key, runs the full PBKDF2_ITERATIONS.
 */
export async function deriveAesKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const bits = await pbkdf2Bits(password.trim(), salt, PBKDF2_ITERATIONS, 256)
  return crypto.subtle.importKey('raw', bits as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export function generateKeySalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SALT_BYTES))
}

export { toBase64, fromBase64, toAb64, fromAb64 }
