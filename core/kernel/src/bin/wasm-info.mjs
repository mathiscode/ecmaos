/**
 * `wasm info FILE`: what `/bin/wali` would do with a module, said by the hosts themselves. The `wasm` program runs the file
 * with `ECMAOS_WASM_INFO` set, `wali.mjs` calls `describe` instead of running it, and the tables compared with the
 * module's imports are the ones the hosts hand a program, so the answer cannot drift from what runs.
 */

import { write } from '@zenfs/linux/uapi/fs'
import { wali } from '@zenfs/linux/uapi/wali'
import { createWasip1 } from './wasip1.mjs'
import { createWasip2, versionOf } from './wasip2.mjs'
import { install } from './wali-host.mjs'

const encoder = new TextEncoder()
const out = text => write(1, encoder.encode(`${text}\n`), -1)

/** The names of the functions a table holds */
const functionsOf = table => new Set(Object.entries(table).filter(([, value]) => typeof value === 'function').map(([name]) => name))

/** The tables a core module's imports are looked up in, by import module: `wali`, `wasi_snapshot_preview1` and `env` */
async function coreTables() {
  install(wali, undefined)
  const host = createWasip1(() => undefined)
  const { createEmscripten } = await import('./emscripten.mjs')
  return {
    wali: functionsOf(wali),
    wasi_snapshot_preview1: functionsOf(host.wasi),
    env: functionsOf(createEmscripten(host.context, host.wasi))
  }
}

/** The entry point a core module is started by, as `runPreview1` and the WALI runner pick it, or undefined for a library */
function entryOf(exportNames) {
  for (const name of ['_start', '_initialize', 'main', '__main_argc_argv']) if (exportNames.includes(name)) return name
  return undefined
}

function abiOf(modules) {
  const has = name => modules.includes(name)
  if (has('wali')) return 'WALI'
  if (has('env')) return has('wasi_snapshot_preview1') ? 'Emscripten (with WASI Preview 1 calls)' : 'Emscripten'
  if (has('wasi_snapshot_preview1')) return 'WASI Preview 1'
  return 'none (the module makes no host calls)'
}

/** Prints the report for a core module; `path` is only for the heading */
async function describeCore(path, module) {
  const imports = WebAssembly.Module.imports(module)
  const exportNames = WebAssembly.Module.exports(module).map(entry => entry.name)
  const tables = await coreTables()
  const modules = [...new Set(imports.map(entry => entry.module))]
  const entry = entryOf(exportNames)
  const functions = imports.filter(item => item.kind === 'function')
  const missing = functions.filter(item => !tables[item.module]?.has(item.name)).map(item => `${item.module}.${item.name}`)

  out(path)
  out(`  ABI: ${abiOf(modules)}`)
  out(`  Runs as: ${entry ? `a program, started at ${entry}` : 'not a program: it exports none of _start, _initialize or main (a library)'}`)
  out(`  Imports: ${functions.length} function${functions.length === 1 ? '' : 's'} from ${modules.length ? modules.join(', ') : 'nowhere'}`)
  if (missing.length) {
    out('  Not provided (the program stops with a message if it calls one):')
    for (const name of missing) out(`    ${name}`)
  } else out('  Not provided: none')
  return 0
}

/** Prints the report for a Preview 2 component the kernel transpiled; `imports` are its import names, as jco lists them */
function describeComponent(path, { imports = [], exports: exportNames = [] }) {
  const version = versionOf(exportNames)
  const provided = new Set(Object.keys(createWasip2()))
  const bare = name => name.replace(/@[^@]*$/, '')
  const missing = imports.filter(name => !provided.has(bare(name)))

  out(path)
  out(`  ABI: WASI Preview 2 (${version}), a component`)
  out(`  Runs as: ${exportNames.some(name => bare(name) === 'wasi:cli/run') ? 'a program, started at wasi:cli/run' : 'not a program: it exports no wasi:cli/run'}`)
  out(`  Imports: ${imports.length} interface${imports.length === 1 ? '' : 's'}`)
  if (missing.length) {
    out('  Not provided (the component fails to start):')
    for (const name of missing) out(`    ${name}`)
  } else out('  Not provided: none')
  return 0
}

/** Describes what `run` would be given: a compiled core `module` or a transpiled `component`. Returns the exit status. */
export function describe(path, { module, component }) {
  return component ? describeComponent(path, component) : describeCore(path, module)
}
