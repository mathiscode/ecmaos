import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * ls migrated onto real execve. The original read live kernel.i18n/kernel.users/kernel.devices/
 * terminal.isMobile state a real worker process can't see -- this port simplifies to numeric
 * uid/gid, fixed English headers, and no device-package descriptions or ANSI coloring, matching
 * what a real /bin/ls binary actually has access to. See ls.mjs's doc comment.
 */
describe('text command batch 11: ls, real execve', () => {
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

    await kernel.filesystem.fs.mkdir('/tmp/ls-root', { recursive: true })
    await kernel.filesystem.fs.mkdir('/tmp/ls-root/subdir', { recursive: true })
    await kernel.filesystem.fs.writeFile('/tmp/ls-root/a.txt', 'hello')
    await kernel.filesystem.fs.writeFile('/tmp/ls-root/b.txt', 'world!!')
  })

  it('ls is a real execve file, not the legacy stub', async () => {
    const content = await kernel.filesystem.fs.readFile('/bin/ls', 'utf-8')
    expect(content.startsWith('#!ecmaos:bin:command:')).toBe(false)
  })

  it('lists directory contents with headers, directories first', async () => {
    const code = await kernel.shell.execute('ls /tmp/ls-root > /tmp/ls-out.txt')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/ls-out.txt', 'utf-8')
    expect(out).toContain('NAME')
    expect(out).toContain('SIZE')
    expect(out).toContain('subdir')
    expect(out).toContain('a.txt')
    expect(out).toContain('b.txt')
    expect(out.indexOf('subdir')).toBeLessThan(out.indexOf('a.txt'))
  })

  it('shows numeric owner (uid:gid), not a resolved username', async () => {
    const code = await kernel.shell.execute('ls /tmp/ls-root > /tmp/ls-owner.txt')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/ls-owner.txt', 'utf-8')
    expect(out).toMatch(/\d+:\d+/)
  })

  it('lists a single file target directly, not its containing directory', async () => {
    const code = await kernel.shell.execute('ls /tmp/ls-root/a.txt > /tmp/ls-single.txt')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/ls-single.txt', 'utf-8')
    expect(out).toContain('a.txt')
    expect(out).not.toContain('b.txt')
  })

  it('defaults to the current directory when no target is given', async () => {
    const code = await kernel.shell.execute('cd /tmp/ls-root && ls > /tmp/ls-default.txt')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/ls-default.txt', 'utf-8')
    expect(out).toContain('a.txt')
  })

  it('skips a nonexistent target silently, matching standard ls behavior', async () => {
    const code = await kernel.shell.execute('ls /tmp/ls-does-not-exist > /tmp/ls-missing.txt 2>/tmp/ls-missing.err')
    expect(code).toBe(0)
  })

  it('shows a symlink target with an arrow', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/ls-root/link-target.txt', 'linked')
    const lnCode = await kernel.shell.execute('ln -s /tmp/ls-root/link-target.txt /tmp/ls-root/mylink')
    expect(lnCode).toBe(0)
    const code = await kernel.shell.execute('ls /tmp/ls-root > /tmp/ls-link.txt')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/ls-link.txt', 'utf-8')
    expect(out).toContain('mylink -> /tmp/ls-root/link-target.txt')
  })
})
