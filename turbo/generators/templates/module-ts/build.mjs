// Bundles src/index.ts into dist/NAME.ko.mjs: the modinfo from module.json as the header comment the kernel reads without
// running the module, then the code. With ECMAOS_MODULE_KEY set to a private key file (`node core/kernel/scripts/module-key.mjs DIR`
// makes one) the file is signed; unsigned, it loads with the E taint, as on Linux.
import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

import { signatureTrailer } from '../../core/kernel/scripts/module-sign.mjs'

const info = JSON.parse(readFileSync('module.json', 'utf8'))
const version = JSON.parse(readFileSync('package.json', 'utf8')).version

const header = [
  '/* ecmaos-module',
  ` * name=${info.name}`,
  ` * version=${info.version ?? version}`,
  ...(info.description ? [` * description=${info.description}`] : []),
  ...(info.license ? [` * license=${info.license}`] : []),
  ' * kernel_api=^1.0.0',
  ...(info.author ?? []).map(author => ` * author=${author}`),
  ...(info.depends?.length ? [` * depends=${info.depends.join(',')}`] : []),
  ...(info.alias ?? []).map(alias => ` * alias=${alias}`),
  ' */'
].join('\n')

const result = await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  write: false,
  legalComments: 'none',
  logLevel: 'silent'
})

mkdirSync('dist', { recursive: true })
const file = `dist/${info.name}.ko.mjs`
const body = `${header}\n${result.outputFiles[0].text}`
writeFileSync(file, process.env.ECMAOS_MODULE_KEY ? body + await signatureTrailer(body, process.env.ECMAOS_MODULE_KEY, process.env.ECMAOS_MODULE_SIGNER) : body)
console.log(`wrote ${file}`)
