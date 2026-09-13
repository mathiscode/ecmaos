import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * chown migrated onto real execve, reusing the users_lookup custom syscall id.mjs/groups.mjs
 * already established for resolving usernames against the live kernel.users registry. The actual
 * ownership change uses a real chown syscall newly exposed on ecmaosSyscalls (@zenfs/linux already
 * had one; it just wasn't wired into node.mjs yet), same pattern as link/symlink/readlink/lstat
 * before it.
 */
describe('text command batch 16: chown, real execve', () => {
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

  it('chown is a real execve file, not the legacy stub', async () => {
    const content = await kernel.filesystem.fs.readFile('/bin/chown', 'utf-8')
    expect(content.startsWith('#!ecmaos:bin:command:')).toBe(false)
  })

  it('changes ownership to a numeric uid:gid', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/chown-numeric.txt', 'content')
    const code = await kernel.shell.execute('chown 5:6 /tmp/chown-numeric.txt')
    expect(code).toBe(0)
    const stat = await kernel.filesystem.fs.stat('/tmp/chown-numeric.txt')
    expect(stat.uid).toBe(5)
    expect(stat.gid).toBe(6)
  })

  it('changes ownership to a resolved username', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/chown-username.txt', 'content')
    const code = await kernel.shell.execute('chown root /tmp/chown-username.txt')
    expect(code).toBe(0)
    const stat = await kernel.filesystem.fs.stat('/tmp/chown-username.txt')
    expect(stat.uid).toBe(0)
  })

  it('changes group only with :GROUP syntax, keeping owner', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/chown-group-only.txt', 'content')
    await kernel.shell.execute('chown 42:0 /tmp/chown-group-only.txt')
    const code = await kernel.shell.execute('chown :7 /tmp/chown-group-only.txt')
    expect(code).toBe(0)
    const stat = await kernel.filesystem.fs.stat('/tmp/chown-group-only.txt')
    expect(stat.uid).toBe(42)
    expect(stat.gid).toBe(7)
  })

  it('-R on a directory errors, matching a pre-existing @zenfs/core limitation', async () => {
    // @zenfs/core's chown (both the async fs.promises.chown the original in-process version used,
    // and the real chown syscall this port uses) opens the target with the 'r+' flag before
    // chowning it, which fails with EISDIR for any directory -- confirmed identical in @zenfs/
    // core's own promises.js and sync.js. Since processFile's own chown call throws before it ever
    // reaches the recursion step, this means `chown -R somedir` fails on the directory itself and
    // never touches its contents either -- a genuine pre-existing backend limitation the original
    // in-process version already had, not a regression introduced by this migration.
    await kernel.filesystem.fs.mkdir('/tmp/chown-recursive', { recursive: true })
    await kernel.filesystem.fs.writeFile('/tmp/chown-recursive/a.txt', 'a')

    const code = await kernel.shell.execute('chown -R 9:9 /tmp/chown-recursive 2>/tmp/chown-recursive.err')
    expect(code).toBe(1)
    const err = await kernel.filesystem.fs.readFile('/tmp/chown-recursive.err', 'utf-8')
    expect(err).toContain('chown-recursive')

    const statA = await kernel.filesystem.fs.stat('/tmp/chown-recursive/a.txt')
    expect(statA.uid).toBe(0)
  })

  it('-v prints a diagnostic for every file processed', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/chown-verbose.txt', 'content')
    const code = await kernel.shell.execute('chown -v 3:3 /tmp/chown-verbose.txt > /tmp/chown-verbose.out')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/chown-verbose.out', 'utf-8')
    expect(out).toContain('changed ownership')
  })

  it('errors on an invalid username', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/chown-invalid.txt', 'content')
    const code = await kernel.shell.execute('chown totally-not-a-real-user-xyz /tmp/chown-invalid.txt 2>/tmp/chown-invalid.err')
    expect(code).toBe(1)
    const err = await kernel.filesystem.fs.readFile('/tmp/chown-invalid.err', 'utf-8')
    expect(err).toContain('Invalid user')
  })

  it('errors on a missing operand', async () => {
    const code = await kernel.shell.execute('chown 2>/tmp/chown-missing.err')
    expect(code).toBe(1)
  })
})
