// Wraps rust-wasip1.wasm in jco's wasi_snapshot_preview1 command adapter, giving a Preview 2 component built from a real
// rustc output (the same wrapping p2-echo uses). Run from core/kernel: node tests/tree/wasi/fixtures/rust-wasip1.component.build.mjs
import { readFile, writeFile } from 'node:fs/promises'
import { componentNew, preview1AdapterCommandPath } from '@bytecodealliance/jco'

const here = new URL('.', import.meta.url)
const core = await readFile(new URL('rust-wasip1.wasm', here))
const adapter = await readFile(preview1AdapterCommandPath())
const component = await componentNew(core, [['wasi_snapshot_preview1', adapter]])
await writeFile(new URL('rust-p2.wasm', here), component)
console.log(`rust-p2.wasm: ${component.byteLength} bytes`)
