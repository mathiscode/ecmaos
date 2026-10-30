/**
 * What `install` checks before it trusts a package: the tarball against the registry's `dist.integrity`, the
 * registry's signature over that integrity, and whether the package's install scripts may run.
 *
 * npm signs `NAME@VERSION:INTEGRITY` with ECDSA P-256 and lists its public keys at `/-/npm/v1/keys`; that endpoint
 * sends no CORS headers, so a browser cannot fetch it and npm's keys ship here. Another registry's keys go in
 * `/etc/install/keys.json`, as `{ "REGISTRY URL": [{ "keyid", "key" }] }` (`key` is the base64 SPKI, as npm gives it).
 * A registry with no keys known is not checked; one with keys must sign every version.
 */

import { exists, readJson, readText } from './io.mjs'

/** npm's registry keys, as `https://registry.npmjs.org/-/npm/v1/keys` gave them on 2026-10-29 */
const NPM_KEYS = [
  { keyid: 'SHA256:jl3bwswu80PjjokCgh0o2w5c2U4LhQAE57gj9cz1kzA', expires: '2025-01-29T00:00:00.000Z', key: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE1Olb3zMAFFxXKHiIkQO5cJ3Yhl5i6UPp+IhuteBJbuHcA5UogKo0EWtlWwW6KSaKoTNEYL7JlCQiVnkhBktUgg==' },
  { keyid: 'SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U', expires: null, key: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEY6Ya7W++7aUPzvMTrezH6Ycx3c+HOKYCcNGybJZSCJq/fd7Qa8uuAKtdIkUQtQiEKERhAmE5lMMJhP8OkDOa2g==' }
]

export const KEYS_FILE = '/etc/install/keys.json'
export const ALLOW_SCRIPTS_FILE = '/etc/install/allow-scripts'

/** The packages whose scripts run without `--allow-scripts`: ecmaOS's own scopes */
const TRUSTED_SCRIPTS = ['@ecmaos/*', '@ecmaos-apps/*']

const base64Bytes = text => Uint8Array.from(atob(text), char => char.charCodeAt(0))
const normalizeRegistry = url => String(url).replace(/\/+$/, '')

/** Checks `bytes` against `dist.integrity` (an SRI list; the strongest hash listed decides), else its SHA-1 `shasum` */
export async function verifyIntegrity(bytes, dist) {
  const hex = digest => Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
  const sri = String(dist?.integrity ?? '').split(/\s+/).map(item => item.match(/^(sha512|sha384|sha256)-(.+)$/)).filter(Boolean)
  const strongest = ['sha512', 'sha384', 'sha256'].map(algorithm => sri.find(item => item[1] === algorithm)).find(Boolean)
  if (strongest) {
    const name = { sha512: 'SHA-512', sha384: 'SHA-384', sha256: 'SHA-256' }[strongest[1]]
    const digest = new Uint8Array(await crypto.subtle.digest(name, bytes))
    let binary = ''
    for (const byte of digest) binary += String.fromCharCode(byte)
    const actual = btoa(binary)
    return actual === strongest[2] ? undefined : `Integrity verification failed. Expected ${strongest[1]}-${strongest[2]} but got ${strongest[1]}-${actual}`
  }
  const expected = dist?.shasum?.toLowerCase()
  if (!expected) return 'No integrity or checksum found'
  const actual = hex(await crypto.subtle.digest('SHA-1', bytes))
  return actual === expected ? undefined : `Checksum verification failed. Expected ${expected} but got ${actual}`
}

/** The keys `registry` signs with, or none when it is not known to sign */
export function keysFor(registry) {
  const wanted = normalizeRegistry(registry)
  const configured = readJson(KEYS_FILE, {})
  for (const [url, keys] of Object.entries(configured ?? {})) if (normalizeRegistry(url) === wanted && Array.isArray(keys)) return keys
  return /^https:\/\/registry\.npmjs\.org$/i.test(wanted) ? NPM_KEYS : []
}

/** An ECDSA signature as DER (`SEQUENCE { r, s }`) in the `r || s` form WebCrypto verifies */
function rawSignature(der) {
  if (der[0] !== 0x30) throw new Error('not a DER signature')
  let at = der[1] & 0x80 ? 2 + (der[1] & 0x7f) : 2
  const integer = () => {
    if (der[at] !== 0x02) throw new Error('not a DER signature')
    const length = der[at + 1]
    const value = der.subarray(at + 2, at + 2 + length)
    at += 2 + length
    const trimmed = value[0] === 0 ? value.subarray(1) : value
    if (trimmed.length > 32) throw new Error('not a P-256 signature')
    const padded = new Uint8Array(32)
    padded.set(trimmed, 32 - trimmed.length)
    return padded
  }
  const r = integer()
  const s = integer()
  const raw = new Uint8Array(64)
  raw.set(r)
  raw.set(s, 32)
  return raw
}

/**
 * Checks the registry's signature of `name@version`. `undefined` when it is good or the registry is not known to sign,
 * a reason otherwise.
 */
export async function verifySignature(registry, name, version, dist) {
  const keys = keysFor(registry)
  if (!keys.length) return undefined
  const signatures = Array.isArray(dist?.signatures) ? dist.signatures : []
  if (!signatures.length) return `${name}@${version} has no registry signature, and ${normalizeRegistry(registry)} signs its packages`
  const message = new TextEncoder().encode(`${name}@${version}:${dist.integrity}`)
  for (const { keyid, sig } of signatures) {
    const known = keys.find(key => key.keyid === keyid)
    if (!known) continue
    try {
      const key = await crypto.subtle.importKey('spki', base64Bytes(known.key), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
      if (await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, rawSignature(base64Bytes(sig)), message)) return undefined
    } catch { /* a malformed key or signature is not a good one */ }
    return `The registry signature of ${name}@${version} does not verify (key ${keyid})`
  }
  return `${name}@${version} is signed with a key this system does not know (${signatures.map(item => item.keyid).join(', ')})`
}

/** Whether a package has build provenance (a signed attestation of where it was built) */
export const hasProvenance = dist => Boolean(dist?.attestations?.provenance)

const matches = (pattern, name) => {
  if (pattern.endsWith('/*')) return name.startsWith(pattern.slice(0, -1))
  return pattern === name
}

/**
 * The packages allowed to run install scripts: ecmaOS's own scopes and those `/etc/install/allow-scripts` lists, one
 * name or `@scope/*` a line
 */
export function scriptsAllowed(name) {
  const listed = exists(ALLOW_SCRIPTS_FILE)
    ? readText(ALLOW_SCRIPTS_FILE).split('\n').map(line => line.replace(/#.*/, '').trim()).filter(Boolean)
    : []
  return [...TRUSTED_SCRIPTS, ...listed].some(pattern => matches(pattern, name))
}
