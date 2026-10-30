/**
 * The names a distribution's package manager knows packages by, mapped to npm packages: the index `apt`, `pacman` and
 * the other front-ends of `install` consult. It is the npm package `@ecmaos/package-index`; the version built into
 * ecmaOS is the fallback, and `apt update` / `pacman -Sy` keep the latest one in the scope's state directory.
 *
 * An entry is `{ package, description, range? }` (an npm package), or `{ provided }` (ecmaOS ships it already). A
 * front-end's own section (`apt`, `pacman`) holds names only it knows, as an entry or as a string naming a `common` one.
 */

import semver from 'semver'

import bundled from '@ecmaos/package-index/index.json'
import bundledManifest from '@ecmaos/package-index/package.json'

import { join } from '../path-utils.mjs'
import { mkdirp, readBytes, readJson, readText, untar, writeAtomic } from './io.mjs'
import { verifyIntegrity, verifySignature } from './trust.mjs'

const { env, rmRecursive, getpid } = globalThis.ecmaosSyscalls

const textOf = path => { try { return readText(path) } catch { return undefined } }

export const INDEX_PACKAGE = '@ecmaos/package-index'

const valid = index => (index?.schema === 1 || index?.schema === 2) && index.common && typeof index.common === 'object'

/** Where a scope keeps the index `apt update` fetched */
export const indexPath = scope => (scope.system ? '/var/lib/install/package-index.json' : join(env['HOME'] || '/root', '.local/state/install/package-index.json'))

/** Where the index that ships in the system image keeps its signature files, beside `index.json` */
export const SNAPSHOT_DIRECTORY = '/usr/share/ecmaos/package-index'

/**
 * The signed index (`{ text, signature, keyId }`) to check `@ecmaos-apps` packages against: the one `apt update` fetched
 * with the index, else the one in the system image; `undefined` when there is none.
 */
export function loadTrust(scope) {
  for (const path of new Set([indexPath(scope), '/var/lib/install/package-index.json', indexPath({ system: false })])) {
    const stored = readJson(path)
    if (stored?.trust?.text) return stored.trust
  }
  const text = textOf(join(SNAPSHOT_DIRECTORY, 'trust.json'))
  const signature = readJson(join(SNAPSHOT_DIRECTORY, 'trust.sig.json'))
  return text && signature?.signature ? { text, signature: signature.signature, keyId: signature.keyId } : undefined
}

/** The newest index there is: the system's or the caller's fetched one, else the one built in. Gives `{ index, version, source }` */
export function loadIndex(scope) {
  const candidates = [{ index: bundled, version: bundledManifest.version, source: 'built in' }]
  for (const path of new Set([indexPath(scope), '/var/lib/install/package-index.json', indexPath({ system: false })])) {
    const stored = readJson(path)
    if (valid(stored?.index) && semver.valid(stored.version)) candidates.push({ index: stored.index, version: stored.version, source: path })
  }
  return candidates.sort((a, b) => semver.rcompare(a.version, b.version))[0]
}

/**
 * Fetches the latest `@ecmaos/package-index`, checks its integrity and signature, and keeps its `index.json`.
 * Gives `{ version, updated, bytes }`; throws when the registry has no such package or it fails the checks.
 */
export async function refreshIndex(registry, scope, { ignoreSignatures = false } = {}) {
  const document = await registry.metadata(INDEX_PACKAGE)
  const version = document['dist-tags']?.latest
  const dist = document.versions?.[version]?.dist
  if (!version || !dist) throw new Error(`${INDEX_PACKAGE}: no latest version`)
  const current = loadIndex(scope)
  if (current.source !== 'built in' && semver.gte(current.version, version)) return { version, updated: false, bytes: 0 }
  if (!ignoreSignatures) {
    const problem = await verifySignature(registry.url, INDEX_PACKAGE, version, dist)
    if (problem) throw new Error(problem)
  }
  const tarball = await registry.tarball(INDEX_PACKAGE, version, dist, bytes => verifyIntegrity(bytes, dist))
  const scratch = join(scope.cache, `.index-${getpid()}`)
  let index
  let trust
  try {
    mkdirp(scratch)
    if (await untar(tarball.path, scratch) !== 0) throw new Error(`${INDEX_PACKAGE}@${version}: cannot be unpacked`)
    index = readJson(join(scratch, 'package/index.json'))
    const text = textOf(join(scratch, 'package/trust.json'))
    const sig = readJson(join(scratch, 'package/trust.sig.json'))
    if (text && sig?.signature) trust = { text, signature: sig.signature, keyId: sig.keyId }
  } finally {
    try { rmRecursive(scratch) } catch { /* never made */ }
  }
  if (!valid(index)) throw new Error(`${INDEX_PACKAGE}@${version}: has no usable index.json`)
  writeAtomic(indexPath(scope), JSON.stringify({ version, fetched: Date.now(), registry: registry.url, index, ...(trust ? { trust } : {}) }))
  return { version, updated: true, bytes: readBytes(tarball.path).byteLength }
}

/** The entry `name` means to `manager` (`'apt'`, `'pacman'`, or `'common'` alone), or `undefined` */
export function lookup(index, manager, name) {
  let entry = index[manager]?.[name]
  if (typeof entry === 'string') entry = index.common[entry]
  entry ??= index.common[name]
  if (!entry || typeof entry !== 'object') return undefined
  return { name, ...entry }
}

/** The name `manager` shows for the npm package `npmName`: an entry's key when one maps to it, else the npm name */
export function nameFor(index, manager, npmName) {
  let found
  for (const section of [index[manager] ?? {}, index.common]) {
    for (const [key, value] of Object.entries(section)) {
      const entry = typeof value === 'string' ? index.common[value] : value
      if (entry?.package !== npmName) continue
      if (key === npmName) return key
      found ??= key
    }
  }
  return found ?? npmName
}

/** Every named entry `manager` knows, as `[name, entry]` (the provided ones included) */
export function entries(index, manager) {
  const names = new Set([...Object.keys(index.common), ...Object.keys(index[manager] ?? {})])
  return [...names].sort().map(name => [name, lookup(index, manager, name)]).filter(([, entry]) => entry)
}

/**
 * What a command line names, without the decoration its manager adds: apt's `name:arch`, `name=version` and
 * `name/release`; pacman's `repo/name` and `name>=version`. Gives `{ name, range }`.
 */
export function parseTarget(text, manager) {
  let name = String(text)
  let range
  if (manager === 'apt') {
    const pinned = name.match(/^([^=]+)=(.+)$/)
    if (pinned) { name = pinned[1]; range = pinned[2] }
    name = name.replace(/:[a-z0-9-]+$/, '').replace(/\/[^/]+$/, '')
  } else if (manager === 'pacman') {
    name = name.replace(/^[a-z0-9-]+\//, '')
    const bound = name.match(/^([^<>=]+)([<>]=?|=)(.+)$/)
    if (bound) { name = bound[1]; range = bound[2] === '=' ? bound[3] : `${bound[2]}${bound[3]}` }
  }
  return { name, range }
}
