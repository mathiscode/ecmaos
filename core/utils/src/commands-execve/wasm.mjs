/**
 * `wasm info FILE...`: say which ABI a WebAssembly file is for and which of its imports ecmaOS does not provide. The file
 * is run through `execve` like any program, with `ECMAOS_WASM_INFO` set; `/bin/wali` then reports what its hosts would
 * do with the module (`kernel/src/bin/wasm-info.mjs`) instead of running it, so the answer is the one a run would get.
 */

import { findProgram, statusOf, waitFor } from './lib/run.mjs'

const { argv, env, exit, writeAll, spawn, getcwd, open, read, close } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`wasm: ${text}\n`))

const usage = `Usage: wasm info FILE...
Say which ABI a WebAssembly file is for and which of its imports ecmaOS does not provide.

  info FILE...   describe each file: WALI, WASI Preview 1, WASI Preview 2, Emscripten, or none
  --help         display this help and exit`

/** Whether a file starts with the WebAssembly magic bytes, which is all `execve` asks */
function isWasm(path) {
  const fd = open(path, 0, 0)
  try {
    const head = new Uint8Array(4)
    return read(fd, head, -1) === 4 && head[0] === 0 && head[1] === 0x61 && head[2] === 0x73 && head[3] === 0x6d
  } finally { close(fd) }
}

async function info(files) {
  let status = 0
  for (const file of files) {
    const path = findProgram(file.includes('/') ? file : `./${file}`)
    if (!path) { err(`${file}: No such file or directory`); status = 1; continue }
    if (!isWasm(path)) { err(`${file}: not a WebAssembly file`); status = 1; continue }
    let pid
    try {
      pid = await spawn(path, [path], { cwd: getcwd(), env: { ...env, ECMAOS_WASM_INFO: '1' } })
    } catch (error) {
      err(`${file}: ${error?.message ?? error}`)
      status = 1
      continue
    }
    const code = statusOf(await waitFor(pid))
    if (code !== 0) status = 1
  }
  return status
}

async function main() {
  const args = argv.slice(1)
  if (args[0] === '--help') { writeAll(1, encoder.encode(`${usage}\n`)); return 0 }
  if (args[0] !== 'info' || args.length < 2) { writeAll(2, encoder.encode(`${usage}\n`)); return 1 }
  return info(args.slice(1))
}

try {
  exit(await main())
} catch (error) {
  err(error?.message ?? String(error))
  exit(1)
}
