import type { promises } from '@zenfs/core'

type Fs = Pick<typeof promises, 'stat' | 'lstat' | 'writeFile' | 'unlink'>

/**
 * Prebuilt WebAssembly programs (`vim`, `jq`, `make`, ...), published by `@ecmaos/coreutils` and `@ecmaos/coreutils-
 * copyleft` and served as a catalog at `/programs/index.json`. Boot writes `/bin/<name>` for any program whose
 * installed copy differs from the catalog.
 */
export interface ProgramEntry {
  file: string
  size: number
  sha256: string
  version: string
  license: string
  description: string
  /**
   * Files the program needs beside it (`vim`'s runtime): a tarball rooted at `/`, in the same directory as the
   * program
   */
  runtime?: { file: string, size: number, sha256: string }
}

export interface ProgramPackage {
  name: string
  path: string
  programs: Record<string, ProgramEntry>
}

export interface ProgramCatalog {
  packages: ProgramPackage[]
}

export interface InstallProgramsOptions {
  /** Where the catalog is; the programs are fetched relative to it (`<path>/<file>`). */
  catalogUrl: string
  /** Programs not to install (the kernel's command blacklist). */
  skip?: (name: string) => boolean
  /**
   * The hash each installed program had when it was written, so a boot compares sizes instead of reading every
   * binary.
   */
  stamps: { read(): Record<string, string>, write(stamps: Record<string, string>): void }
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>
  /** Unpacks a runtime tarball into the filesystem; without it, runtimes are not installed */
  extract?: (tarball: Uint8Array) => Promise<void>
}

export interface InstallProgramsResult {
  installed: string[]
  current: string[]
  failed: Record<string, string>
}

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')

/**
 * Writes `/bin/<name>` for each catalog program that is missing or differs. An unreachable catalog is not an error; a
 * program that fails (missing file, hash mismatch) is reported and the rest still install.
 */
export async function installPrograms(fs: Fs, options: InstallProgramsOptions): Promise<InstallProgramsResult> {
  const fetcher = options.fetcher ?? ((url, init) => fetch(url, init))
  const result: InstallProgramsResult = { installed: [], current: [], failed: {} }

  let catalog: ProgramCatalog
  try {
    const response = await fetcher(options.catalogUrl, { cache: 'no-cache' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    catalog = await response.json() as ProgramCatalog
  } catch (error) {
    result.failed['(catalog)'] = `${options.catalogUrl}: ${(error as Error).message}`
    return result
  }

  const stamps = options.stamps.read()
  let changed = false

  const sha = async (bytes: Uint8Array) => globalThis.crypto?.subtle ? hex(await globalThis.crypto.subtle.digest('SHA-256', bytes as BufferSource)) : undefined
  const fetchFile = async (pkg: ProgramPackage, entry: { file: string, size: number, sha256: string }) => {
    const url = new URL(`${pkg.path}/${entry.file}`, new URL(options.catalogUrl, globalThis.location?.href ?? 'http://localhost/'))
    url.searchParams.set('v', entry.sha256.slice(0, 16)) // a changed file is a new URL, so no cache serves the old one
    const response = await fetcher(url.href)
    if (!response.ok) throw new Error(`${url.pathname}: HTTP ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length !== entry.size) throw new Error(`${entry.file} is ${bytes.length} bytes, the catalog says ${entry.size}`)
    // `crypto.subtle` exists only in a secure context; where it does not, the size check above is all there is.
    const actual = await sha(bytes)
    if (actual !== undefined && actual !== entry.sha256) throw new Error(`${entry.file} does not match the catalog's sha256`)
    return bytes
  }

  for (const pkg of catalog.packages) {
    for (const [name, entry] of Object.entries(pkg.programs)) {
      if (options.skip?.(name)) continue
      if (entry.runtime && options.extract && stamps[`${name}:runtime`] !== entry.runtime.sha256) {
        try {
          await options.extract(await fetchFile(pkg, entry.runtime))
          stamps[`${name}:runtime`] = entry.runtime.sha256
          changed = true
        } catch (error) {
          result.failed[`${name} (runtime)`] = (error as Error).message
        }
      }
      const target = `/bin/${name}`
      try {
        // An earlier build linked `vim` to `vi`; writing through that link would replace the other program.
        if ((await fs.lstat(target).catch(() => undefined))?.isSymbolicLink()) await fs.unlink(target)
        const installed = await fs.stat(target).catch(() => undefined)
        if (installed?.isFile() && installed.size === entry.size && stamps[name] === entry.sha256) { result.current.push(name); continue }

        const bytes = await fetchFile(pkg, entry)
        await fs.writeFile(target, bytes, { mode: 0o755 })
        stamps[name] = entry.sha256
        changed = true
        result.installed.push(name)
      } catch (error) {
        result.failed[name] = (error as Error).message
      }
    }
  }
  if (changed) options.stamps.write(stamps)
  return result
}
