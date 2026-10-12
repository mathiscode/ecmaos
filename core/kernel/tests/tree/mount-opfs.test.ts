import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * `mount -t opfs` mounts the Origin Private File System through the `WebAccess` backend, without a picker. jsdom has
 * no `navigator.storage`, so this covers the "unavailable" guard in the command and in fstab processing; the real
 * mount is a manual check in a Chromium browser.
 */
describe('mount -t opfs', () => {
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

  it('fails with a clear error when navigator.storage.getDirectory is unavailable', async () => {
    expect('storage' in navigator).toBe(false)

    const code = await kernel.shell.execute('mount -t opfs /mnt/opfs-test > /tmp/mount-opfs.out 2>&1')
    expect(code).not.toBe(0)

    const output = await kernel.filesystem.fs.readFile('/tmp/mount-opfs.out', 'utf-8')
    expect(output).toMatch(/Origin Private File System is not available/)
  })

  it('is listed as a filesystem type that does not require a source', async () => {
    const code = await kernel.shell.execute('mount -t opfs somesource /mnt/opfs-with-source > /tmp/mount-opfs-source.out 2>&1')
    const output = await kernel.filesystem.fs.readFile('/tmp/mount-opfs-source.out', 'utf-8')

    // Two positional args + a no-source type is rejected before the availability check runs
    expect(code).not.toBe(0)
    expect(output).toMatch(/does not require a source/)
  })

  it('skips gracefully rather than throwing when an /etc/fstab entry requests opfs and it is unavailable', async () => {
    await kernel.filesystem.fs.writeFile('/etc/fstab', 'none /mnt/opfs-fstab opfs\n')
    await expect(kernel.loadFstab()).resolves.not.toThrow()
  })
})
