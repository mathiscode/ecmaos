#!/usr/bin/env node
// Keeps a package's `programs/manifest.json` in step with the `.wasm` files beside it: fills in each program's
// `size` and `sha256` (the kernel compares an installed `/bin/<name>` against them, and downloads only on a
// difference). Run from the package directory.
//
//   node ../../utils/programs-manifest.mjs           rewrite the manifest
//   node ../../utils/programs-manifest.mjs --check   exit 1 if it is out of date, or incomplete
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const dir = path.resolve(process.cwd(), 'programs')
const manifestPath = path.join(dir, 'manifest.json')
const check = process.argv.includes('--check')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const problems = []

for (const [name, program] of Object.entries(manifest.programs)) {
  for (const field of ['file', 'version', 'license', 'description', 'homepage']) {
    if (!program[field]) problems.push(`${name}: no ${field}`)
  }
  const file = path.join(dir, program.file ?? `${name}.wasm`)
  if (!existsSync(file)) { problems.push(`${name}: ${program.file} is missing`); continue }
  const bytes = readFileSync(file)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (program.size !== bytes.length || program.sha256 !== sha256) {
    if (check) problems.push(`${name}: size/sha256 do not match ${program.file}`)
    program.size = bytes.length
    program.sha256 = sha256
  }
}

// A program's runtime (`vim`'s /usr/share/vim) is a tarball beside the `.wasm`, installed with it
for (const [name, program] of Object.entries(manifest.programs)) {
  if (!program.runtime) continue
  const file = path.join(dir, program.runtime.file ?? '')
  if (!program.runtime.file || !existsSync(file)) { problems.push(`${name}: runtime ${program.runtime.file} is missing`); continue }
  const bytes = readFileSync(file)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (program.runtime.size !== bytes.length || program.runtime.sha256 !== sha256) {
    if (check) problems.push(`${name}: runtime size/sha256 do not match ${program.runtime.file}`)
    program.runtime.size = bytes.length
    program.runtime.sha256 = sha256
  }
}

const pin = readFileSync(path.join(import.meta.dirname, 'emscripten-version'), 'utf8').trim()
if (manifest.toolchain?.emscripten !== pin) problems.push(`toolchain.emscripten is ${manifest.toolchain?.emscripten}, utils/emscripten-version pins ${pin}`)
// A program built on WALI's musl says so (`"toolchain": "wali"`); the package then names the pin in utils/wali-version
const wali = Object.fromEntries([...readFileSync(path.join(import.meta.dirname, 'wali-version'), 'utf8').matchAll(/^(\w+)=(\S+)$/gm)].map(([, key, value]) => [key, value]))
const waliPin = `musl ${wali.MUSL_COMMIT}, LLVM ${wali.LLVM_VERSION}`
const waliPrograms = Object.entries(manifest.programs).filter(([, program]) => program.toolchain === 'wali')
if (waliPrograms.length && manifest.toolchain?.wali !== waliPin) problems.push(`toolchain.wali is ${manifest.toolchain?.wali}, utils/wali-version pins ${waliPin}`)
for (const [name, program] of Object.entries(manifest.programs)) {
  if (program.toolchain !== undefined && program.toolchain !== 'wali') problems.push(`${name}: toolchain is ${program.toolchain}; a program names one only when it is wali`)
}
for (const [name, program] of Object.entries(manifest.programs)) {
  const texts = path.join(process.cwd(), 'licenses', name)
  if (!existsSync(texts) || readdirSync(texts).length === 0) problems.push(`${name}: no license text in licenses/${name}/`)
}

const listed = new Set(Object.values(manifest.programs).map(program => program.file))
for (const file of readdirSync(dir)) {
  if (file.endsWith('.wasm') && !listed.has(file)) problems.push(`${file} is not in the manifest`)
  if (file.endsWith('.tar.gz') && !Object.values(manifest.programs).some(program => program.runtime?.file === file)) problems.push(`${file} is not in the manifest`)
}

if (problems.length) {
  console.error(problems.map(problem => `programs-manifest: ${problem}`).join('\n'))
  if (check) process.exit(1)
}
if (!check) writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
