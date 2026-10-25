#!/usr/bin/env node
/**
 * Writes REUSE.toml: the license of every file in the repository, for `reuse lint`.
 *
 * Most files are ecmaOS's own (MIT OR Apache-2.0, and a file's own SPDX header wins where it has one). The exceptions
 * are the WebAssembly programs, which keep their upstream's license: those are read from each package's
 * `programs/manifest.json`, so a program added or relicensed there cannot silently be described as MIT OR Apache-2.0.
 *
 *   node scripts/reuse-toml.mjs          rewrite REUSE.toml
 *   node scripts/reuse-toml.mjs --check  exit 1 if REUSE.toml differs from what the manifests say (CI runs it)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const own = 'MIT OR Apache-2.0'
const ownCopyright = '2024-2026 Jay Mathis <code@mathis.network>'
const toml = value => JSON.stringify(value)

const blocks = []
const annotate = (comment, paths, license, copyright, precedence = 'closest') => blocks.push(
  `# ${comment}\n[[annotations]]\npath = ${paths.length === 1 ? toml(paths[0]) : `[${paths.map(toml).join(', ')}]`}\nprecedence = ${toml(precedence)}\nSPDX-FileCopyrightText = ${toml(copyright)}\nSPDX-License-Identifier = ${toml(license)}\n`
)

// REUSE.toml applies the last annotation that matches a file, so the general ones come first
annotate('ecmaOS: everything, unless a file says otherwise in its own SPDX header or an annotation below does', ['**'], own, ownCopyright)

annotate('Reproductions of other projects\' license texts and notices, kept so a license that asks for its notice gets it', [
  '**/licenses/**', 'core/kernel/public/initfs/usr/share/licenses/**'
], 'LicenseRef-Upstream-License-Notice', 'the authors of each project, named in each text', 'override')
annotate('The notices and offers of source that ecmaOS wrote itself, among those texts', [
  '**/licenses/**/SOURCE', '**/licenses/**/README.md', '**/licenses/**/README', '**/licenses/**/COPYRIGHT.txt',
  'core/kernel/public/initfs/usr/share/licenses/@ecmaos/kernel/**', 'core/*/licenses/ecmaos/**', 'core/utils*/licenses/ecmaos/**'
], own, ownCopyright, 'override')
annotate('ecmaOS\'s own license texts (the MIT and Apache texts themselves are not copyrightable additions)', ['LICENSE', 'LICENSE-MIT', 'LICENSE-APACHE'], own, ownCopyright, 'override')

// The programs, from the manifests: each keeps the license its upstream gave it
for (const pkg of ['core/utils', 'core/utils-copyleft']) {
  const manifest = JSON.parse(readFileSync(path.join(root, pkg, 'programs/manifest.json'), 'utf8'))
  const byLicense = new Map()
  for (const [name, program] of Object.entries(manifest.programs)) {
    const files = [`${pkg}/programs/${program.file}`]
    if (!byLicense.has(program.license)) byLicense.set(program.license, [])
    byLicense.get(program.license).push(...files)
    if (program.runtime) byLicense.get(program.license).push(`${pkg}/programs/${program.runtime.file ?? program.runtime}`)
  }
  for (const [license, files] of byLicense) {
    annotate(`${pkg}: programs built from upstream sources under ${license} (the upstream authors' copyright; the changes ecmaOS made are in wasm/ and the SOURCE offers)`, files.sort(), license.replace(/LicenseRef-Public-?Domain/g, 'LicenseRef-Public-Domain').replace(/\bbzip2-1\.0\.8\b/g, 'LicenseRef-bzip2-1.0.8') /* SPDX has no id for 1.0.8's text */, license === own ? ownCopyright : 'the authors of each program, named in its license text', 'override')
  }
}

annotate('Bundles of upstream files shipped beside a program', ['core/utils/programs/python3-lib.tar.gz'], 'PSF-2.0', 'Python Software Foundation and the authors of each bundled module', 'override')
annotate('Vim runtime files', ['core/utils-copyleft/programs/vim-runtime.tar.gz'], 'Vim', 'Bram Moolenaar and the Vim contributors', 'override')
annotate('Mozilla\'s CA certificate bundle (via curl.se/docs/caextract.html)', ['core/kernel/public/initfs/usr/share/ca-certificates/ca-bundle.crt'], 'MPL-2.0', 'Mozilla Foundation', 'override')
annotate('ALSA\'s default configuration', ['core/kernel/public/initfs/usr/share/alsa/alsa.conf'], 'LGPL-2.1-or-later', 'the ALSA project', 'override')
annotate('The FIGlet fonts the figlet command can import, from figlet.js; each font\'s own header says who drew it and on what terms', ['core/kernel/public/importable-fonts/**'], 'LicenseRef-FIGlet-Fonts', 'the font authors named in each file', 'override')
annotate('TypeDoc\'s generated page scripts and styles', [
  'docs/assets/main.js', 'docs/assets/style.css', 'docs/assets/highlight.css', 'docs/assets/icons.js', 'docs/assets/icons.svg', 'docs/assets/hierarchy.js',
  'core/kernel/public/initfs/usr/share/docs/@ecmaos/kernel/docs/assets/main.js', 'core/kernel/public/initfs/usr/share/docs/@ecmaos/kernel/docs/assets/style.css',
  'core/kernel/public/initfs/usr/share/docs/@ecmaos/kernel/docs/assets/highlight.css', 'core/kernel/public/initfs/usr/share/docs/@ecmaos/kernel/docs/assets/icons.js',
  'core/kernel/public/initfs/usr/share/docs/@ecmaos/kernel/docs/assets/icons.svg', 'core/kernel/public/initfs/usr/share/docs/@ecmaos/kernel/docs/assets/hierarchy.js'
], 'MIT', 'TypeDoc contributors', 'override')
annotate('The typedoc-theme-dmt theme\'s generated files', ['docs/assets/dmt/**', 'core/kernel/public/initfs/usr/share/docs/@ecmaos/kernel/docs/assets/dmt/**'], 'MPL-2.0', 'the typedoc-theme-dmt authors', 'override')

const header = `# Generated by scripts/reuse-toml.mjs (pnpm sync:reuse) from the programs' manifest.json files: do not edit by hand.
# The license of every file in the repository, for \`reuse lint\`. See CONTRIBUTING.md and the Licensing section of the README.
version = 1
SPDX-PackageName = "ecmaOS"
SPDX-PackageSupplier = "Jay Mathis <code@mathis.network>"
SPDX-PackageDownloadLocation = "https://github.com/ecmaos/ecmaos"

`
const output = header + blocks.join('\n')
const file = path.join(root, 'REUSE.toml')

if (process.argv.includes('--check')) {
  if (!existsSync(file) || readFileSync(file, 'utf8') !== output) {
    console.error('REUSE.toml is out of date with the programs\' manifests: run pnpm sync:reuse')
    process.exit(1)
  }
  console.log('REUSE.toml matches the manifests')
} else {
  writeFileSync(file, output)
  console.log(`wrote REUSE.toml (${blocks.length} annotations)`)
}
