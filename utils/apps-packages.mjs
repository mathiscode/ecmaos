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
//   node utils/apps-packages.mjs candidates            the permissive programs no Standard machine boots with: the ones to move first
//   node utils/apps-packages.mjs ready [--registry URL] [name...]
//                                                      whether each package (and a copyleft program's source package) is on the
//                                                      registry (npmjs by default) at the version built here, with `latest` on it:
//                                                      the check before a program is marked moved
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
import { createRequire } from 'node:module'
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

/**
 * The programs that are JavaScript, not WebAssembly: a kernel command bundled into one file and published as a package
 * of its own. `pip` is the one: its code is `core/kernel/src/bin/commands/lib/pip/`, and a package that needs Python
 * depends on `python3`, so installing pip installs Python. `moved` is the same switch a wasm program's manifest has
 * (`"package"`): while it is false the kernel still carries the command, and the index does not send its name to the
 * package. It is true now: the kernel has no `pip` of its own, and the name means this package.
 */
export const SCRIPTS = {
  pip: {
    entry: 'core/kernel/src/bin/commands/lib/pip/main.mjs',
    version: '25.3.0-ecmaos.3',
    description: 'pip, Python\'s package installer, on PyPI\'s wheels (pure-Python ones; it installs into python3\'s site-packages)',
    license: 'MIT OR Apache-2.0',
    homepage: 'https://ecmaos.sh',
    aliases: ['pip3'],
    dependencies: { [`${SCOPE}/python3`]: 'latest' },
    names: { apt: ['python3-pip'], pacman: ['python-pip'] },
    moved: true
  }
}

/** Every script: `{ name, script, package }` */
export const scripts = () => Object.entries(SCRIPTS).map(([name, script]) => ({ name, script, package: `${SCOPE}/${name}` }))

/** `package.json` of a script's package */
export function scriptManifestFor({ name, script }) {
  return {
    name: `${SCOPE}/${name}`,
    version: script.version,
    description: script.description,
    license: script.license,
    homepage: script.homepage,
    repository: { type: 'git', url: 'https://github.com/ecmaos/ecmaos', directory: 'core/kernel' },
    keywords: ['ecmaos', name, 'python'],
    type: 'module',
    bin: { [name]: `${name}.mjs`, ...Object.fromEntries(script.aliases.map(alias => [alias, `${name}.mjs`])) },
    files: [`${name}.mjs`, 'README.md'],
    os: ['ecmaos'],
    publishConfig: { access: 'public' },
    dependencies: script.dependencies,
    // the commands of what it depends on are wanted too: installing pip puts `python3` on the PATH
    ecmaos: { link: Object.keys(script.dependencies) }
  }
}

/** Writes `out/NAME/` for one script: the command and everything it imports, as one file */
export function buildScript(entry, out) {
  const { buildSync } = createRequire(path.join(root, 'core/kernel/package.json'))('esbuild')
  const directory = path.join(out, entry.name)
  mkdirSync(directory, { recursive: true })
  buildSync({ entryPoints: [path.join(root, entry.script.entry)], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', outfile: path.join(directory, `${entry.name}.mjs`), banner: { js: '#!/usr/bin/env node' }, logLevel: 'error' })
  const manifest = scriptManifestFor(entry)
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  writeFileSync(path.join(directory, 'README.md'), [
    `# ${manifest.name}`,
    '',
    `${entry.script.description}.`,
    '',
    `It depends on ${Object.keys(entry.script.dependencies).map(name => `\`${name}\``).join(', ')}, so installing it installs Python.`,
    '',
    '```sh',
    `sudo install -g ${manifest.name}   # or: apt install ${entry.script.names.apt?.[0] ?? entry.name}`,
    '```',
    ''
  ].join('\n'))
  return directory
}

/** An upstream version as semver: `1.22` is 1.22.0, `3.5a` is 3.5.0, `5.02` is 5.2.0 (the original stays in `ecmaos.upstream`) */
export function semverOf(version) {
  const match = String(version).match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
  if (!match) throw new Error(`${version} has no version number`)
  return match.slice(1, 4).map(part => Number(part ?? 0)).join('.')
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

/** The programs that are permissive and that Standard does not boot with: moving them leaves Standard whole */
export function candidates(found = programs()) {
  const { groups, profiles } = groupsOf(found)
  const standard = new Set([...profiles.standard.groups.flatMap(group => groups[group].members), ...(profiles.standard.packages ?? [])])
  return found.filter(entry => !entry.copyleft && !entry.program.package && !standard.has(entry.name)).map(entry => entry.name)
}

/** Whether each package is on the registry at the version built here and `latest` points at it: `[{ name, version, problem? }]` */
export async function readiness(registry, names = []) {
  const wanted = []
  for (const entry of programs()) {
    wanted.push({ name: entry.package, version: versionOf(entry.program), program: entry.name })
    if (entry.copyleft) wanted.push({ name: `${entry.package}-src`, version: versionOf(entry.program), program: entry.name })
  }
  for (const entry of scripts()) wanted.push({ name: entry.package, version: entry.script.version, program: entry.name })
  const chosen = wanted.filter(item => !names.length || names.includes(item.program))
  return Promise.all(chosen.map(async item => {
    try {
      const response = await fetch(`${registry.replace(/\/$/, '')}/${item.name.replace('/', '%2f')}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) })
      if (response.status === 404) return { ...item, problem: 'not published' }
      if (!response.ok) return { ...item, problem: `HTTP ${response.status}` }
      const packument = await response.json()
      if (!packument.versions?.[item.version]) return { ...item, problem: `no version ${item.version}` }
      if (packument['dist-tags']?.latest !== item.version) return { ...item, problem: `latest is ${packument['dist-tags']?.latest ?? 'unset'}, not ${item.version}` }
      return item
    } catch (error) { return { ...item, problem: error.message } }
  }))
}

/** The groups and profiles of `groups.json`, checked against the programs: every member is a program, and Everything has them all */
export function groupsOf(found = programs()) {
  const { groups, profiles } = read(GROUPS)
  const known = new Set([...found.map(entry => entry.name), ...Object.keys(SCRIPTS)])
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
  for (const { name, script } of scripts()) {
    commands[name] = name
    for (const alias of script.aliases) commands[alias] = name
  }
  for (const [name, entry] of Object.entries(extra)) {
    if (JSON.stringify(index.common[name]) === JSON.stringify(entry)) continue
    index.common[name] = entry
    changed++
  }
  if (index.schema !== 2 || JSON.stringify(index.commands) !== JSON.stringify(commands)) { index.schema = 2; index.commands = commands; changed++ }
  // the definitions `profile` works from, without the registry
  const definitions = { groups: Object.fromEntries(Object.entries(groups).map(([name, group]) => [name, { description: group.description, ...(group.category ? { category: group.category } : {}), members: group.members }])), profiles: Object.fromEntries(Object.entries(profiles).map(([name, profile]) => [name, { description: profile.description, groups: profile.groups, ...(profile.packages ? { packages: profile.packages } : {}) }])) }
  // what the Software browser shows of each program without asking the registry
  definitions.programs = Object.fromEntries([
    ...all.map(entry => [entry.name, { package: entry.package, description: entry.program.description, license: entry.program.license, homepage: entry.program.homepage, size: entry.program.size, kind: 'wasm', ...(entry.copyleft ? { source: `${entry.package}-src` } : {}), ...(entry.program.runtime ? { system: true } : {}) }]),
    ...scripts().map(({ name, script, package: packageName }) => [name, { package: packageName, description: script.description, license: script.license, homepage: script.homepage, kind: 'script', ...(script.system ? { system: true } : {}) }])
  ].sort(([a], [b]) => a.localeCompare(b)))
  for (const [key, value] of Object.entries(definitions)) {
    if (JSON.stringify(index[key]) === JSON.stringify(value)) continue
    index[key] = value
    changed++
  }
  for (const [name, entry] of Object.entries(wanted)) {
    if (JSON.stringify(index.common[name]) === JSON.stringify(entry)) continue
    index.common[name] = entry
    changed++
  }
  // a script that moved: its name, and the other distributions' names for it, mean the package
  for (const { name, script, package: packageName } of scripts()) {
    if (!script.moved) continue
    const entry = { package: packageName, description: script.description }
    if (JSON.stringify(index.common[name]) !== JSON.stringify(entry)) { index.common[name] = entry; changed++ }
    for (const [section, others] of Object.entries(script.names)) {
      for (const other of others) if (index[section][other] !== name) { index[section][other] = name; changed++ }
    }
  }
  if (changed) writeFileSync(INDEX, JSON.stringify(index, null, 2) + '\n')
  return changed
}

const main = async () => {
  const [command, ...rest] = process.argv.slice(2)
  if (command === 'build') {
    const [out, ...names] = rest
    if (!out) throw new Error('usage: apps-packages.mjs build OUT [name...]')
    const all = programs()
    const chosen = names.length ? names.filter(name => !SCRIPTS[name]).map(name => all.find(entry => entry.name === name) ?? (() => { throw new Error(`no program named ${name}`) })()) : all
    for (const entry of chosen) console.log(build(entry, path.resolve(out)))
    for (const entry of scripts().filter(candidate => !names.length || names.includes(candidate.name))) console.log(buildScript(entry, path.resolve(out)))
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
    for (const entry of scripts()) console.log(`${entry.package}@${entry.script.version}${entry.script.moved ? ' (moved)' : ''}`)
  } else if (command === 'candidates') {
    console.log(candidates().join('\n'))
  } else if (command === 'ready') {
    const at = rest.indexOf('--registry')
    const registry = at >= 0 ? rest.splice(at, 2)[1] : 'https://registry.npmjs.org'
    const results = await readiness(registry, rest)
    for (const item of results) console.log(`${item.problem ? 'no ' : 'ok '} ${item.name}@${item.version}${item.problem ? `: ${item.problem}` : ''}`)
    const missing = results.filter(item => item.problem)
    console.log(`${results.length - missing.length} of ${results.length} ready at ${registry}`)
    if (missing.length) process.exit(1)
  } else {
    throw new Error('usage: apps-packages.mjs build OUT [name...] | groups OUT | check | index | list | candidates | ready [--registry URL] [name...]')
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) main()
