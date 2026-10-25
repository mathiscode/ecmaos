/**
 * The in-tree modules that are not in the boot bundle (`zip`, `iso`, `dropbox`, `googledrive`): the site serves them with a
 * catalog at `/modules/index.json`, and the kernel fetches one the first time something asks for it by alias
 * (`request_module`). The file lands in `/lib/modules/RELEASE/kernel/` like any module, so it stays for next time, and
 * the signature on it is checked when it loads, not here: the catalog and the files come from the same place, so they
 * prove nothing about who made the module. Only the hash is checked, to catch a damaged download.
 */

export interface CatalogEntry {
  file: string
  size: number
  sha256: string
  version: string
  license: string
  description: string
  aliases: string[]
  depends: string[]
  signed: boolean
}

export interface ModuleCatalogHost {
  /** Where the catalog is; the files are fetched relative to it */
  url: string
  fetch(url: string, init?: RequestInit): Promise<Response>
  /** The directory a downloaded module goes in */
  dir(): string
  fs: {
    mkdir(path: string, options: { recursive: true }): Promise<unknown>
    writeFile(path: string, data: Uint8Array, options: { mode: number }): Promise<unknown>
  }
  log: { warn(message: string): void }
}

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')

export class ModuleCatalog {
  #loading?: Promise<Record<string, CatalogEntry> | undefined>

  constructor(private readonly host: ModuleCatalogHost) {}

  /** The catalog, fetched once; a failed fetch is tried again the next time */
  async #entries(): Promise<Record<string, CatalogEntry> | undefined> {
    this.#loading ??= (async () => {
      try {
        const response = await this.host.fetch(this.host.url, { cache: 'no-cache' })
        if (!response.ok) {
          this.host.log.warn(`module catalog ${this.host.url}: ${response.status} ${response.statusText}`)
          return undefined
        }
        return (await response.json() as { modules?: Record<string, CatalogEntry> }).modules ?? {}
      } catch (error) {
        this.host.log.warn(`module catalog ${this.host.url}: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      }
    })()
    const entries = await this.#loading
    if (!entries) this.#loading = undefined
    return entries
  }

  /** The name of the module the alias (or the name itself) is for */
  async find(alias: string): Promise<string | undefined> {
    const entries = await this.#entries()
    if (!entries) return undefined
    return Object.entries(entries).find(([name, entry]) => name === alias || entry.aliases.includes(alias))?.[0]
  }

  /** Downloads the module and what it depends on into the module directory; returns the names written */
  async install(name: string, done = new Set<string>()): Promise<string[]> {
    const entry = (await this.#entries())?.[name]
    if (!entry || done.has(name)) return []
    done.add(name)

    const written: string[] = []
    for (const dependency of entry.depends) written.push(...await this.install(dependency, done))

    const url = new URL(entry.file, new URL(this.host.url, globalThis.location?.href ?? 'http://localhost/'))
    url.searchParams.set('v', entry.sha256.slice(0, 16)) // a changed file is a new URL, so no cache serves the old one
    const response = await this.host.fetch(url.href)
    if (!response.ok) throw new Error(`${name}: ${response.status} ${response.statusText}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    const sha = globalThis.crypto?.subtle ? hex(await globalThis.crypto.subtle.digest('SHA-256', bytes as BufferSource)) : undefined
    if (sha && sha !== entry.sha256) throw new Error(`${name}: the download does not match the catalog`)

    const dir = `${this.host.dir()}/kernel`
    await this.host.fs.mkdir(dir, { recursive: true })
    await this.host.fs.writeFile(`${dir}/${entry.file}`, bytes, { mode: 0o644 })
    written.push(name)
    return written
  }
}
