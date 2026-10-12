/**
 * Bundles `src/bin/node.mjs` - ecmaOS's real `/bin/node` interpreter, see that file's own doc
 * comment for why it must ship with zero import statements - into a virtual module exporting its
 * bundled source as a string, importable as `virtual:bin-node`.
 *
 * Runs at dev, build, and test time alike (all three load this same `vite.config.ts`), so
 * `Filesystem`'s boot-time write of `/bin/node` sees the same real bundle everywhere, not a stub.
 */

import { build } from 'esbuild'
import type { Plugin } from 'vite'
import path from 'node:path'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'

function binWorkerPlugin(name: string, entryPoint: string): Plugin {
  const virtualModuleId = `virtual:bin-${name}`
  const resolvedVirtualModuleId = '\0' + virtualModuleId
  let cached: string | undefined

  return {
    name: `ecmaos:bin-${name}`,
    resolveId(id) {
      if (id === virtualModuleId) return resolvedVirtualModuleId
    },
    async load(id) {
      if (id !== resolvedVirtualModuleId) return

      if (!cached) {
        const result = await build({
          entryPoints: [entryPoint],
          bundle: true,
          format: 'esm',
          platform: 'browser',
          write: false,
          absWorkingDir: import.meta.dirname
        })

        const output = result.outputFiles[0]
        if (!output) throw new Error(`bin-${name}: esbuild produced no output`)
        cached = output.text
      }

      return `export default ${JSON.stringify(cached)}`
    }
  }
}

export function binNode(): Plugin {
  return binWorkerPlugin('node', 'src/bin/node.mjs')
}

/**
 * Bundles `src/bin/wali.mjs` - ecmaOS's `/bin/wali` interpreter for WALI-format WebAssembly
 * modules - into `virtual:bin-wali`, the same way `binNode` does for `/bin/node`.
 */
export function binWali(): Plugin {
  return binWorkerPlugin('wali', 'src/bin/wali.mjs')
}

/**
 * Bundles `src/bin/pilot-pwd.mjs` - a syscall-only program proving `execve` plus
 * `Kernel.bridgeStdio` work together - into `virtual:bin-pilot-pwd`, the same way `binNode` does.
 * A test fixture only: tests install it into `/bin` themselves; it never ships in the OS.
 */
export function binPilotPwd(): Plugin {
  return binWorkerPlugin('pilot-pwd', 'src/bin/pilot-pwd.mjs')
}

/**
 * Bundles `src/bin/pilot-window.mjs` - a program proving the `window_create`/`window_write`/
 * `window_close` main-thread-syscall bridge works end to end - into `virtual:bin-pilot-window`.
 * A test fixture only, like `binPilotPwd`.
 */
export function binPilotWindow(): Plugin {
  return binWorkerPlugin('pilot-window', 'src/bin/pilot-window.mjs')
}

/**
 * The coreutils that ship as real `execve` programs - each a worker-hosted, syscall-only program
 * living in `@ecmaos/coreutils` (`core/utils/src/commands-execve/<name>.mjs`).
 * Keyed by the real command name (`/bin/<name>`), since that's the path `Kernel.registerCommands`/
 * `readFileHeader` resolve.
 *
 * These live in `@ecmaos/coreutils`, not here, on purpose: they're coreutils content (the actual
 * `echo`/`rm`/`cp`/... business logic), and `@ecmaos/kernel` should own only the *mechanism*
 * (esbuild bundling, `execve`, syscalls). `@ecmaos/kernel` already depends on `@ecmaos/coreutils`
 * (for the in-process `true`/`false`/`test` shim), so this adds no new dependency edge.
 */
export const migratedCommands = [
  'echo', 'basename', 'dirname', 'tr', 'mkdir', 'rm', 'cp', 'mv', 'touch', 'chmod', 'cat',
  'head', 'tail', 'wc', 'nl', 'rev', 'tac', 'uniq', 'cut', 'fold', 'expand', 'unexpand', 'cksum',
  'strings', 'xxd', 'od', 'hash', 'cmp', 'comm', 'column',
  'seq', 'factor', 'rmdir', 'join', 'paste', 'sleep', 'mktemp', 'shuf',
  'split', 'pr', 'tee', 'stat',
  'readlink', 'realpath', 'ln',
  'dd', 'sort', 'find',
  'diff', 'grep', 'sed', 'awk',
  'ls', 'tar',
  'cal', 'date', 'printf', 'which',
  'whoami', 'pwd', 'hostname', 'uname', 'nproc', 'uptime', 'motd',
  'fmt', 'crypto', 'curl', 'fetch',
  'id', 'groups',
  'chown',
  'zip', 'unzip', 'git', 'less', 'man',
  'free', 'who', 'last', 'ecmash', 'init', 'getty', 'login', 'env', 'printenv', 'su', 'sudo', 'fsck', 'true', 'false', 'yes', 'xargs', 'timeout', 'nohup', 'watch', 'strace', 'md5sum', 'sha1sum', 'sha256sum', 'sha384sum', 'sha512sum', 'base64', 'expr', 'du', 'egrep', 'fgrep', 'more', 'chgrp', 'gzip', 'gunzip', 'zcat', 'file', 'hexdump', 'getent', 'stty', 'tput', 'visudo', 'dmesg', 'lscpu', 'fastfetch', 'wall', 'write'
] as const

/**
 * The kernel-native commands that ship as real `execve` programs - unlike `migratedCommands` above,
 * these live in `@ecmaos/kernel` itself (`src/bin/commands/<name>.mjs`), not `@ecmaos/coreutils`,
 * because their real logic needs a kernel-only custom syscall (`storage_usage`/`reboot` -
 * see `#lib/main-thread-syscalls.ts`) rather than the plain filesystem/stdio syscalls every
 * `@ecmaos/coreutils` execve program uses. Everything else about them is identical: a real,
 * worker-hosted, syscall-only program.
 */
export const migratedKernelCommands = ['clear', 'df', 'ps', 'reboot', 'halt', 'poweroff', 'uninstall', 'tty', 'sockets', 'user', 'umount', 'theme', 'crond', 'cron', 'kill', 'killall', 'pgrep', 'pkill', 'useradd', 'userdel', 'usermod', 'chage', 'groupadd', 'groupdel', 'groupmod', 'gpasswd', 'history', 'format', 'time', 'nc', 'open', 'video', 'play', 'web', 'view', 'mount', 'passkey', 'screensaver-daemon', 'app', 'devcli', 'download', 'load', 'passwd', 'chsh', 'screensaver', 'snake', 'upload', 'install', 'connect', 'share', 'attach', 'gateway', 'quota', 'notify-send', 'xclip', 'say', 'top'] as const

/** Resolves once: the real, on-disk directory `@ecmaos/coreutils`'s `commands-execve/` sources live in. */
function coreutilsExecveDir(): string {
  const require = createRequire(import.meta.url)
  // `@ecmaos/coreutils`'s package.json is the one stable resolution anchor - resolving straight to
  // a source file would need every consumer to know its exports map shape; resolving the package
  // root and joining the known subdirectory works the same whether this is a workspace symlink (as
  // in this monorepo, via pnpm) or a real installed dependency.
  const pkgJsonPath = require.resolve('@ecmaos/coreutils/package.json')
  return path.join(path.dirname(pkgJsonPath), 'src', 'commands-execve')
}

/**
 * Bundles every migrated coreutil's real program (`@ecmaos/coreutils`'s `commands-execve/<name>.mjs`)
 * into one virtual module, `virtual:bin-commands`, exporting `{ [name]: string }`, so
 * `Kernel.registerCommands` can look a name up directly.
 */
export function binCommands(): Plugin {
  const virtualModuleId = 'virtual:bin-commands'
  const resolvedVirtualModuleId = '\0' + virtualModuleId
  let cached: string | undefined

  return {
    name: 'ecmaos:bin-commands',
    resolveId(id) {
      if (id === virtualModuleId) return resolvedVirtualModuleId
    },
    async load(id) {
      if (id !== resolvedVirtualModuleId) return

      if (!cached) {
        const execveDir = coreutilsExecveDir()
        const entries: Record<string, string> = {}
        for (const name of migratedCommands) {
          const result = await build({
            entryPoints: [path.join(execveDir, `${name}.mjs`)],
            bundle: true,
            format: 'esm',
            platform: 'browser',
            write: false
          })
          const output = result.outputFiles[0]
          if (!output) throw new Error(`bin-commands: esbuild produced no output for ${name}`)
          entries[name] = output.text
        }
        cached = JSON.stringify(entries)
      }

      return `export default ${cached}`
    }
  }
}

/**
 * Bundles every migrated kernel-native command's real program (`src/bin/commands/<name>.mjs`) into
 * one virtual module, `virtual:bin-kernel-commands`, exporting `{ [name]: string }` - the same shape
 * `binCommands()` produces for `@ecmaos/coreutils`'s migrated commands, so `Kernel.registerCommands`
 * can look either up the same way.
 */
export function binKernelCommands(): Plugin {
  const virtualModuleId = 'virtual:bin-kernel-commands'
  const resolvedVirtualModuleId = '\0' + virtualModuleId
  let cached: string | undefined

  return {
    name: 'ecmaos:bin-kernel-commands',
    resolveId(id) {
      if (id === virtualModuleId) return resolvedVirtualModuleId
    },
    async load(id) {
      if (id !== resolvedVirtualModuleId) return

      if (!cached) {
        const entries: Record<string, string> = {}
        for (const name of migratedKernelCommands) {
          const result = await build({
            entryPoints: [path.join(import.meta.dirname, 'src', 'bin', 'commands', `${name}.mjs`)],
            bundle: true,
            format: 'esm',
            platform: 'browser',
            write: false,
            absWorkingDir: import.meta.dirname
          })
          const output = result.outputFiles[0]
          if (!output) throw new Error(`bin-kernel-commands: esbuild produced no output for ${name}`)
          entries[name] = output.text
        }
        cached = JSON.stringify(entries)
      }

      return `export default ${cached}`
    }
  }
}

/**
 * The packages that ship prebuilt WebAssembly programs, each with a `programs/manifest.json` and the `.wasm` files it
 * lists. `path` is the directory the site serves them under, `/programs/<path>/<file>`. The copyleft package is
 * optional: it is left out when it is not installed, or when `ECMAOS_COPYLEFT` is `0`, `false`, `off` or `no`,
 * which gives a build that holds only permissively licensed programs.
 */
const PROGRAM_PACKAGES = [
  { name: '@ecmaos/coreutils', path: 'coreutils', optional: false },
  { name: '@ecmaos/coreutils-copyleft', path: 'coreutils-copyleft', optional: true }
]

export interface ProgramPackageManifest {
  name: string
  path: string
  dir: string
  programs: Record<string, { file: string, size: number, sha256: string, version: string, license: string, description: string, runtime?: { file: string, size: number, sha256: string }, sources?: { archive: string }[] }>
}

/** Reads the manifests of the program packages that this build includes. */
export function readProgramPackages(): ProgramPackageManifest[] {
  const require = createRequire(import.meta.url)
  const copyleft = !['0', 'false', 'off', 'no'].includes(String(process.env['ECMAOS_COPYLEFT'] ?? '').toLowerCase())
  const found: ProgramPackageManifest[] = []
  for (const entry of PROGRAM_PACKAGES) {
    if (entry.optional && !copyleft) continue
    let dir: string
    try { dir = path.join(path.dirname(require.resolve(`${entry.name}/package.json`)), 'programs') } catch (error) {
      if (entry.optional) continue
      throw error
    }
    const { programs } = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
    found.push({ name: entry.name, path: entry.path, dir, programs })
  }
  return found
}

/** The catalog the kernel fetches (`/programs/index.json`): what each package offers, without where it lives on disk. */
export function programCatalog(packages: ProgramPackageManifest[]) {
  const entry = ({ file, size, sha256, version, license, description, runtime }: ProgramPackageManifest['programs'][string]) => ({ file, size, sha256, version, license, description, ...(runtime ? { runtime } : {}) })
  return {
    packages: packages.map(({ name, path, programs }) => ({
      name, path, programs: Object.fromEntries(Object.entries(programs).map(([program, value]) => [program, entry(value)]))
    }))
  }
}

/**
 * Serves the prebuilt WebAssembly programs as files instead of embedding them in the kernel bundle: in dev and
 * preview from the packages themselves, in a build as `programs/index.json` and `programs/<package>/<file>` beside the
 * page. The kernel reads the catalog at boot and writes each program to `/bin` only when the installed one differs
 * (`src/tree/lib/programs.ts`). Keeping the binaries out of the JavaScript keeps each one a separate file under its
 * own license, and keeps GPL code out of the published `@ecmaos/kernel` package (`files` excludes `dist/programs`).
 */
export function binPrograms(): Plugin {
  const serve = (server: { middlewares: { use: (handler: (req: any, res: any, next: () => void) => void) => void } }) => {
    server.middlewares.use((req, res, next) => {
      const url = String(req.url ?? '').split('?')[0]
      if (!url.startsWith('/programs/')) return next()
      const packages = readProgramPackages()
      if (url === '/programs/index.json') {
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-cache')
        res.end(JSON.stringify(programCatalog(packages)))
        return
      }
      const [, , pkg, file] = url.split('/')
      const entry = packages.find(candidate => candidate.path === pkg)
      const served = entry && Object.values(entry.programs).flatMap(candidate => [candidate.file, candidate.runtime?.file]).find(candidate => candidate === file)
      if (!entry || !served) { res.statusCode = 404; res.end('Not found'); return }
      res.setHeader('Content-Type', served.endsWith('.wasm') ? 'application/wasm' : 'application/gzip')
      res.end(readFileSync(path.join(entry.dir, served)))
    })
  }

  return {
    name: 'ecmaos:programs',
    configureServer: serve,
    configurePreviewServer: serve,
    generateBundle() {
      const packages = readProgramPackages()
      this.emitFile({ type: 'asset', fileName: 'programs/index.json', source: JSON.stringify(programCatalog(packages)) })
      for (const entry of packages) {
        for (const program of Object.values(entry.programs)) {
          this.emitFile({ type: 'asset', fileName: `programs/${entry.path}/${program.file}`, source: readFileSync(path.join(entry.dir, program.file)) })
          if (program.runtime) this.emitFile({ type: 'asset', fileName: `programs/${entry.path}/${program.runtime.file}`, source: readFileSync(path.join(entry.dir, program.runtime.file)) })
          // Serving a copyleft binary means offering its source from the same place: the archives it was built from go
          // out at `/sources/`. A build that cannot do that fails, rather than publish a site that breaks the offer.
          for (const source of program.sources ?? []) {
            const archive = path.join(entry.dir, '..', 'sources', source.archive)
            if (!existsSync(archive)) throw new Error(`${entry.name}: ${source.archive} is missing, so the source of ${program.file} cannot be served; run \`node scripts/sources.mjs all\` in the package (its build script does), or build without it with ECMAOS_COPYLEFT=0`)
            this.emitFile({ type: 'asset', fileName: `sources/${source.archive}`, source: readFileSync(archive) })
          }
        }
      }
    }
  }
}
