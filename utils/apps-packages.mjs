#!/usr/bin/env node
// Turns the prebuilt WebAssembly programs of `@ecmaos/coreutils` and `@ecmaos/coreutils-copyleft` into npm packages
// under the `@ecmaos-apps` scope, which `install` (and so `apt`, `pacman`) installs like any other package.
//
//   node utils/apps-packages.mjs build OUT [name...]   write OUT/NAME/ for the named programs (all if none): package.json,
//                                                      NAME.wasm, a README, and the runtime files unpacked
//   node utils/apps-packages.mjs index                 add an index entry (utils/package-index) for each program a
//                                                      manifest marks as moved: `"package": "@ecmaos-apps/NAME"`
//   node utils/apps-packages.mjs list                  every program, with its package name, version and whether it moved
//
// A program moves out of the boot catalog by gaining `"package": "@ecmaos-apps/NAME"` in its `programs/manifest.json`:
// the kernel's catalog leaves it out, and `index` makes `apt install NAME` mean the package. Publishing the packages is
// a separate step (`npm publish` in each directory `build` wrote), and must happen before a program is marked moved.
import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const SOURCES = [
  { dir: path.join(root, 'core/utils'), copyleft: false },
  { dir: path.join(root, 'core/utils-copyleft'), copyleft: true }
]
const INDEX = path.join(root, 'utils/package-index/index.json')
export const SCOPE = '@ecmaos-apps'

const read = file => JSON.parse(readFileSync(file, 'utf8'))

/** Every program of every package: `{ name, program, dir, package }` (`package` is `@ecmaos-apps/NAME`) */
export function programs() {
  const found = []
  for (const source of SOURCES) {
    const dir = path.join(source.dir, 'programs')
    if (!existsSync(path.join(dir, 'manifest.json'))) continue
    const manifest = read(path.join(dir, 'manifest.json'))
    for (const [name, program] of Object.entries(manifest.programs)) found.push({ name, program, dir, manifest, package: `${SCOPE}/${name}` })
  }
  return found
}

/** An upstream version as semver: `1.22` is 1.22.0, `3.5a` is 3.5.0 (the original stays in `ecmaos.upstream`) */
export function semverOf(version) {
  const match = String(version).match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
  if (!match) throw new Error(`${version} has no version number`)
  return `${match[1]}.${match[2] ?? 0}.${match[3] ?? 0}`
}

/** `package.json` of a program's package */
export function manifestFor({ name, program, manifest }) {
  const runtime = program.runtime ? 'runtime' : undefined
  return {
    name: `${SCOPE}/${name}`,
    version: semverOf(program.version),
    description: program.description,
    license: program.license,
    homepage: program.homepage,
    repository: { type: 'git', url: 'https://github.com/ecmaos/ecmaos', directory: `core/${manifest.package === '@ecmaos/coreutils-copyleft' ? 'utils-copyleft' : 'utils'}` },
    keywords: ['ecmaos', 'wasm', name],
    type: 'module',
    bin: { [name]: program.file },
    files: [program.file, ...(runtime ? [runtime] : []), 'share', 'README.md'],
    os: ['ecmaos'],
    cpu: ['wasm32'],
    publishConfig: { access: 'public' },
    ecmaos: { ...(runtime ? { runtime } : {}), upstream: program.version, ...(program.toolchain ? { toolchain: program.toolchain } : {}), sha256: program.sha256 }
  }
}

/** Writes `out/NAME/` for one program */
export function build(entry, out) {
  const directory = path.join(out, entry.name)
  mkdirSync(directory, { recursive: true })
  const manifest = manifestFor(entry)
  copyFileSync(path.join(entry.dir, entry.program.file), path.join(directory, entry.program.file))
  if (entry.program.runtime) {
    const runtime = path.join(directory, 'runtime')
    mkdirSync(runtime, { recursive: true })
    // the tarball is rooted at `/`
    execFileSync('tar', ['-xzf', path.join(entry.dir, entry.program.runtime.file), '-C', runtime])
  }
  // the license texts go where `/usr/share/licenses` is looked in
  const texts = path.join(entry.dir, '..', 'licenses', entry.name)
  if (existsSync(texts)) cpSync(texts, path.join(directory, 'share/licenses', entry.name), { recursive: true })
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  writeFileSync(path.join(directory, 'README.md'), [
    `# ${manifest.name}`,
    '',
    `${entry.program.description}, built for ecmaOS as WebAssembly (upstream ${entry.program.version}, ${entry.program.license}).`,
    '',
    '```sh',
    `sudo install -g ${manifest.name}   # or: apt install ${entry.name}`,
    '```',
    '',
    `Upstream: ${entry.program.homepage}`,
    ''
  ].join('\n'))
  return directory
}

/** The index entries the moved programs need: `{ NAME: { package, description } }` */
export function indexEntries(found = programs()) {
  return Object.fromEntries(found.filter(({ program }) => program.package).map(({ name, program }) => [name, { package: program.package, description: program.description }]))
}

function updateIndex() {
  const index = read(INDEX)
  const wanted = indexEntries()
  let changed = 0
  for (const [name, entry] of Object.entries(wanted)) {
    if (JSON.stringify(index.common[name]) === JSON.stringify(entry)) continue
    index.common[name] = entry
    changed++
  }
  if (changed) writeFileSync(INDEX, JSON.stringify(index, null, 2) + '\n')
  return changed
}

const main = () => {
  const [command, ...rest] = process.argv.slice(2)
  if (command === 'build') {
    const [out, ...names] = rest
    if (!out) throw new Error('usage: apps-packages.mjs build OUT [name...]')
    const all = programs()
    const chosen = names.length ? names.map(name => all.find(entry => entry.name === name) ?? (() => { throw new Error(`no program named ${name}`) })()) : all
    for (const entry of chosen) console.log(build(entry, path.resolve(out)))
  } else if (command === 'index') {
    console.log(`${updateIndex()} index entries written`)
  } else if (command === 'list') {
    for (const entry of programs()) console.log(`${entry.package}@${semverOf(entry.program.version)}${entry.program.package ? ' (moved)' : ''}`)
  } else {
    throw new Error('usage: apps-packages.mjs build OUT [name...] | index | list')
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) main()
