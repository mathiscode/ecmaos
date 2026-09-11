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

const virtualModuleId = 'virtual:bin-node'
const resolvedVirtualModuleId = '\0' + virtualModuleId

export function binNode(): Plugin {
  let cached: string | undefined

  return {
    name: 'ecmaos:bin-node',
    resolveId(id) {
      if (id === virtualModuleId) return resolvedVirtualModuleId
    },
    async load(id) {
      if (id !== resolvedVirtualModuleId) return

      if (!cached) {
        const result = await build({
          entryPoints: ['src/bin/node.mjs'],
          bundle: true,
          format: 'esm',
          platform: 'browser',
          write: false,
          absWorkingDir: __dirname
        })

        const output = result.outputFiles[0]
        if (!output) throw new Error('bin-node: esbuild produced no output')
        cached = output.text
      }

      return `export default ${JSON.stringify(cached)}`
    }
  }
}
