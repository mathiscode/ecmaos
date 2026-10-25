/** List the licenses of what this system is made of, and print their texts, from `/usr/share/licenses`. */

import { readTextFile } from './lib/fs-text.mjs'

const { argv, exit, writeAll, readdir } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(text + '\n'))

const root = '/usr/share/licenses'

const usage = `Usage: licenses [NAME...]
List the licenses of the software ecmaOS is made of, or print the license texts of NAME.

  -h, --help         display this help and exit

With no NAME, lists ecmaOS itself, the libraries it is built on (ZenFS, utilium and memium, LGPL-3.0-or-later) and the
programs it ships (@ecmaos/coreutils and @ecmaos/coreutils-copyleft), each with its license. NAME is one of those names
(zenfs/core, utilium, bash, jq, ...) and prints every text and notice kept for it, including the written offer of source
for a copyleft program. The files are in ${root}.`

const names = path => {
  try { return readdir(path).map(entry => (typeof entry === 'string' ? entry : entry.name)).filter(name => name !== '.' && name !== '..').sort() } catch { return undefined }
}
const text = path => { try { return readTextFile(path) } catch { return undefined } }

/** The license named in a program's SOURCE offer: its first line reads `name version (LICENSE)` */
const sourceLicense = dir => /\(([^)]*)\)\s*$/.exec((text(`${dir}/SOURCE`) ?? '').split('\n')[0] ?? '')?.[1]

/** The license in a library's COPYRIGHT.txt: `name version, LICENSE, Copyright ...` */
const libraryLicense = dir => (text(`${dir}/COPYRIGHT.txt`) ?? '').split('\n')[0]?.split(', ')[1]

const row = (name, license, where) => `  ${name.padEnd(24)} ${(license ?? '').padEnd(28)} ${where}`

function list() {
  const lines = ['ecmaOS', row('ecmaos', 'MIT OR Apache-2.0', `${root}/@ecmaos/kernel`), '', 'Libraries', '']
  const libraries = [...(names(`${root}/@zenfs`) ?? []).filter(name => text(`${root}/@zenfs/${name}/COPYRIGHT.txt`)).map(name => `@zenfs/${name}`), 'utilium', 'memium']
  for (const library of libraries) if (names(`${root}/${library}`)) lines.push(row(library, libraryLicense(`${root}/${library}`), `${root}/${library}`))
  for (const [heading, packageName] of [['Programs, @ecmaos/coreutils', 'coreutils'], ['Programs, @ecmaos/coreutils-copyleft', 'coreutils-copyleft']]) {
    const dir = `${root}/@ecmaos/${packageName}`
    const programs = (names(dir) ?? []).filter(name => names(`${dir}/${name}`))
    lines.push('', heading, '')
    for (const program of programs) lines.push(row(program, sourceLicense(`${dir}/${program}`) ?? (packageName === 'coreutils' ? 'permissive, see the text' : ''), `${dir}/${program}`))
  }
  out(lines.join('\n') + '\n')
}

/** Where a name's files are: the name as given, or under one of the places they are kept */
function find(name) {
  const trimmed = name.replace(/^\/+|\/+$/g, '').replace(/^zenfs\//, '@zenfs/')
  for (const candidate of [trimmed, `@ecmaos/${trimmed}`, `@zenfs/${trimmed}`, `@ecmaos/coreutils/${trimmed}`, `@ecmaos/coreutils-copyleft/${trimmed}`, `@ecmaos/coreutils-copyleft/licenses/${trimmed}`]) {
    if (candidate.split('/').includes('..')) continue
    if (names(`${root}/${candidate}`)) return `${root}/${candidate}`
  }
  return undefined
}

/** Every file under `dir`, as full paths */
function files(dir) {
  return (names(dir) ?? []).flatMap(name => (names(`${dir}/${name}`) ? files(`${dir}/${name}`) : [`${dir}/${name}`]))
}

function show(name) {
  const dir = find(name)
  if (!dir) { err(`licenses: ${name}: no license texts kept for that (run licenses to see what there is)`); return 1 }
  for (const file of files(dir)) out(`==> ${file} <==\n${(text(file) ?? '').replace(/\n*$/, '\n')}\n`)
  return 0
}

function main() {
  const args = argv.slice(1)
  if (args.includes('-h') || args.includes('--help')) { out(usage + '\n'); return 0 }
  const bad = args.find(arg => arg.startsWith('-'))
  if (bad) { err(`licenses: invalid option -- '${bad}'\nTry 'licenses --help' for more information.`); return 1 }
  if (!args.length) { list(); return 0 }
  return args.reduce((status, name) => show(name) || status, 0)
}

try {
  exit(main())
} catch (error) {
  err(`licenses: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
