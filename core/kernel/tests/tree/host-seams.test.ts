import { describe, expect, it } from 'vitest'

import type { KernelDevice } from '@ecmaos/types'

import { Kernel } from '#kernel.ts'
import { DefaultDevices } from '#device.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** Seams a non-browser host relies on: a device that cannot initialise must not stop boot, and `boot()` must
 *  honour the filesystem options it was constructed with. */
describe('host seams', () => {
  it('boots when one device driver throws, and keeps the others', async () => {
    const broken = {
      pkg: { name: 'broken-test-device' },
      getDrivers: async () => { throw new Error('no such hardware') }
    } as unknown as KernelDevice

    const kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      devices: { ...DefaultDevices, broken },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })

    await kernel.boot()
    expect(kernel.devices.has('broken-test-device')).toBe(false)
    expect(await kernel.filesystem.fs.exists('/dev/battery')).toBe(true)
  })

  it('mounts the root filesystem given in the kernel options', async () => {
    const { InMemory } = await import('@zenfs/core')
    let created = 0
    const SpyRoot = { ...InMemory, create: (options: object) => { created++; return InMemory.create(options as never) } }

    const kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: {
        ...DefaultFilesystemOptions,
        mounts: { ...DefaultFilesystemOptions.mounts, '/': { backend: SpyRoot, options: { name: 'host-seam-root' } } }
      } as typeof DefaultFilesystemOptions,
      log: TestLogOptions
    })

    await kernel.boot()
    expect(created).toBeGreaterThan(0)
  })
})
