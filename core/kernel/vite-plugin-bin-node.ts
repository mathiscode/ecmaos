/**
 * Bundles `src/bin/node.mjs` -- ecmaOS's real `/bin/node` interpreter, see that file's own doc
 * comment for why it must ship with zero import statements -- into a virtual module exporting its
 * bundled source as a string, importable as `virtual:bin-node`.
 *
 * Runs at dev, build, and test time alike (all three load this same `vite.config.ts`), so
 * `Filesystem`'s boot-time write of `/bin/node` sees the same real bundle everywhere, not a stub.
 */

import { build } from 'esbuild'
import type { Plugin } from 'vite'
import path from 'node:path'
import { createRequire } from 'node:module'

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
          absWorkingDir: __dirname
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
 * Bundles `src/bin/wali.mjs` -- ecmaOS's `/bin/wali` interpreter for WALI-format WebAssembly
 * modules -- into `virtual:bin-wali`, the same way `binNode` does for `/bin/node`.
 */
export function binWali(): Plugin {
  return binWorkerPlugin('wali', 'src/bin/wali.mjs')
}

/**
 * Bundles `src/bin/pilot-pwd.mjs` -- the real, syscall-only coreutil pilot proving `execve` plus
 * `Kernel.bridgeStdio` work together -- into `virtual:bin-pilot-pwd`, the same way `binNode` does.
 */
export function binPilotPwd(): Plugin {
  return binWorkerPlugin('pilot-pwd', 'src/bin/pilot-pwd.mjs')
}

/**
 * Bundles `src/bin/pilot-window.mjs` -- the pilot proving the `window_create`/`window_write`/
 * `window_close` main-thread-syscall bridge works end to end -- into `virtual:bin-pilot-window`.
 */
export function binPilotWindow(): Plugin {
  return binWorkerPlugin('pilot-window', 'src/bin/pilot-window.mjs')
}

/**
 * The coreutils migrated onto real `execve` so far (`feat/1.0.0-execve-commands`) -- each a real,
 * worker-hosted, syscall-only program living in `@ecmaos/coreutils` (`core/utils/src/commands-
 * execve/<name>.mjs`), replacing that command's entry in `Kernel.executeCommand`'s legacy dispatch.
 * Keyed by the real command name (`/bin/<name>`), since that's the path `Kernel.registerCommands`/
 * `readFileHeader` resolve.
 *
 * These live in `@ecmaos/coreutils`, not here, on purpose: they're coreutils content (the actual
 * `echo`/`rm`/`cp`/... business logic, mirroring `core/utils/src/commands/*.ts`'s existing legacy
 * versions), and `@ecmaos/kernel` should own only the *mechanism* (esbuild bundling, `execve`,
 * syscalls) -- not accumulate a second, shadow copy of the coreutils package as more commands
 * migrate. `@ecmaos/kernel` already depends on `@ecmaos/coreutils` (for `TerminalCommands`), so this
 * adds no new dependency edge, just a second thing consumed from it.
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
  'fmt', 'crypto', 'curl', 'fetch'
] as const

/**
 * The kernel-native commands migrated onto real `execve` so far -- unlike `migratedCommands` above,
 * these live in `@ecmaos/kernel` itself (`src/bin/commands/<name>.mjs`), not `@ecmaos/coreutils`,
 * because their real logic needs a kernel-only custom syscall (`storage_usage`/`ps_list`/`reboot` --
 * see `#lib/main-thread-syscalls.ts`) rather than the plain filesystem/stdio syscalls every
 * `@ecmaos/coreutils` execve program uses. Everything else about them is identical: a real,
 * worker-hosted, syscall-only program replacing that name's entry in `Kernel.executeCommand`'s
 * legacy dispatch.
 */
export const migratedKernelCommands = ['clear', 'df', 'ps', 'reboot', 'uninstall'] as const

/** Resolves once: the real, on-disk directory `@ecmaos/coreutils`'s `commands-execve/` sources live in. */
function coreutilsExecveDir(): string {
  const require = createRequire(import.meta.url)
  // `@ecmaos/coreutils`'s package.json is the one stable resolution anchor -- resolving straight to
  // a source file would need every consumer to know its exports map shape; resolving the package
  // root and joining the known subdirectory works the same whether this is a workspace symlink (as
  // in this monorepo, via pnpm) or a real installed dependency.
  const pkgJsonPath = require.resolve('@ecmaos/coreutils/package.json')
  return path.join(path.dirname(pkgJsonPath), 'src', 'commands-execve')
}

/**
 * Bundles every migrated coreutil's real program (`@ecmaos/coreutils`'s `commands-execve/<name>.mjs`)
 * into one virtual module, `virtual:bin-commands`, exporting `{ [name]: string }` -- the same shape
 * as `TerminalCommands`' own name-keyed map, so `Kernel.registerCommands` can look a migrated name up
 * directly.
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
 * one virtual module, `virtual:bin-kernel-commands`, exporting `{ [name]: string }` -- the same shape
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
            entryPoints: [path.join(__dirname, 'src', 'bin', 'commands', `${name}.mjs`)],
            bundle: true,
            format: 'esm',
            platform: 'browser',
            write: false,
            absWorkingDir: __dirname
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
