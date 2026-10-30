#!/usr/bin/env node
// Turns the prebuilt WebAssembly programs of `@ecmaos/coreutils` and `@ecmaos/coreutils-copyleft` into npm packages
// under the `@ecmaos-apps` scope, which `install` (and so `apt`, `pacman`) installs like any other package.
//
//   node utils/apps-packages.mjs build OUT [name...]   write OUT/NAME/ for the named programs (all if none): package.json,
//                                                      NAME.wasm, a README, and the runtime files unpacked
//   node utils/apps-packages.mjs check                 every copyleft program has its source package: archives present and
//                                                      matching their sha256, and the build recipe
//   node utils/apps-packages.mjs index                 add an index entry (utils/package-index) for each program a
//                                                      manifest marks as moved: `"package": "@ecmaos-apps/NAME"`
//   node utils/apps-packages.mjs groups OUT           write OUT/group-NAME/ and OUT/profile-NAME/: the meta-packages of
//                                                      utils/package-index/groups.json
//   node utils/apps-packages.mjs list                  every program, with its package name, version and whether it moved
//
// A program moves out of the boot catalog by gaining `"package": "@ecmaos-apps/NAME"` in its `programs/manifest.json`:
// the kernel's catalog leaves it out, and `index` makes `apt install NAME` mean the package. Publishing the packages is
// a separate step (`npm publish` in each directory `build` wrote), and must happen before a program is marked moved.
//
// A copyleft program's package is published with a source package of the same version, `@ecmaos-apps/NAME-src`: the
// upstream archives, our patches and the build recipe, which is the Corresponding Source of the `.wasm`. The binary
// package names it (`ecmaos.source`); `build` refuses a copyleft program whose source it cannot assemble.
//
// A version is the upstream's as semver plus ecmaOS's revision of the build, `X.Y.Z-ecmaos.N` (`revision` in the
// manifest entry, 1 when absent): a rebuild with a changed patch is a new version of both packages.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const SOURCES = [
  { dir: path.join(root, 'core/utils'), copyleft: false },
  { dir: path.join(root, 'core/utils-copyleft'), copyleft: true }
]
const INDEX = path.join(root, 'utils/package-index/index.json')
const GROUPS = path.join(root, 'utils/package-index/groups.json')
const FS_MODES = path.join(root, 'core/kernel/src/tree/lib/fs-modes.ts')
export const SCOPE = '@ecmaos-apps'

const read = file => JSON.parse(readFileSync(file, 'utf8'))

/** Every program of every package: `{ name, program, dir, package }` (`package` is `@ecmaos-apps/NAME`) */
export function programs() {
  const found = []
  for (const source of SOURCES) {
    const dir = path.join(source.dir, 'programs')
    if (!existsSync(path.join(dir, 'manifest.json'))) continue
    const manifest = read(path.join(dir, 'manifest.json'))
    for (const [name, program] of Object.entries(manifest.programs)) {
      if (name.endsWith('-src')) throw new Error(`${name}: a program cannot be named *-src, which is for source packages`)
      found.push({ name, program, dir, manifest, package: `${SCOPE}/${name}`, copyleft: source.copyleft, root: source.dir })
    }
  }
  return found
}

/** An upstream version as semver: `1.22` is 1.22.0, `3.5a` is 3.5.0 (the original stays in `ecmaos.upstream`) */
export function semverOf(version) {
  const match = String(version).match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
  if (!match) throw new Error(`${version} has no version number`)
  return `${match[1]}.${match[2] ?? 0}.${match[3] ?? 0}`
}

/** A program's package version: the upstream's as semver, then ecmaOS's revision of the build */
export const versionOf = program => `${semverOf(program.version)}-ecmaos.${program.revision ?? 1}`

/** The names the kernel links to a program (`unxz` to `xz`): `{ NAME: [alias...] }`, read from `CommandLinks` */
export function aliasesOf() {
  const source = readFileSync(FS_MODES, 'utf8')
  const block = source.slice(source.indexOf('export const CommandLinks'), source.indexOf('}', source.indexOf('export const CommandLinks')))
  const found = {}
  for (const [, link, target] of block.matchAll(/'\/bin\/([^']+)':\s*'\/bin\/([^']+)'/g)) (found[target] ??= []).push(link)
  return found
}

/** `package.json` of a program's package */
export function manifestFor({ name, program, manifest, copyleft }) {
  const runtime = program.runtime ? 'runtime' : undefined
  return {
    name: `${SCOPE}/${name}`,
    version: versionOf(program),
    description: program.description,
    license: program.license,
    homepage: program.homepage,
    repository: { type: 'git', url: 'https://github.com/ecmaos/ecmaos', directory: `core/${manifest.package === '@ecmaos/coreutils-copyleft' ? 'utils-copyleft' : 'utils'}` },
    keywords: ['ecmaos', 'wasm', name],
    type: 'module',
    bin: { [name]: program.file, ...Object.fromEntries((aliasesOf()[name] ?? []).map(alias => [alias, program.file])) },
    files: [program.file, ...(runtime ? [runtime] : []), 'share', 'README.md'],
    os: ['ecmaos'],
    cpu: ['wasm32'],
    publishConfig: { access: 'public' },
    ecmaos: { requires: { features: program.toolchain === 'wali' ? ['wasm', 'wali'] : ['wasm'] }, ...(runtime ? { runtime } : {}), ...(copyleft ? { source: `${SCOPE}/${name}-src@${versionOf(program)}` } : {}), upstream: program.version, ...(program.toolchain ? { toolchain: program.toolchain } : {}), sha256: program.sha256 }
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
    ...(entry.copyleft ? [
      '',
      `## Source`,
      '',
      `${entry.program.license}. The Corresponding Source of this package (the upstream archives, our patches and the build recipe) is the package \`${SCOPE}/${entry.name}-src\`, version ${versionOf(entry.program)}, on the registry this package came from:`,
      '',
      '```sh',
      `apt source ${entry.name}      # or: install ${SCOPE}/${entry.name}-src`,
      '```',
      '',
      'Anyone who passes this package on, or mirrors it, must pass on or mirror the source package with it.'
    ] : []),
    ''
  ].join('\n'))
  if (entry.copyleft) buildSource(entry, out)
  return directory
}

const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex')

/** The directory under `wasm/` that holds the recipe for a program: its own, else its first source's (`aplay` is built with alsa-utils) */
function recipeOf(entry) {
  const wasm = path.join(entry.root, 'wasm')
  for (const name of [entry.name, ...[...(entry.program.sources ?? [])].reverse().map(source => source.name)]) {
    if (existsSync(path.join(wasm, name))) return path.join(wasm, name)
  }
  throw new Error(`${entry.name}: no build recipe under ${wasm}`)
}

/**
 * What a copyleft program's source package holds, checked: `{ archives: [{ file, sha256 }], recipe }`. Throws when an
 * archive is missing or is not the one the manifest pins, or the recipe is not there.
 */
export function sourceFor(entry) {
  const sources = entry.program.sources ?? []
  if (!sources.length) throw new Error(`${entry.name}: copyleft, and the manifest lists no sources`)
  const archives = sources.map(source => {
    const file = path.join(entry.root, 'sources', source.archive)
    if (!existsSync(file)) throw new Error(`${entry.name}: ${source.archive} is missing (node core/utils-copyleft/scripts/sources.mjs all fetches it)`)
    if (sha256(file) !== source.sha256) throw new Error(`${entry.name}: ${source.archive} does not match the sha256 the manifest pins`)
    return { file, name: source.archive, sha256: source.sha256, source }
  })
  return { archives, recipe: recipeOf(entry) }
}

/** `package.json` of a program's source package */
export function sourceManifestFor(entry) {
  return {
    name: `${SCOPE}/${entry.name}-src`,
    version: versionOf(entry.program),
    description: `The source of ${SCOPE}/${entry.name}: ${entry.program.description}`,
    license: entry.program.license,
    homepage: entry.program.homepage,
    repository: { type: 'git', url: 'https://github.com/ecmaos/ecmaos', directory: 'core/utils-copyleft' },
    keywords: ['ecmaos', 'source', entry.name],
    files: ['sources', 'build', 'toolchain', 'share', 'README.md'],
    publishConfig: { access: 'public' },
    ecmaos: { sourceOf: `${SCOPE}/${entry.name}@${versionOf(entry.program)}`, archives: Object.fromEntries((entry.program.sources ?? []).map(source => [source.archive, { sha256: source.sha256, url: source.url, license: source.license }])) }
  }
}

/** Writes `out/NAME-src/`: the upstream archives, the build recipe, and the toolchain's patches and pins */
export function buildSource(entry, out) {
  const { archives, recipe } = sourceFor(entry)
  const directory = path.join(out, `${entry.name}-src`)
  mkdirSync(path.join(directory, 'sources'), { recursive: true })
  for (const archive of archives) copyFileSync(archive.file, path.join(directory, 'sources', archive.name))
  cpSync(recipe, path.join(directory, 'build'), { recursive: true })
  const toolchain = path.join(directory, 'toolchain')
  mkdirSync(toolchain, { recursive: true })
  for (const pin of ['wali-version', 'emscripten-version', 'rust-wali-version']) if (existsSync(path.join(root, 'utils', pin))) copyFileSync(path.join(root, 'utils', pin), path.join(toolchain, pin))
  if (entry.program.toolchain === 'wali') cpSync(path.join(root, 'utils/wali'), path.join(toolchain, 'wali'), { recursive: true })
  const texts = path.join(entry.root, 'licenses', entry.name)
  if (existsSync(texts)) cpSync(texts, path.join(directory, 'share/licenses', entry.name), { recursive: true })
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify(sourceManifestFor(entry), null, 2) + '\n')
  writeFileSync(path.join(directory, 'README.md'), [
    `# ${SCOPE}/${entry.name}-src`,
    '',
    `The Corresponding Source of \`${SCOPE}/${entry.name}\` ${versionOf(entry.program)} (${entry.program.license}): everything needed to build the \`${entry.program.file}\` it ships.`,
    '',
    '- `sources/` - the upstream archives, each checked against the sha256 in `package.json` (`ecmaos.archives`)',
    '- `build/` - the scripts that turn them into the program (our changes to the source are in them)',
    '- `toolchain/` - the pins of the compiler and libc the program is built with' + (entry.program.toolchain === 'wali' ? ', and the patches to WALI\'s musl and compiler-rt (`wali/`)' : ''),
    '',
    `Installed with \`apt source ${entry.name}\` or \`install ${SCOPE}/${entry.name}-src\`.`,
    ''
  ].join('\n'))
  return directory
}

/** The index entries the moved programs need: `{ NAME: { package, description } }` */
export function indexEntries(found = programs()) {
  return Object.fromEntries(found.filter(({ program }) => program.package).map(({ name, program }) => [name, { package: program.package, description: program.description }]))
}

/** The groups and profiles of `groups.json`, checked against the programs: every member is a program, and Everything has them all */
export function groupsOf(found = programs()) {
  const { groups, profiles } = read(GROUPS)
  const known = new Set(found.map(entry => entry.name))
  for (const [name, group] of Object.entries(groups)) for (const member of group.members) if (!known.has(member)) throw new Error(`group ${name}: ${member} is not a program`)
  for (const [name, profile] of Object.entries(profiles)) {
    for (const group of profile.groups) if (!groups[group]) throw new Error(`profile ${name}: no group ${group}`)
    for (const member of profile.packages ?? []) if (!known.has(member)) throw new Error(`profile ${name}: ${member} is not a program`)
  }
  const covered = new Set(profiles.everything.groups.flatMap(group => groups[group].members))
  const missing = [...known].filter(name => !covered.has(name))
  if (missing.length) throw new Error(`the everything profile leaves out ${missing.join(', ')}`)
  return { groups, profiles }
}

/** `package.json` of a group (`group-NAME`) or a profile (`profile-NAME`): a meta-package of dependencies on `latest` */
export function groupManifest(kind, name, { description, category, members }) {
  return {
    name: `${SCOPE}/${kind}-${name}`,
    version: '1.0.0',
    description,
    license: 'MIT OR Apache-2.0',
    homepage: 'https://ecmaos.sh',
    repository: { type: 'git', url: 'https://github.com/ecmaos/ecmaos', directory: 'utils/package-index' },
    keywords: ['ecmaos', 'meta-package', name],
    files: ['README.md'],
    publishConfig: { access: 'public' },
    dependencies: Object.fromEntries(members.map(member => [member.startsWith('@') ? member : `${SCOPE}/${member}`, 'latest'])),
    ecmaos: { meta: true, ...(category ? { category } : {}) }
  }
}

/** Writes `out/group-NAME/` and `out/profile-NAME/` for every group and profile */
export function buildGroups(out) {
  const { groups, profiles } = groupsOf()
  const written = []
  const write = (kind, name, entry) => {
    const manifest = groupManifest(kind, name, entry)
    const directory = path.join(out, `${kind}-${name}`)
    mkdirSync(directory, { recursive: true })
    writeFileSync(path.join(directory, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
    writeFileSync(path.join(directory, 'README.md'), [`# ${manifest.name}`, '', `${entry.description}.`, '', 'It installs:', '', ...Object.keys(manifest.dependencies).map(dependency => `- ${dependency}`), '', '```sh', `sudo install -g ${manifest.name}`, '```', ''].join('\n'))
    written.push(directory)
  }
  for (const [name, group] of Object.entries(groups)) write('group', name, group)
  for (const [name, profile] of Object.entries(profiles)) write('profile', name, { description: profile.description, members: [...(profile.packages ?? []), ...profile.groups.map(group => `${SCOPE}/group-${group}`)] })
  return written
}

function updateIndex() {
  const index = read(INDEX)
  const wanted = indexEntries()
  let changed = 0
  // schema 2 (additive): the command each program's package provides, and the groups and profiles
  const all = programs()
  const { groups, profiles } = groupsOf(all)
  const commands = {}
  for (const entry of all) {
    commands[entry.name] = entry.name
    for (const alias of aliasesOf()[entry.name] ?? []) commands[alias] = entry.name
  }
  const extra = { ...Object.fromEntries(Object.entries(groups).map(([name, group]) => [name, { package: `${SCOPE}/group-${name}`, description: group.description, meta: true }])),
    ...Object.fromEntries(Object.entries(profiles).map(([name, profile]) => [`ecmaos-${name}`, { package: `${SCOPE}/profile-${name}`, description: profile.description, meta: true }])) }
  for (const [name, entry] of Object.entries(extra)) {
    if (JSON.stringify(index.common[name]) === JSON.stringify(entry)) continue
    index.common[name] = entry
    changed++
  }
  if (index.schema !== 2 || JSON.stringify(index.commands) !== JSON.stringify(commands)) { index.schema = 2; index.commands = commands; changed++ }
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
  } else if (command === 'groups') {
    if (!rest[0]) throw new Error('usage: apps-packages.mjs groups OUT')
    for (const directory of buildGroups(path.resolve(rest[0]))) console.log(directory)
  } else if (command === 'check') {
    groupsOf()
    let problems = 0
    for (const entry of programs().filter(candidate => candidate.copyleft)) {
      try { sourceFor(entry) } catch (error) { console.error(error.message); problems++ }
    }
    if (problems) process.exit(1)
    console.log('every copyleft program has its source')
  } else if (command === 'list') {
    for (const entry of programs()) {
      console.log(`${entry.package}@${versionOf(entry.program)}${entry.program.package ? ' (moved)' : ''}`)
      if (entry.copyleft) console.log(`${entry.package}-src@${versionOf(entry.program)}`)
    }
  } else {
    throw new Error('usage: apps-packages.mjs build OUT [name...] | groups OUT | check | index | list')
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) main()
