import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

describe('a file unlinked while open', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
  })

  it('reads the hole ftruncate left as zeros, keeps what was written, and closes without an error', async () => {
    const fs = kernel.filesystem.fs
    const handle = await fs.open('/tmp/unlinked-hole', 'w+')
    await handle.write(new Uint8Array([1, 2, 3, 4]), 0, 4, 0)
    await handle.truncate(8192)
    await fs.unlink('/tmp/unlinked-hole')

    const hole = new Uint8Array(4096).fill(9)
    expect((await handle.read(hole, 0, 4096, 4096)).bytesRead).toBe(4096)
    expect(hole.every(byte => byte === 0)).toBe(true)
    const head = new Uint8Array(4)
    await handle.read(head, 0, 4, 0)
    expect([...head]).toEqual([1, 2, 3, 4])
    await expect(handle.close()).resolves.toBeUndefined()
  })
})
