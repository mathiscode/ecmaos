#!/usr/bin/env node
/**
 * Keeps the copyleft programs separate works: nothing but `@ecmaos/coreutils-copyleft` may contain them, link them or
 * import them. The kernel and the permissively licensed packages only ever start them as processes (`execve`).
 *
 * Checks, in the repository:
 *   1. no package other than the copyleft one lists it in `dependencies` or `optionalDependencies` (a development
 *      dependency, for tests and the build, and an optional peer dependency, for the Node host, are fine);
 *   2. no source file outside it imports it, or a file of core/utils-copyleft, as a module (a string that names it, as
 *      the build does to find the programs on disk, is not an import);
 * and, with --dist, after a build:
 *   3. no text file of core/kernel/dist or core/node/dist (the JavaScript, HTML and CSS) holds the bytes of a copyleft
 *      program, base64 or not. The .wasm files themselves are served beside the bundle, which is what keeps them apart.
 *
 *   node scripts/check-license-boundary.mjs [--dist]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const copyleft = '@ecmaos/coreutils-copyleft'
const problems = []

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean)

// 1. Manifests
for (const file of tracked.filter(name => name.endsWith('package.json') && !name.includes('node_modules') && !name.startsWith('core/utils-copyleft/'))) {
  let manifest
  try { manifest = JSON.parse(readFileSync(path.join(root, file), 'utf8')) } catch { continue }
  for (const field of ['dependencies', 'optionalDependencies']) {
    if (manifest[field]?.[copyleft]) problems.push(`${file}: lists ${copyleft} in ${field}; a package that ships must not depend on copyleft programs (devDependencies or an optional peerDependency are allowed)`)
  }
}

// 2. Imports
const importOf = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\bimport\s+)(['"`])([^'"`]*)\1/g
const sourceFile = /\.(?:[cm]?[jt]sx?|vue|svelte)$/
for (const file of tracked.filter(name => sourceFile.test(name) && !name.startsWith('core/utils-copyleft/') && !name.startsWith('docs/') && !name.includes('/initfs/'))) {
  const text = readFileSync(path.join(root, file), 'utf8')
  for (const match of text.matchAll(importOf)) {
    const specifier = match[2]
    if (specifier === copyleft || specifier.startsWith(`${copyleft}/`) || /(^|\/)utils-copyleft(\/|$)/.test(specifier)) {
      problems.push(`${file}: imports ${specifier}; the copyleft programs are run as processes, never imported`)
    }
  }
}

// 3. The built bundles
if (process.argv.includes('--dist')) {
  const manifest = JSON.parse(readFileSync(path.join(root, 'core/utils-copyleft/programs/manifest.json'), 'utf8'))
  // A slice of each program from the middle of the file, at an offset divisible by 3, so its base64 is a substring of the whole's
  const needles = []
  for (const [name, program] of Object.entries(manifest.programs)) {
    const file = path.join(root, 'core/utils-copyleft/programs', program.file)
    if (!existsSync(file)) continue
    const bytes = readFileSync(file)
    const offset = Math.floor(bytes.length / 2 / 3) * 3
    const slice = bytes.subarray(offset, offset + 48)
    needles.push({ name, raw: slice.toString('latin1'), base64: slice.toString('base64') })
  }
  const textFile = /\.(?:[cm]?js|html|css|json|map)$/
  const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]))
  let scanned = 0
  for (const dist of ['core/kernel/dist', 'core/node/dist']) {
    if (!existsSync(path.join(root, dist))) { problems.push(`${dist} does not exist; run pnpm build before --dist`); continue }
    for (const file of walk(path.join(root, dist)).filter(name => textFile.test(name) && statSync(name).size < 1 << 28)) {
      const text = readFileSync(file, 'latin1')
      scanned++
      for (const needle of needles) if (text.includes(needle.base64) || text.includes(needle.raw)) problems.push(`${path.relative(root, file)}: contains the bytes of the copyleft program ${needle.name}`)
    }
  }
  console.log(`check:license-boundary: scanned ${scanned} built text files for ${needles.length} copyleft programs`)
}

if (problems.length) {
  console.error(`check:license-boundary: the copyleft boundary is crossed:\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
console.log('check:license-boundary: nothing but @ecmaos/coreutils-copyleft holds, depends on or imports the copyleft programs')
