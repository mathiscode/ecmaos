/**
 * What a package may ask of the kernel it runs on: `"ecmaos": { "requires": { "kernel": ">=1.0.0", "features": ["wasi"] } }`.
 * The feature names are the kernel's to define and are only ever added to, so a package published today still means the
 * same tomorrow; a feature this kernel does not list counts as missing.
 */

import semver from 'semver'

const { env } = globalThis.ecmaosSyscalls

/** What this kernel can do, for `requires.features` */
export const KERNEL_FEATURES = ['wasm', 'wasi', 'wali', 'asyncify']

/** What a manifest's `requires` is not met by on this kernel, as messages (empty when it is met) */
export function unmet(manifest) {
  const requires = manifest?.ecmaos?.requires
  if (!requires || typeof requires !== 'object') return []
  const problems = []
  if (typeof requires.kernel === 'string' && requires.kernel) {
    const have = semver.coerce(env['KERNEL_VERSION'] ?? '')
    let ok = false
    try { ok = Boolean(have) && semver.satisfies(have, requires.kernel, { includePrerelease: true }) } catch { /* an invalid range is not met */ }
    if (!ok) problems.push(`needs kernel ${requires.kernel} (this is ${env['KERNEL_VERSION'] ?? 'unknown'})`)
  }
  const features = Array.isArray(requires.features) ? requires.features : []
  const missing = features.filter(feature => !KERNEL_FEATURES.includes(feature))
  if (missing.length) problems.push(`needs kernel feature${missing.length === 1 ? '' : 's'} ${missing.join(', ')}`)
  return problems
}

/** The names in one of a manifest's `ecmaos` lists (`recommends`, `suggests`, `provides`, `conflicts`, `replaces`) */
export function listOf(manifest, key) {
  const list = manifest?.ecmaos?.[key]
  return (Array.isArray(list) ? list : []).filter(item => typeof item === 'string' && item)
}
