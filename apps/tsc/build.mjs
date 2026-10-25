// Bundles src/tsc.mjs into dist/tsc.mjs, one file with no imports (a program cannot import anything). It has no
// shebang: a JavaScript file without one is run by /bin/node, as the coreutils are. The version of
// @tsrs/wasm is written in, because `install` puts that package at /usr/lib/@tsrs/wasm/<version> and tsc reads the
// compiler from there.
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const { version } = createRequire(import.meta.url)('@tsrs/wasm/package.json')

await build({
  entryPoints: ['src/tsc.mjs'],
  outfile: 'dist/tsc.mjs',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  define: { TSRS_VERSION: JSON.stringify(version) }
})
