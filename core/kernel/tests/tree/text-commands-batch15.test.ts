import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * `id` and `groups` as `execve` programs, using the `users_lookup` custom syscall for live `kernel.users` lookups.
 * `mode: 'self'` reads the calling process's `Credentials` through the spawning `Shell` (`shellOfProcess`), since
 * there is no `getgroups` syscall.
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
    // `groups=` must never be empty: a user's group list always begins with their primary group,
    // even when they have no supplementary memberships in `/etc/group`.
    expect(out).toMatch(/^uid=\d+\([^)]*\) gid=(\d+)\([^)]*\) groups=\1/)
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

  // GNU `groups` with no argument prints the bare list; the `username : ` prefix appears only when
  // usernames were named explicitly. The list starts with the user's primary group - reporting
  // only the supplementary groups (which is what `/etc/group` holds) printed nothing for root.
  it('groups prints the current user\'s own group membership, unprefixed', async () => {
    const code = await kernel.shell.execute('groups > /tmp/groups-out.txt')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/groups-out.txt', 'utf-8')
    expect(out).toBe('root\n')
  })

  it('groups prefixes the username when one is named explicitly', async () => {
    const code = await kernel.shell.execute('groups root > /tmp/groups-named.txt')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/groups-named.txt', 'utf-8')
    expect(out).toContain('root : root')
  })

  it('groups reports an error for a nonexistent username', async () => {
    const code = await kernel.shell.execute('groups totally-not-a-real-user-xyz 2>/tmp/groups-missing.err')
    expect(code).toBe(0)
    const err = await kernel.filesystem.fs.readFile('/tmp/groups-missing.err', 'utf-8')
    expect(err).toContain('no such user')
  })
})
