/**
 * The npm registry, as `install` reads it. Resolving asks for the abbreviated metadata
 * (`application/vnd.npm.install-v1+json`), a fraction of the full document, which `info` alone fetches. Metadata is
 * cached in the scope's cache (`meta/`), so `--offline` and a registry that cannot be reached still resolve what was
 * seen before; tarballs are cached (`tarballs/`) and checked against their integrity whenever they are used.
 */

import { join } from '../path-utils.mjs'
import { exists, mkdirp, readBytes, readJson, writeAtomic } from './io.mjs'

const { env } = globalThis.ecmaosSyscalls

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const ABBREVIATED = 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*'

export const registryOf = url => String(url || env['REGISTRY'] || DEFAULT_REGISTRY).replace(/\/+$/, '')

const cacheName = name => name.replace('/', '+')

export class RegistryError extends Error {}

export class Registry {
  constructor(url, cache, { offline = false } = {}) {
    this.url = registryOf(url)
    this.cache = cache
    this.offline = offline
    this.seen = new Map()
  }

  metaPath(name) { return join(this.cache, 'meta', `${cacheName(name)}.json`) }

  /** The abbreviated metadata of `name` as last cached, without asking the registry: `undefined` if never fetched */
  cached(name) {
    const cached = readJson(this.metaPath(name))
    return cached?.registry === this.url ? cached.document : undefined
  }

  /** The abbreviated metadata of `name`, fetched once a run */
  metadata(name) {
    if (!this.seen.has(name)) this.seen.set(name, this.fetchMetadata(name))
    return this.seen.get(name)
  }

  async fetchMetadata(name) {
    const cached = readJson(this.metaPath(name))
    const usable = cached?.registry === this.url ? cached.document : undefined
    if (this.offline) {
      if (usable) return usable
      throw new RegistryError(`${name}: not in the cache, and --offline was given`)
    }
    let response
    try {
      response = await globalThis.fetch(`${this.url}/${name}`, { headers: { Accept: ABBREVIATED } })
    } catch (error) {
      if (usable) return usable
      throw new RegistryError(`${this.url}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (response.status === 404) throw new RegistryError(`${name}: no such package in ${this.url}`)
    if (!response.ok) {
      if (usable) return usable
      throw new RegistryError(`${name}: ${this.url} answered ${response.status}`)
    }
    const document = await response.json()
    if (!document?.versions || !document['dist-tags']) throw new RegistryError(`No versions found for ${name}`)
    try { writeAtomic(this.metaPath(name), JSON.stringify({ registry: this.url, fetched: Date.now(), document })) } catch { /* a cache that cannot be written is only slower */ }
    return document
  }

  /** The full document (`description`, `time`, `maintainers` and the rest), not cached */
  async document(name) {
    let response
    try {
      response = await globalThis.fetch(`${this.url}/${name}`)
    } catch (error) {
      throw new RegistryError(`${this.url}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (response.status === 404) throw new RegistryError(`${name}: no such package in ${this.url}`)
    if (!response.ok) throw new RegistryError(`${name}: ${this.url} answered ${response.status}`)
    return await response.json()
  }

  /** `/-/v1/search`: `[{ name, version, description, date, publisher }]` */
  async search(text, size = 20) {
    let response
    try {
      response = await globalThis.fetch(`${this.url}/-/v1/search?text=${encodeURIComponent(text)}&size=${size}`)
    } catch (error) {
      throw new RegistryError(`${this.url}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) throw new RegistryError(`${this.url} answered ${response.status} to a search`)
    const { objects = [] } = await response.json()
    return objects.map(({ package: found }) => found)
  }

  tarballPath(name, version) { return join(this.cache, 'tarballs', `${cacheName(name)}-${version}.tgz`) }

  /**
   * The tarball of `name@version`, from the cache when the copy there passes `check`, else from the registry (and then
   * cached). Gives `{ bytes, path, cached }`; `check(bytes)` returns a reason when the bytes are not the package's.
   */
  async tarball(name, version, dist, check) {
    const path = this.tarballPath(name, version)
    if (exists(path)) {
      const bytes = readBytes(path)
      if (!await check(bytes)) return { bytes, path, cached: true }
    }
    if (this.offline) throw new RegistryError(`${name}@${version}: not in the cache, and --offline was given`)
    if (!dist?.tarball) throw new RegistryError(`No tarball URL found for ${name} v${version}`)
    let response
    try {
      response = await globalThis.fetch(dist.tarball)
    } catch (error) {
      throw new RegistryError(`${dist.tarball}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) throw new RegistryError(`${dist.tarball}: answered ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    const problem = await check(bytes)
    if (problem) throw new RegistryError(problem)
    mkdirp(join(this.cache, 'tarballs'))
    writeAtomic(path, bytes)
    return { bytes, path, cached: false }
  }
}
