/**
 * ecmaOS's `/bin/wali` interpreter: the worker-hosted body `binfmt_wasm` points every `.wasm` file at. Bundled with
 * no imports and written to `/bin/wali` at boot, like `bin/node.mjs`.
 * A WALI module imports from a `"wali"` namespace (`SYS_open`, `SYS_read`, ...) and runs on upstream's host; a
 * `wasi_snapshot_preview1` module cannot, so this file tells them apart and routes preview1 modules to `runPreview1`
 * (`wasi-preview1.mjs`). `canRunInWorker` (`tree/wasm.ts`) decides which modules reach here; the rest run on the main
 * thread in `Kernel.executeWasm`.
 */

import { ready, exit, getpid } from '@zenfs/linux/uapi/process'
import { syscall_raw } from '@zenfs/linux/uapi/base'
import { open, read, write, close } from '@zenfs/linux/uapi/fs'
import { run, wali } from '@zenfs/linux/uapi/wali'
import { runPreview1 } from './wasi-preview1.mjs'
import { install, attach } from './wali-host.mjs'

/**
 * A WALI module runs on the dependency's table with ecmaOS's calls added (`wali-host.mjs`). `run()` keeps the
 * instance to itself, so its memory is picked up here as the module is instantiated; this worker runs one program.
 */
function runWali(source) {
  install(wali)
  const instantiate = WebAssembly.instantiate
  WebAssembly.instantiate = async (...args) => {
    const instance = await instantiate(...args)
    attach(instance)
    return instance
  }
  return run(source)
}

/** `read()` never blocks past what's buffered, so read in a loop until a short read ends it. */
async function readWholeFile(path) {
  const fd = open(path, 0 /* O_RDONLY */)
  const chunkSize = 65536
  const chunks = []

  try {
    while (true) {
      const buffer = new Uint8Array(chunkSize)
      const n = read(fd, buffer, -1)
      if (n <= 0) break
      chunks.push(buffer.subarray(0, n))
      if (n < chunkSize) break
    }
  } finally {
    close(fd)
  }

  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  return bytes
}

const init = await ready

try {
  const source = await readWholeFile(init.exe)
  // `run()` returns only if the module falls out of `main()`. A `wasi_snapshot_preview1` module is translated by
  // `wasi-preview1.mjs`; anything else is WALI.
  const module = await WebAssembly.compile(source)
  const isPreview1 = WebAssembly.Module.imports(module).some(entry => entry.module === 'wasi_snapshot_preview1')
  const code = isPreview1 ? await runPreview1(source) : await runWali(source)
  exit(code)
} catch (error) {
  // An exception nothing caught (a C++ throw, or a longjmp with no setjmp) leaves the module as a WebAssembly
  // exception rather than reaching std::terminate, which would abort: say so and end the same way, by SIGABRT.
  if (error instanceof WebAssembly.Exception) {
    try { write(2, new TextEncoder().encode('terminating due to an uncaught exception\n'), -1) } catch { /* no stderr */ }
    syscall_raw('kill', getpid(), 6 /* SIGABRT */)
    exit(134)
  }
  console.error(error)
  // a trap or an uncaught throw ends the program: say so on its stderr, which the console above does not show the user
  try { write(2, new TextEncoder().encode(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`), -1) } catch { /* no stderr */ }
  exit(1)
}
