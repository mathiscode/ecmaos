// Bundles src/index.ts into dist/NAME.ko.mjs: the modinfo from module.json as the header comment the kernel reads without
// running the module, then the code. Sign it with `sign-module` (or leave it unsigned; it loads tainted, as Linux does).
import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

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
writeFileSync(file, `${header}\n${result.outputFiles[0].text}`)
console.log(`wrote ${file}`)
