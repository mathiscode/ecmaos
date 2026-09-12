import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * readlink/realpath/ln migrated onto real execve, continuing the "migrate opportunistically" plan.
 * These needed real link/symlink/readlink syscalls this interpreter didn't expose yet -- added to
 * globalThis.ecmaosSyscalls in /bin/node.mjs (plain pass-throughs of @zenfs/linux's own syscalls of
 * the same names). realpath never actually followed symlinks even in the original in-process
 * version (just path.resolve plus an optional existence check for -e) -- carried over unchanged.
 */
describe('text command batch 6: readlink/realpath/ln, real execve', () => {
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

  for (const name of ['readlink', 'realpath', 'ln']) {
    it(`${name} is a real execve file, not the legacy stub`, async () => {
      const content = await kernel.filesystem.fs.readFile(`/bin/${name}`, 'utf-8')
      expect(content.startsWith('#!ecmaos:bin:command:')).toBe(false)
    })
  }

  it('ln -s creates a real symlink, and readlink reads it back', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/ln-target.txt', 'hello')
    const lnCode = await kernel.shell.execute('ln -s /tmp/ln-target.txt /tmp/ln-link.txt')
    expect(lnCode).toBe(0)

    const code = await kernel.shell.execute('readlink /tmp/ln-link.txt > /tmp/readlink.out')
    expect(code).toBe(0)
    expect((await kernel.filesystem.fs.readFile('/tmp/readlink.out', 'utf-8')).trim()).toBe('/tmp/ln-target.txt')
  })

  it('ln (hard link) creates a real second directory entry for the same file', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/ln-hard-target.txt', 'hard link content')
    const code = await kernel.shell.execute('ln /tmp/ln-hard-target.txt /tmp/ln-hard-link.txt')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/ln-hard-link.txt', 'utf-8')).toBe('hard link content')
  })

  it('ln -f removes an existing destination before linking', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/ln-force-target.txt', 'new content')
    await kernel.filesystem.fs.writeFile('/tmp/ln-force-dest.txt', 'old content')
    const code = await kernel.shell.execute('ln -f /tmp/ln-force-target.txt /tmp/ln-force-dest.txt')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/ln-force-dest.txt', 'utf-8')).toBe('new content')
  })

  it('ln reports an error without -f when the destination already exists', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/ln-exists-target.txt', 'a')
    await kernel.filesystem.fs.writeFile('/tmp/ln-exists-dest.txt', 'b')
    const code = await kernel.shell.execute('ln /tmp/ln-exists-target.txt /tmp/ln-exists-dest.txt 2>/tmp/ln-exists.err')
    expect(code).toBe(1)
  })

  it('realpath prints an absolute path for a relative input', async () => {
    const code = await kernel.shell.execute('realpath tmp/realpath-in.txt > /tmp/realpath.out')
    expect(code).toBe(0)
    const out = (await kernel.filesystem.fs.readFile('/tmp/realpath.out', 'utf-8')).trim()
    expect(out.startsWith('/')).toBe(true)
    expect(out.endsWith('realpath-in.txt')).toBe(true)
  })

  it('realpath -e reports an error for a nonexistent path', async () => {
    const code = await kernel.shell.execute('realpath -e /tmp/does-not-exist-batch6.txt 2>/tmp/realpath-missing.err')
    expect(code).toBe(1)
  })

  it('readlink reports an error for a non-symlink file', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/readlink-plain.txt', 'not a link')
    const code = await kernel.shell.execute('readlink /tmp/readlink-plain.txt 2>/tmp/readlink-plain.err')
    expect(code).toBe(1)
  })
})
