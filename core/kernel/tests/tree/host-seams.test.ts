import { describe, expect, it } from 'vitest'

import type { Host, KernelDevice } from '@ecmaos/types'

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

describe('host', () => {
  function memoryStorage(): Storage {
    const map = new Map<string, string>()
    return {
      get length() { return map.size },
      clear: () => map.clear(),
      getItem: key => map.get(key) ?? null,
      key: index => [...map.keys()][index] ?? null,
      removeItem: key => { map.delete(key) },
      setItem: (key, value) => { map.set(key, String(value)) }
    }
  }

  it('defaults to the browser host', async () => {
    const kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, log: TestLogOptions })
    expect(kernel.host.kind).toBe('browser')
    expect(kernel.storage.local).toBe(globalThis.localStorage)
  })

  it('applies the host defaults beneath the caller options', async () => {
    const host: Host = {
      kind: 'node',
      storage: { local: memoryStorage(), session: memoryStorage() },
      platform: { hostname: () => 'x', restart: () => {} },
      defaults: { service: { register: false }, programs: false }
    }

    const kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, log: TestLogOptions, host, programs: undefined })
    expect(kernel.service.options.register).toBe(false)
  })
})
