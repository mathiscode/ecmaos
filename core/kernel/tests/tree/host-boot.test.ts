import { describe, expect, it } from 'vitest'

import type { Host } from '@ecmaos/types'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** Alone in its file: filesystem mounts are module-global, so only one kernel per file can boot. */
describe('host (boot)', () => {
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

  it('reads storage, hostname, notifications and restart through the host', async () => {
    const local = memoryStorage()
    const sent: string[] = []
    let restarted = 0
    let hostnameReads = 0

    const kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions,
      host: {
        kind: 'node',
        storage: { local, session: memoryStorage() },
        platform: {
          hostname: () => { hostnameReads++; return 'host-under-test' },
          restart: () => { restarted++ },
          notifications: { permission: () => 'granted', request: async () => undefined, send: async title => { sent.push(title) } }
        }
      } as Host
    })

    expect(kernel.host.kind).toBe('node')
    expect(kernel.storage.local).toBe(local)
    expect(kernel.storage.indexed).toBeUndefined()

    await kernel.notify('hello')
    expect(sent).toEqual(['hello'])

    await kernel.boot({ silent: true })
    expect(hostnameReads).toBeGreaterThan(0)
    expect(new TextDecoder().decode(await kernel.filesystem.fs.readFile('/etc/hostname'))).toBe('host-under-test\n')

    await kernel.reboot()
    expect(restarted).toBe(1)
  })
})
