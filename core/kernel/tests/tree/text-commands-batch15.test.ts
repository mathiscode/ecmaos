import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * id/groups migrated onto real execve -- the first commands to use the `custom`/`syscall_async`
 * mechanism (window_create/storage_usage/ps_list's precedent) for a worker program, via a new
 * `users_lookup` custom syscall added to core/kernel/src/tree/lib/main-thread-syscalls.ts. Both
 * commands need live kernel.users registry lookups (groups even supports looking up a DIFFERENT
 * user by name) that have no execve-compatible equivalent otherwise -- this was the reason both were
 * deferred in earlier batches. `registerProcessKernel` now also stashes the spawning `Shell`
 * (`shellOfProcess`), needed only by `users_lookup`'s `mode: 'self'` case to read the calling
 * process's own live `Credentials` (uid/gid/euid/egid/groups) -- there's no real `getgroups` syscall
 * in `@zenfs/linux`, so this is the only way a worker program can see its own supplementary groups.
 */
describe('text command batch 15: id/groups, real execve', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()

    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
  })

  for (const name of ['id', 'groups']) {
    it(`${name} is a real execve file, not the legacy stub`, async () => {
      const content = await kernel.filesystem.fs.readFile(`/bin/${name}`, 'utf-8')
      expect(content.startsWith('#!ecmaos:bin:command:')).toBe(false)
    })
  }

  it('id prints uid/gid/groups for the current process', async () => {
    const code = await kernel.shell.execute('id > /tmp/id-out.txt')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/id-out.txt', 'utf-8')
    expect(out).toMatch(/^uid=\d+ gid=\d+ groups=/)
  })

  it('id -u prints only the numeric effective uid', async () => {
    const code = await kernel.shell.execute('id -u > /tmp/id-u-out.txt')
    expect(code).toBe(0)
    const out = (await kernel.filesystem.fs.readFile('/tmp/id-u-out.txt', 'utf-8')).trim()
    expect(out).toMatch(/^\d+$/)
  })

  it('id -un prints the username instead of a numeric uid', async () => {
    const code = await kernel.shell.execute('id -un > /tmp/id-un-out.txt')
    expect(code).toBe(0)
    const out = (await kernel.filesystem.fs.readFile('/tmp/id-un-out.txt', 'utf-8')).trim()
    expect(out).toBe('root')
  })

  it('groups prints the current user\'s own group membership', async () => {
    const code = await kernel.shell.execute('groups > /tmp/groups-out.txt')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/groups-out.txt', 'utf-8')
    expect(out).toContain('root :')
  })

  it('groups reports an error for a nonexistent username', async () => {
    const code = await kernel.shell.execute('groups totally-not-a-real-user-xyz 2>/tmp/groups-missing.err')
    expect(code).toBe(0)
    const err = await kernel.filesystem.fs.readFile('/tmp/groups-missing.err', 'utf-8')
    expect(err).toContain('no such user')
  })
})
