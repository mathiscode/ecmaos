/**
 * PyPI's JSON API (`/pypi/NAME/json`, `/pypi/NAME/VERSION/json`), and the wheels it lists. Metadata and wheels are
 * cached under the scope's cache directory (`pip/`), wheels are checked against the SHA-256 PyPI publishes.
 */

import { join } from '../path-utils.mjs'
import { exists, mkdirp, readBytes, readJson, writeAtomic } from '../install/io.mjs'
import { compareVersions, isPrerelease, normalize, parseVersion, satisfies } from './pep440.mjs'

const { env } = globalThis.ecmaosSyscalls

export const DEFAULT_INDEX = 'https://pypi.org'

export class IndexError extends Error {}

/** `https://pypi.org/simple` and `https://pypi.org` are the same index: the JSON API lives beside `simple` */
export const indexOf = url => String(url || env['PIP_INDEX_URL'] || DEFAULT_INDEX).replace(/\/+$/, '').replace(/\/simple$/, '')

const hex = bytes => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')

export async function sha256(bytes) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
}

/** A wheel's name split into its tags: `{ name, version, python: [], abi: [], platform: [] }`, or `undefined` for a file that is not one */
export function parseWheel(filename) {
  const match = /^(.+?)-(\d[^-]*)(?:-(\d[^-]*))?-([^-]+)-([^-]+)-([^-]+)\.whl$/.exec(filename)
  if (!match) return undefined
  return { name: normalize(match[1]), version: match[2], python: match[4].split('.'), abi: match[5].split('.'), platform: match[6].split('.') }
}

/** Whether a wheel is pure Python for this interpreter: no ABI, no platform, a `py3` tag that reaches `minor` */
export function pureWheel(filename, minor) {
  const wheel = parseWheel(filename)
  if (!wheel) return false
  if (!wheel.platform.includes('any') || !wheel.abi.includes('none')) return false
  return wheel.python.some(tag => {
    const match = /^(?:py|cp)3(\d*)$/.exec(tag)
    return Boolean(match) && (match[1] === '' || Number(match[1]) <= minor)
  })
}

export class Index {
  constructor(url, cache, { offline = false } = {}) {
    this.url = indexOf(url)
    this.cache = join(cache, 'pip')
    this.offline = offline
    this.seen = new Map()
  }

  metaPath(name, version) { return join(this.cache, 'meta', `${name}${version ? `-${version}` : ''}.json`) }

  /** The JSON document of a project, or of one release of it; fetched once a run, the cached copy kept for offline use */
  document(name, version) {
    const key = `${name}@${version ?? ''}`
    if (!this.seen.has(key)) this.seen.set(key, this.fetch(name, version))
    return this.seen.get(key)
  }

  async fetch(name, version) {
    const path = this.metaPath(name, version)
    const cached = readJson(path)
    const usable = cached?.index === this.url ? cached.document : undefined
    if (this.offline) {
      if (usable) return usable
      throw new IndexError(`${name}: not in the cache, and --offline was given`)
    }
    let response
    try {
      response = await globalThis.fetch(`${this.url}/pypi/${name}${version ? `/${version}` : ''}/json`, { headers: { Accept: 'application/json' } })
    } catch (error) {
      if (usable) return usable
      throw new IndexError(`${this.url}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (response.status === 404) throw new IndexError(`${name}: no such project in ${this.url}`)
    if (!response.ok) {
      if (usable) return usable
      throw new IndexError(`${this.url} answered ${response.status}`)
    }
    const document = await response.json()
    try { writeAtomic(path, JSON.stringify({ index: this.url, fetched: Date.now(), document })) } catch { /* a cache that cannot be written is only slower */ }
    return document
  }

  cachedVersion(name) { return readJson(this.metaPath(name))?.document?.info?.version }

  wheelPath(filename) { return join(this.cache, 'wheels', filename) }

  /** A wheel's bytes: the cached copy if it matches `file.digests.sha256`, else fetched. Gives `{ bytes, cached }` */
  async wheel(file) {
    const path = this.wheelPath(file.filename)
    const expected = file.digests?.sha256
    if (exists(path)) {
      const bytes = readBytes(path)
      if (!expected || await sha256(bytes) === expected) return { bytes, cached: true }
    }
    if (this.offline) throw new IndexError(`${file.filename}: not in the cache, and --offline was given`)
    let response
    try {
      response = await globalThis.fetch(file.url)
    } catch (error) {
      throw new IndexError(`${file.url}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) throw new IndexError(`${file.url} answered ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (expected && await sha256(bytes) !== expected) throw new IndexError(`${file.filename}: the SHA-256 does not match the one the index published`)
    mkdirp(join(this.cache, 'wheels'))
    writeAtomic(path, bytes)
    return { bytes, cached: false }
  }
}

/**
 * The best release of a project that meets `specifiers` (a list of specifier clauses lists) on Python `python`: not
 * yanked (unless pinned), a pre-release only when asked or nothing else will do, with a pure-Python wheel that suits the
 * interpreter. Gives `{ version, file }`; throws with the reason none does.
 */
export function pick(document, name, specifiers, { python, prereleases = false, label = name }) {
  const minor = Number(python.split('.')[1])
  const releases = document.releases ?? { [document.info.version]: document.urls ?? [] }
  const pinned = specifiers.some(clauses => clauses.some(([operator]) => operator === '==' || operator === '==='))
  const candidates = Object.keys(releases).filter(version => parseVersion(version)).sort((a, b) => compareVersions(b, a))
  const reasons = { versions: candidates.length, yanked: 0, python: 0, native: 0, sdist: 0, spec: 0 }
  const usable = allowPre => {
    for (const version of candidates) {
      if (!specifiers.every(clauses => satisfies(version, clauses, { prereleases: allowPre || prereleases }))) { reasons.spec++; continue }
      if (isPrerelease(version) && !allowPre && !prereleases) continue
      const files = releases[version] ?? []
      const wheels = files.filter(file => file.packagetype === 'bdist_wheel')
      if (files.length && files.every(file => file.yanked) && !pinned) { reasons.yanked++; continue }
      const pure = wheels.filter(file => !file.yanked && pureWheel(file.filename, minor))
      if (!pure.length) {
        if (wheels.length) reasons.native++
        else if (files.length) reasons.sdist++
        continue
      }
      const suitable = pure.filter(file => !file.requires_python || satisfies(python, file.requires_python, { prereleases: true }))
      if (!suitable.length) { reasons.python++; continue }
      // py3-none-any over py2.py3-none-any
      suitable.sort((a, b) => Number(a.filename.includes('py2')) - Number(b.filename.includes('py2')))
      return { version, file: suitable[0] }
    }
    return undefined
  }
  const found = usable(false) ?? usable(true)
  if (found) return found
  if (!reasons.native && !reasons.sdist && !reasons.python && !reasons.yanked) {
    throw new IndexError(`Could not find a version that satisfies the requirement ${label} (from versions: ${[...candidates].reverse().join(', ') || 'none'})`)
  }
  const why = []
  if (reasons.native) why.push(`${reasons.native} release${reasons.native === 1 ? '' : 's'} only as native wheels, which cannot run on ecmaOS`)
  if (reasons.sdist) why.push(`${reasons.sdist} release${reasons.sdist === 1 ? '' : 's'} only as source distributions, which are not built here`)
  if (reasons.python) why.push(`${reasons.python} release${reasons.python === 1 ? '' : 's'} that need${reasons.python === 1 ? 's' : ''} another Python than ${python}`)
  throw new IndexError(`Could not find a version of ${name} that can be installed${why.length ? ` (${why.join('; ')})` : ''}`)
}
