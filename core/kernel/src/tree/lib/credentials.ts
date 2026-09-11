/**
 * Password hashing and key-derivation helpers.
 *
 * Passwords are hashed with PBKDF2-SHA256 using a random per-user salt, and the AES-GCM key that
 * wraps a user's ECDSA private key is derived from the password with the same KDF (a distinct
 * derivation, so a hash leak alone does not hand over the wrapping key). Both are tagged with a
 * `pbkdf2$<iterations>$<saltB64>$<hashB64>` format so legacy unsalted SHA-256 hex digests --
 * written by ecmaOS before this module existed -- remain recognizable and migratable in place.
 */

const PBKDF2_ITERATIONS = 210_000
const SALT_BYTES = 16
const HASH_BYTES = 32

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))
const fromBase64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), c => c.charCodeAt(0))

/** A legacy hash is a 64-character hex SHA-256 digest with no `pbkdf2$` tag. */
export function isLegacyHash(stored: string): boolean {
  return /^[0-9a-f]{64}$/i.test(stored)
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
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`
}

/** Legacy hashing, kept only so old shadow entries can be verified before migration. */
async function hashPasswordLegacy(password: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password.trim()))
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Verify a password against a stored hash, whether PBKDF2-tagged or legacy unsalted hex. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (isLegacyHash(stored)) return (await hashPasswordLegacy(password)) === stored

  const parts = stored.split('$')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false
  const [, iterationsStr, saltB64, hashB64] = parts
  const iterations = Number(iterationsStr)
  if (!Number.isFinite(iterations) || iterations <= 0) return false

  const salt = fromBase64(saltB64!)
  const expected = fromBase64(hashB64!)
  const actual = await pbkdf2Bits(password.trim(), salt, iterations, expected.length * 8)
  if (actual.length !== expected.length) return false

  // constant-time compare
  let diff = 0
  for (let i = 0; i < actual.length; i++) diff |= actual[i]! ^ expected[i]!
  return diff === 0
}

/**
 * Derive an AES-256-GCM key from a password for wrapping a user's private key. Uses its own
 * salt (distinct from the password-hash salt) and a lower iteration count is not used here --
 * every derivation, hash or key, runs the full PBKDF2_ITERATIONS.
 */
export async function deriveAesKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const bits = await pbkdf2Bits(password.trim(), salt, PBKDF2_ITERATIONS, 256)
  return crypto.subtle.importKey('raw', bits as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export function generateKeySalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SALT_BYTES))
}

export { toBase64, fromBase64 }
