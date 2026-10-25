// Copies the license texts of the LGPL packages ecmaOS bundles (the @zenfs/* packages and the two libraries by the same
// author they are built on, utilium and memium) into the initfs, with a COPYRIGHT.txt for each, so the notices they ask
// for travel with the running system. The same texts go beside the two other things that carry the libraries away from the
// site, the Node host (which has them bundled into dist/ecmaos.mjs) and the Tauri desktop app. Run by `pnpm sync:licenses`.
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const kernelDir = path.join(root, 'core/kernel')
const licenses = path.join(kernelDir, 'public/initfs/usr/share/licenses')

// `dir` is where the texts go under /usr/share/licenses; `repo` is where the package lives. Only the @zenfs/*
// packages carry COPYING.md (the exception for web applications); utilium and memium are the plain LGPL.
const packages = [
  ...['core', 'archives', 'cloud', 'dom', 'emscripten', 'linux', 'streams'].map(name => ({ name: `@zenfs/${name}`, dir: `@zenfs/${name}`, repo: `zen-fs/${name}` })),
  { name: 'utilium', dir: 'utilium', repo: 'james-pre/utilium' },
  { name: 'memium', dir: 'memium', repo: 'james-pre/memium' }
]

// The kernel depends on most of them directly; @zenfs/streams, utilium and memium come in through @zenfs/core, so they are
// found from there, in whichever version pnpm installed for it
const fromCore = createRequire(path.join(realpathSync(path.join(kernelDir, 'node_modules/@zenfs/core')), 'package.json'))
const packageDir = name => {
  const direct = path.join(kernelDir, 'node_modules', name)
  if (existsSync(direct)) return realpathSync(direct)
  let dir = path.dirname(fromCore.resolve(name))
  while (!existsSync(path.join(dir, 'package.json')) || JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).name !== name) dir = path.dirname(dir)
  return dir
}

for (const { name, dir, repo } of packages) {
  const from = packageDir(name)
  const manifest = JSON.parse(readFileSync(path.join(from, 'package.json'), 'utf8'))
  const to = path.join(licenses, dir)
  rmSync(to, { recursive: true, force: true })
  mkdirSync(to, { recursive: true })
  for (const file of ['LICENSE.md', 'COPYING.md']) if (existsSync(path.join(from, file))) cpSync(path.join(from, file), path.join(to, file))
  writeFileSync(
    path.join(to, 'COPYRIGHT.txt'),
    `${name} ${manifest.version}, ${manifest.license}, Copyright © James Prevett and other ${name.startsWith('@zenfs/') ? 'ZenFS ' : ''}contributors\n` +
    `https://github.com/${repo}\n`
  )
  console.log(`${name}@${manifest.version}`)
}

// What a distribution that is not a web application ships: the library texts, and ecmaOS's own
for (const target of ['core/node/licenses', 'core/jaffa/src-tauri/licenses']) {
  const to = path.join(root, target)
  rmSync(to, { recursive: true, force: true })
  for (const { dir } of packages) cpSync(path.join(licenses, dir), path.join(to, dir), { recursive: true })
  cpSync(path.join(licenses, '@zenfs/README.md'), path.join(to, '@zenfs/README.md'))
  for (const name of ['LICENSE', 'LICENSE-APACHE', 'LICENSE-MIT']) cpSync(path.join(root, name), path.join(to, 'ecmaos', name))
}
