import { describe, it, expect, beforeAll } from 'vitest'
import wabtInit from 'wabt'
import binWaliSource from 'virtual:bin-wali'

import '@zenfs/linux'
import { Process, execve, DevTmpFS } from '@zenfs/linux'
import { defaultContext, configure, InMemory, fs } from '@zenfs/core'

/**
 * End-to-end `execve` of `/bin/wali`, mirroring `bin-node-execve.test.ts`: `@zenfs/linux`'s `binfmt_wasm` points a
 * `.wasm` file's magic bytes at it. There is no WALI toolchain here, so minimal WALI modules are hand-assembled with
 * `wabt` to show the interpreter loads, links against `uapi/wali` and runs `_start`.
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
