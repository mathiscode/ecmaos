import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Where the program catalog is, as a URL the host's `fetch` answers (see `sourceFetch`) */
export const ProgramsUrl = 'ecmaos-programs:/index.json'

interface ProgramPackage {
  name: string
  path: string
  dir: string
  programs: Record<string, { file: string, size: number, sha256: string, version: string, license: string, description: string, runtime?: { file: string, size: number, sha256: string } }>
}

// `@ecmaos/coreutils` is permissively licensed and a dependency of this package. `@ecmaos/coreutils-copyleft` (vim,
// nano, make, ...) is GPL and is never part of it: it is used when the user has installed it beside this package.
const Packages = [
  { name: '@ecmaos/coreutils', path: 'coreutils', optional: false },
  { name: '@ecmaos/coreutils-copyleft', path: 'coreutils-copyleft', optional: true }
]

/** Reads the manifests of the program packages that are installed */
export function programPackages(env: NodeJS.ProcessEnv = process.env): ProgramPackage[] {
  const require = createRequire(import.meta.url)
  const copyleft = !['0', 'false', 'off', 'no'].includes(String(env['ECMAOS_COPYLEFT'] ?? '').toLowerCase())
  const found: ProgramPackage[] = []
  for (const entry of Packages) {
    if (entry.optional && !copyleft) continue
    let dir: string
    try {
      dir = path.join(path.dirname(require.resolve(`${entry.name}/package.json`)), 'programs')
    } catch (error) {
      if (entry.optional) continue
      throw error
    }
    const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as { programs: ProgramPackage['programs'] }
    found.push({ name: entry.name, path: entry.path, dir, programs: manifest.programs })
  }
  return found
}

const respond = (body: Uint8Array | string, type: string) => new Response(body as BodyInit, { headers: { 'Content-Type': type } })
const missing = () => new Response('Not found', { status: 404 })

/**
 * The host's `fetch`: serves the bundled initfs (`file:` URLs) and the program catalog (`ecmaos-programs:`) from the
 * files installed on this machine, so a boot needs no network. Anything else is refused: a guest does not get a way to
 * read the host through the kernel's own fetcher.
 */
export function sourceFetch(env: NodeJS.ProcessEnv = process.env, allowed: string[] = []) {
  return async (url: string): Promise<Response> => {
    const target = new URL(url)
    if (target.protocol === 'file:') {
      const file = fileURLToPath(target)
      if (!allowed.includes(file)) return missing()
      return respond(await readFile(file), 'application/gzip')
    }
    if (target.protocol === 'ecmaos-programs:') {
      const packages = programPackages(env)
      if (target.pathname === '/index.json') {
        return respond(JSON.stringify({
          packages: packages.map(({ name, path, programs }) => ({
            name, path, programs: Object.fromEntries(Object.entries(programs).map(([program, { file, size, sha256, version, license, description, runtime }]) => [program, { file, size, sha256, version, license, description, ...(runtime ? { runtime } : {}) }]))
          }))
        }), 'application/json')
      }
      const [, pkg, file] = target.pathname.split('/')
      const entry = packages.find(candidate => candidate.path === pkg)
      const served = entry && Object.values(entry.programs).flatMap(candidate => [candidate.file, candidate.runtime?.file]).find(candidate => candidate === file)
      if (!entry || !served) return missing()
      return respond(await readFile(path.join(entry.dir, served)), served.endsWith('.wasm') ? 'application/wasm' : 'application/gzip')
    }
    return missing()
  }
}

/** The bundled initfs tarball, next to the built entry point */
export function initfsFile() {
  return fileURLToPath(new URL('./initfs.tar.gz', import.meta.url))
}

export const initfsUrl = () => pathToFileURL(initfsFile()).href
