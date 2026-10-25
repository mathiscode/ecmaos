/**
 * Makes a WebAssembly kernel module (`NAME.ko.wasm`) from a component of the world in `wit/ecmaos-module.wit`:
 *
 *   node scripts/wasm-module.mjs pack COMPONENT.wasm INFO.json OUT.ko.wasm
 *   node scripts/wasm-module.mjs build SOURCE.js INFO.json OUT.ko.wasm      (a JavaScript module, componentized with jco)
 *
 * INFO.json is the modinfo: `{ name, version?, description?, license?, kernel_api?, author?: [], depends?: [], alias?: [], parm?: [] }`.
 * It goes into the `ecmaos-module` section, which `modinfo` and `insmod` read without running anything. Sign the result with
 * `sign-module` (a signature is one more section at the end of the file) or with ECMAOS_MODULE_KEY, as build-modules does.
 * A module in Rust is built by the toolchain (`cargo build --target wasm32-wasip2`, then `wasm-tools component new`) and
 * packed the same way.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

const size = value => {
  const out = []
  do {
    let byte = value & 0x7f
    value = Math.floor(value / 128)
    if (value) byte |= 0x80
    out.push(byte)
  } while (value)
  return out
}

/** A custom section: id 0, its size, the name and the text */
export function customSection(name, text) {
  const nameBytes = Buffer.from(name)
  const inner = [...size(nameBytes.length), ...nameBytes, ...Buffer.from(text)]
  return Buffer.from([0, ...size(inner.length), ...inner])
}

/** The modinfo as the lines `modinfo` prints */
export function modinfoText(info) {
  const lines = [`name=${info.name}`]
  if (info.version) lines.push(`version=${info.version}`)
  if (info.description) lines.push(`description=${info.description}`)
  if (info.license) lines.push(`license=${info.license}`)
  lines.push(`kernel_api=${info.kernel_api ?? '^1.0.0'}`)
  for (const author of info.author ?? []) lines.push(`author=${author}`)
  if (info.depends?.length) lines.push(`depends=${info.depends.join(',')}`)
  for (const alias of info.alias ?? []) lines.push(`alias=${alias}`)
  for (const parm of info.parm ?? []) lines.push(`parm=${parm}`)
  return lines.join('\n') + '\n'
}

export function packWasmModule(component, info) {
  if (!(component.length > 8 && component[0] === 0 && component[1] === 0x61 && component[2] === 0x73 && component[3] === 0x6d)) throw new Error('not a WebAssembly file')
  return Buffer.concat([component, customSection('ecmaos-module', modinfoText(info))])
}

/** Componentizes a JavaScript module (the exports `lifecycle` and `hooks` of the world) with jco */
export function componentizeJs(source, out) {
  const jco = path.join(path.dirname(fileURLToPath(import.meta.resolve('@bytecodealliance/jco'))), 'jco.js')
  execFileSync(process.execPath, [jco, 'componentize', source, '--wit', path.join(here, '../wit'), '--world-name', 'module', '-o', out], { stdio: 'inherit' })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, input, infoFile, output] = process.argv.slice(2)
  if (!['pack', 'build'].includes(command) || !input || !infoFile || !output) {
    console.error('usage: wasm-module.mjs pack|build INPUT INFO.json OUT.ko.wasm')
    process.exit(2)
  }
  let component = input
  if (command === 'build') {
    component = `${output}.component`
    componentizeJs(input, component)
  }
  writeFileSync(output, packWasmModule(readFileSync(component), JSON.parse(readFileSync(infoFile, 'utf8'))))
  console.log(`wrote ${output}`)
}
