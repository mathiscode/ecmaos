/**
 * ecmaOS's `/bin/wali` interpreter: the worker-hosted body `binfmt_wasm` points every `.wasm` file at. Bundled with
 * no imports and written to `/bin/wali` at boot, like `bin/node.mjs`.
 * A WALI module imports from a `"wali"` namespace (`SYS_open`, `SYS_read`, ...) and runs on upstream's host; a
 * `wasi_snapshot_preview1` module cannot, so this file tells them apart and routes preview1 modules to `runPreview1`
 * (`wasi-preview1.mjs`). `canRunInWorker` (`tree/wasm.ts`) decides which modules reach here; the rest (components and
 * modules with no WASI imports) run on the main thread in `Kernel.executeWasm`.
 */

import { ready, exit, getpid } from '@zenfs/linux/uapi/process'
import { receive } from '@zenfs/linux/uapi/port'
import { syscall_raw } from '@zenfs/linux/uapi/base'
import { open, read, write, close, stat } from '@zenfs/linux/uapi/fs'
import { run, wali } from '@zenfs/linux/uapi/wali'
import { runPreview1 } from './wasi-preview1.mjs'
import { install, attach, drive } from './wali-host.mjs'

/**
 * The limits of the memory a module imports (`wali.memory`, which the toolchain links it to import so each thread's
 * instance can be given the same one), read from its import section: `{ initial, maximum }` in pages, or undefined
 * for a module that defines its own memory.
 */
function memoryLimits(bytes) {
  let at = 8
  const leb = () => {
    let result = 0, shift = 0, byte
    do { byte = bytes[at++]; result += (byte & 0x7f) * 2 ** shift; shift += 7 } while (byte & 0x80)
    return result
  }
  const skipName = () => { const length = leb(); at += length }
  while (at < bytes.length) {
    const id = bytes[at++], size = leb(), end = at + size
    if (id !== 2) { at = end; continue }
    for (let count = leb(); count > 0; count--) {
      skipName()
      skipName()
      const kind = bytes[at++]
      if (kind === 0) leb()
      else if (kind === 1) { at++; const flags = bytes[at++]; leb(); if (flags & 1) leb() }
      else if (kind === 2) { const flags = bytes[at++]; const initial = leb(); return { initial, maximum: flags & 1 ? leb() : initial } }
      else if (kind === 3) at += 2
      else if (kind === 4) { at++; leb() }
    }
    return undefined
  }
  return undefined
}

/**
 * A thread of a WALI process (`proc_thread`) is told which, after it starts: the memory, the shared state and its argument.
 * A fork's child (`proc_fork`) is told its copies of them and `fork`, where to rewind to (a fork from a thread rewinds
 * into that thread's function).
 */
const threadStart = Promise.withResolvers()
receive(message => { if (message.$ === 'wali-thread') threadStart.resolve(message) })

/**
 * A program the kernel has compiled already is sent ahead of `init` (`lib/warm-threads.ts`): its module and the limits of
 * the memory it imports. The file is then not read, nor compiled again here.
 */
let provided
receive(message => { if (message.$ === 'wali-module') provided = message })

/** Whether `path` is still the file a module was compiled from: a program replaced since is read again, wherever it is run from */
function sameFile(path, id) {
  try {
    const stats = stat(path)
    return id === `${stats.ino}\0${stats.size}\0${stats.mtimeMs}`
  } catch {
    return false
  }
}

/**
 * A WALI module runs on the dependency's table with ecmaOS's calls added (`wali-host.mjs`). `run()` keeps the
 * instance to itself, so its memory is picked up here as the module is instantiated. The first thread makes the
 * shared memory the module imports; a later one is given it, and runs `__wasm_thread_start_libc` rather than
 * `_start`. Each worker runs one thread.
 */
function runWali(source, start, unwindAt, preloaded) {
  install(wali, start)
  const limits = preloaded ? preloaded.limits : memoryLimits(source)
  if (start) wali.memory = start.memory
  else if (limits) wali.memory = new WebAssembly.Memory({ ...limits, shared: true })
  const instantiate = WebAssembly.instantiate
  WebAssembly.instantiate = async (...args) => {
    const instance = await instantiate(...args)
    attach(instance)
    // a program built with Asyncify can fork, which `drive()` carries out; from a thread too, whose frames start at
    // the function it runs
    if (!start || start.fork) {
      const _start = drive(instance, limits, start?.fork, undefined, unwindAt)
      return _start ? { exports: Object.assign(Object.create(null), instance.exports, { _start }) } : instance
    }
    const entry = () => instance.exports.__wasm_thread_start_libc(getpid(), start.arg)
    const exports = Object.assign(Object.create(null), instance.exports, { _start: drive(instance, limits, undefined, entry, unwindAt) ?? entry })
    return { exports }
  }
  if (preloaded) {
    // `run` compiles what it is given: it is given the object the module came in, and answers with the module
    const compile = WebAssembly.compile
    WebAssembly.compile = async (value, ...rest) => value === preloaded ? preloaded.module : compile.call(WebAssembly, value, ...rest)
    return run(preloaded)
  }
  return run(source)
}

/**
 * A short read is not EOF, so loop until `read()` returns 0. A program is megabytes (python3 is 17MB), and each `read` is
 * a round trip to the kernel: 1MiB at a time is the most one returns, and took python3's read from 2s to 0.15s.
 */
async function readWholeFile(path) {
  const fd = open(path, 0 /* O_RDONLY */)
  const chunkSize = 1048576
  const chunks = []

  try {
    while (true) {
      const buffer = new Uint8Array(chunkSize)
      const n = read(fd, buffer, -1)
      if (n <= 0) break
      chunks.push(buffer.subarray(0, n))
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
let start

/** Ends the program with `code`: all of it, from any thread, as a fault does (a thread's own exit ends only it) */
const fail = code => start ? syscall_raw('proc_exit_group', code) : exit(code)

try {
  // a module the kernel sent for this very program is used as it is; the first thing a worker is told is which one it is for
  const preloaded = provided?.exe === init.exe && sameFile(init.exe, provided.id) ? provided : undefined
  const source = preloaded ? undefined : await readWholeFile(init.exe)
  // `run()` returns only if the module falls out of `main()`. A `wasi_snapshot_preview1` module is translated by
  // `wasi-preview1.mjs`; anything else is WALI.
  const module = preloaded ? preloaded.module : await WebAssembly.compile(source)
  const isPreview1 = !preloaded && WebAssembly.Module.imports(module).some(entry => entry.module === 'wasi_snapshot_preview1')
  start = init.env?.__WALI_THREAD__ || init.env?.__WALI_FORK__ ? await threadStart.promise : undefined
  // the imports a handler's fork can unwind at, if the program was built for that (utils/wali/asyncify.sh)
  const unwindAt = WebAssembly.Module.customSections(module, 'ecmaos.asyncify-signals').flatMap(section => new TextDecoder().decode(section).split(',').filter(Boolean))
  const code = isPreview1 ? await runPreview1(source) : await runWali(source, start, unwindAt, preloaded)
  exit(code)
} catch (error) {
  // An exception nothing caught (a C++ throw, or a longjmp with no setjmp) leaves the module as a WebAssembly
  // exception rather than reaching std::terminate, which would abort: say so and end the same way, by SIGABRT.
  if (error instanceof WebAssembly.Exception) {
    try { write(2, new TextEncoder().encode('terminating due to an uncaught exception\n'), -1) } catch { /* no stderr */ }
    syscall_raw('kill', start ? start.tgid : getpid(), 6 /* SIGABRT */)
    fail(134)
  }
  console.error(error)
  // a trap or an uncaught throw ends the program: say so on its stderr, which the console above does not show the user
  try { write(2, new TextEncoder().encode(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`), -1) } catch { /* no stderr */ }
  fail(1)
}
