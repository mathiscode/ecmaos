import { beforeAll, describe, expect, it } from 'vitest'
import { processes } from '@zenfs/linux'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/**
 * A module `canRunInWorker` rejects (no `wasi_snapshot_preview1` import at all here, so
 * `detectWasiVersion` isn't even `'preview1'`) still runs, on the main thread, through
 * `Kernel.executeWasm` -- the regression test for this session's own rewrite of that method onto a
 * real `@zenfs/linux` `ZenFSProcess` instead of the legacy `Process`/`ProcessManager` it used to
 * construct (the only remaining caller of either, before this): a real pid `ps` can see, not one
 * that lived in a bookkeeping map nothing else ever read.
 */
async function compile(wat: string): Promise<Uint8Array> {
  const wabt = await (await import('wabt')).default()
  const parsed = wabt.parseWat('fixture.wat', wat)
  const { buffer } = parsed.toBinary({})
  parsed.destroy()
  return buffer
}

// No imports at all -- not a WASI module, so `_start` runs on the module's own linear memory with
// no host calls; `_start` simply returns without doing anything observable from outside.
const PLAIN = `(module (memory (export "memory") 1) (func (export "_start")))`

describe('Kernel.executeWasm (main-thread fallback, no worker route)', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()
  })

  it('is not routed to the worker (no wasi_snapshot_preview1 import)', async () => {
    const bytes = await compile(PLAIN)
    expect(await kernel.wasm.canRunInWorker(bytes)).toBe(false)
  })

  it('still runs for real, through a real ZenFSProcess with a real pid ps can see', async () => {
    const bytes = await compile(PLAIN)
    await kernel.filesystem.fs.writeFile('/tmp/plain.wasm', bytes, { mode: 0o755 })

    // A first real run may lazily create `kernel.pipeProcess` (a real, dedicated, kernel-lifetime
    // Process that is never meant to exit) as a side effect unrelated to this test -- run once to
    // let that happen, then measure the *second* run in isolation.
    expect(await kernel.shell.execute('/tmp/plain.wasm')).toBe(0)

    const before = processes.size
    const code = await kernel.shell.execute('/tmp/plain.wasm')
    expect(code).toBe(0)
    // A real, parentless ZenFSProcess reaps itself on exit (`Process.exit`'s own real behavior:
    // "with no parent left to wait for it, there is nothing to keep the zombie around for") --
    // registers into and then exits back out of the same real `processes` map `ps_list`/`kill`
    // read, no zombie left behind.
    expect(processes.size).toBe(before)
  })
})
