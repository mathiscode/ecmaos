// Copies the license texts of the @zenfs/* packages ecmaOS bundles into the initfs, with a COPYRIGHT.txt for each,
// so the notices they ask for travel with the running system. Run by `pnpm sync:licenses`.
import { cpSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const kernelDir = path.join(root, 'core/kernel')
const target = path.join(kernelDir, 'public/initfs/usr/share/licenses/@zenfs')
const packages = ['core', 'archives', 'cloud', 'dom', 'emscripten', 'linux']

const packageDir = name => realpathSync(path.join(kernelDir, 'node_modules/@zenfs', name))
for (const name of packages) {
  const from = packageDir(name)
  const manifest = JSON.parse(readFileSync(path.join(from, 'package.json'), 'utf8'))
  const to = path.join(target, name)
  rmSync(to, { recursive: true, force: true })
  mkdirSync(to, { recursive: true })
  for (const file of ['LICENSE.md', 'COPYING.md']) cpSync(path.join(from, file), path.join(to, file))
  writeFileSync(
    path.join(to, 'COPYRIGHT.txt'),
    `@zenfs/${name} ${manifest.version}, ${manifest.license}, Copyright © James Prevett and other ZenFS contributors\n` +
    `https://github.com/zen-fs/${name}\n`
  )
  console.log(`@zenfs/${name}@${manifest.version}`)
}
