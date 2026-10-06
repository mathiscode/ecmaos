import { describe, expect, it } from 'vitest'

import type { Host } from '@ecmaos/types'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

// A booted kernel owns the module-global mounts, so this boots the only one in its file
describe('host sources', () => {

  it('reads the initfs and the program catalog the options name, through the host\'s fetch', async () => {
    const asked: string[] = []
    const host: Host = {
      kind: 'node',
      storage: { local: { length: 0, clear() {}, getItem: () => null, key: () => null, removeItem() {}, setItem() {} }, session: { length: 0, clear() {}, getItem: () => null, key: () => null, removeItem() {}, setItem() {} } },
      platform: { hostname: () => 'seam', restart() {} },
      fetch: async url => { asked.push(url); return new Response('no', { status: 404 }) }
    }
    const kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      host,
      initfs: 'seam:/initfs.tar.gz',
      log: TestLogOptions,
      programs: 'seam:/programs/index.json'
    })

    await kernel.boot()
    expect(asked).toContain('seam:/initfs.tar.gz')
    expect(asked).toContain('seam:/programs/index.json')
  })
})
