import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { current as zenfsCurrent, define_syscall, dispatch, set_current } from '@zenfs/linux'
import type { Process } from '@zenfs/linux'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { installSyscallPolicy, invalidateManifestCache } from '#lib/syscall-policy.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * Manifest `devices` enforcement (`Kernel.registerDevices`'s dispatch, `syscall-policy.ts`'s
 * `getCachedManifest`) -- a real `/dev/battery` read, gated by a manifest written to disk and a
 * fake `current` process, exercising the actual synchronous chokepoint rather than mocking it.
 */
describe('manifest devices enforcement', () => {
  let kernel: Kernel
  let uniqueCounter = 0

  function fakeProcess(exe: string): Process {
    return { exe } as Process
  }

  /** Prime `syscall-policy.ts`'s manifest cache for `exe`, the same way a process's first real
   *  syscall would (device dispatch reads that cache synchronously, so it must exist before). */
  async function primeManifestCache(exe: string) {
    const name = `__device_test_syscall_${uniqueCounter++}`
    define_syscall(name as never, () => 0)
    installSyscallPolicy(kernel.filesystem.fs)
    await dispatch(fakeProcess(exe), name as never, [])
  }

  /** `/dev/battery`'s own read writes 18 bytes; readFile's default chunking undersizes the buffer
   *  it's called with, unrelated to this policy check -- read explicitly instead. */
  async function readBattery() {
    const handle = await kernel.filesystem.fs.open('/dev/battery', 'r')
    try {
      const buffer = new Uint8Array(32)
      await handle.read(buffer, 0, 32, 0)
      return buffer
    } finally {
      await handle.close()
    }
  }

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()
  })

  afterEach(() => { set_current(undefined) })
  afterAll(() => { invalidateManifestCache() })

  it('lets a process with no manifest read a device unrestricted', async () => {
    set_current(fakeProcess('/bin/unmanifested-device-test'))
    const buffer = await readBattery()
    expect(buffer.some(byte => byte !== 0)).toBe(true)
  })

  it('lets a manifest-declared process read a device it lists', async () => {
    const exe = '/bin/allowed-device-test'
    await kernel.filesystem.fs.writeFile(`${exe}.manifest.json`, JSON.stringify({ devices: ['battery'] }))
    invalidateManifestCache(exe)
    await primeManifestCache(exe)

    set_current(fakeProcess(exe))
    const buffer = await readBattery()
    expect(buffer.some(byte => byte !== 0)).toBe(true)
  })

  it('refuses a manifest-declared process reading a device it does not list', async () => {
    const exe = '/bin/restricted-device-test'
    await kernel.filesystem.fs.writeFile(`${exe}.manifest.json`, JSON.stringify({ devices: ['some-other-device'] }))
    invalidateManifestCache(exe)
    await primeManifestCache(exe)

    set_current(fakeProcess(exe))
    await expect(readBattery()).rejects.toThrow()
  })

  it('exposes the caller identity used above: current reflects set_current', () => {
    const proc = fakeProcess('/bin/current-check')
    set_current(proc)
    expect(zenfsCurrent).toBe(proc)
  })
})
