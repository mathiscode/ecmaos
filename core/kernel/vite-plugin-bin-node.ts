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
