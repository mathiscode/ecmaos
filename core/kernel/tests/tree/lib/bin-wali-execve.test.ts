import { describe, it, expect, beforeAll } from 'vitest'
import wabtInit from 'wabt'
import binWaliSource from 'virtual:bin-wali'

import '@zenfs/linux'
import { Process, execve, DevTmpFS } from '@zenfs/linux'
import { defaultContext, configure, InMemory, fs } from '@zenfs/core'

/**
 * A real end-to-end proof of the execve pipeline for `/bin/wali`, mirroring
 * `bin-node-execve.test.ts` for `/bin/node`. `@zenfs/linux`'s own default `binfmt_wasm` already
 * points any `.wasm` file's magic bytes at `/bin/wali` as its interpreter -- this is what happens
 * once that file is real. See `src/bin/wali.mjs` for what it is and why a WALI module is a
 * different format from the WASI-preview1 `.wasm` files ecmaOS's own `executeWasm` path runs.
 *
 * There is no WALI-targeting toolchain available to compile a real program with here, so these
 * tests hand-assemble minimal WALI modules via `wabt` -- just enough to prove the interpreter
 * really does load a `.wasm` file, link it against `uapi/wali`'s real syscalls, and run `_start`.
 */
describe('/bin/wali via execve', () => {
  let wat2wasm: (wat: string) => Uint8Array

  beforeAll(async () => {
    const wabt = await wabtInit()
    wat2wasm = (wat: string) => {
      const module = wabt.parseWat('test.wat', wat)
      return module.toBinary({}).buffer
    }

    await configure({ mounts: { '/': InMemory, '/dev': new DevTmpFS() } })
    await fs.promises.writeFile('/dev/console', '')
    await fs.promises.mkdir('/bin')
    await fs.promises.writeFile('/bin/wali', binWaliSource, { mode: 0o755 })
  })

  it('runs a minimal WALI module to completion with its own exit code', async () => {
    const bytes = wat2wasm(`
      (module
        (import "wali" "__proc_exit" (func $proc_exit (param i32)))
        (import "wali" "__call_ctors" (func $call_ctors))
        (memory (export "memory") 1)
        (func $_start (export "_start")
          call $call_ctors
          i32.const 7
          call $proc_exit
        )
      )
    `)

    await fs.promises.writeFile('/exit7.wasm', bytes, { mode: 0o755 })

    const proc = new Process({ context: defaultContext })
    await execve(proc, '/exit7.wasm', ['/exit7.wasm'], {})
    expect(await proc.exited).toBe(7)
  })

  it('exits 0 for a module that falls out of _start without exiting', async () => {
    const bytes = wat2wasm(`
      (module
        (import "wali" "__call_ctors" (func $call_ctors))
        (memory (export "memory") 1)
        (func $_start (export "_start")
          call $call_ctors
        )
      )
    `)

    await fs.promises.writeFile('/falls-through.wasm', bytes, { mode: 0o755 })

    const proc = new Process({ context: defaultContext })
    await execve(proc, '/falls-through.wasm', ['/falls-through.wasm'], {})
    expect(await proc.exited).toBe(0)
  })
})
