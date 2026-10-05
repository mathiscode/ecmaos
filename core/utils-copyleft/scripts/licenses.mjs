#!/usr/bin/env node
// Writes `licenses/<program>/SOURCE`: the written offer of source for each program in this package, from the
// manifest (upstream archive and its sha256, what ecmaOS changed, the toolchain). These files end up in the
// filesystem at /usr/share/licenses/@ecmaos/coreutils-copyleft/, next to the license texts.
//
//   node scripts/licenses.mjs           rewrite
//   node scripts/licenses.mjs --check   exit 1 if any file is out of date, or a license text is missing
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const check = process.argv.includes('--check')
const manifest = JSON.parse(readFileSync(path.join(root, 'programs', 'manifest.json'), 'utf8'))
const problems = []

for (const [name, program] of Object.entries(manifest.programs)) {
  for (const source of program.sources) {
    if (!existsSync(path.join(root, 'licenses', source.name))) problems.push(`licenses/${source.name}/ has no license text`)
  }
  const text = [
    `${name} ${program.version} (${program.license})`,
    '',
    `programs/${program.file} is built from the upstream source below, with the changes listed under it. Together they`,
    'are the complete corresponding source of the binary; this is the offer of it.',
    '',
    'Upstream source',
    ...program.sources.map(source => `  ${source.archive}  (${source.name} ${source.version}, ${source.license})\n    sha256 ${source.sha256}\n    from ${source.url}`),
    '',
    'Changes and build scripts (in wasm/ of the package, and in the repository under core/utils-copyleft/wasm/)',
    ...program.modifications.map(change => `  ${change.file}\n    ${change.what}`),
    '',
    'The changes were made in 2026; the repository history dates each one.',
    '',
    `Toolchain: Emscripten ${manifest.toolchain.emscripten} (utils/emscripten-version in the repository pins it).`,
    '',
    'Where to get it',
    `  - /sources/${program.sources[0].archive} on the site that served this program, and the other archives listed above in the same place`,
    '  - the sources/ and wasm/ directories of the npm package @ecmaos/coreutils-copyleft, in the version that holds this file',
    '  - https://github.com/ecmaos/ecmaos (core/utils-copyleft), at the tag of the release that holds this file',
    ''
  ].join('\n')
  const file = path.join(root, 'licenses', name, 'SOURCE')
  const current = existsSync(file) ? readFileSync(file, 'utf8') : undefined
  if (current === text) continue
  if (check) problems.push(`licenses/${name}/SOURCE is out of date`)
  else writeFileSync(file, text)
}

if (problems.length) {
  console.error(problems.map(problem => `licenses: ${problem}`).join('\n'))
  if (check) process.exit(1)
}
