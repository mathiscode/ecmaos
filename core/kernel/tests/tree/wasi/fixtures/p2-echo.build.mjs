// Rebuilds p2-echo.wasm from p2-echo.wat with the jco the kernel depends on: the module is assembled, then made a
// component by wrapping it in jco's wasi_snapshot_preview1 command adapter, so it imports wasi:cli and the rest of
// Preview 2 and exports wasi:cli/run. Run from core/kernel: node tests/tree/wasi/fixtures/p2-echo.build.mjs
import { readFile, writeFile } from 'node:fs/promises'
import { componentNew, parse, preview1AdapterCommandPath } from '@bytecodealliance/jco'

const here = new URL('.', import.meta.url)
const core = await parse(await readFile(new URL('p2-echo.wat', here), 'utf-8'))
const adapter = await readFile(preview1AdapterCommandPath())
const component = await componentNew(core, [['wasi_snapshot_preview1', adapter]])
await writeFile(new URL('p2-echo.wasm', here), component)
console.log(`p2-echo.wasm: ${component.byteLength} bytes`)
