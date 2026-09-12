import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * `cat` migrated onto real execve (`core/utils/src/commands-execve/cat.mjs`) -- the first of the 90
 * remaining `@ecmaos/coreutils` legacy commands to move, continuing the "migrate opportunistically"
 * plan. No special in-band interrupt handling is needed in the worker-hosted version (unlike the old
 * in-process one, which polled `kernel.terminal.events`'s `INTERRUPT`) -- a real `execve`'d process
 * is killed like any other, matching real `cat`'s own SIGINT behavior.
 */
describe('cat command: real execve, plain filesystem/stdio syscalls only', () => {
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

  it('is a real execve file, not the legacy stub', async () => {
    const content = await kernel.filesystem.fs.readFile('/bin/cat', 'utf-8')
    expect(content.startsWith('#!ecmaos:bin:command:')).toBe(false)
  })

  it('prints the contents of a single file', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/cat-a.txt', 'hello world\n')
    const code = await kernel.shell.execute('cat /tmp/cat-a.txt > /tmp/cat-a.out')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/cat-a.out', 'utf-8')).toBe('hello world\n')
  })

  it('concatenates multiple files in order', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/cat-b.txt', 'first\n')
    await kernel.filesystem.fs.writeFile('/tmp/cat-c.txt', 'second\n')
    const code = await kernel.shell.execute('cat /tmp/cat-b.txt /tmp/cat-c.txt > /tmp/cat-bc.out')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/cat-bc.out', 'utf-8')).toBe('first\nsecond\n')
  })

  it('reports an error and a nonzero exit code for a missing file', async () => {
    const code = await kernel.shell.execute('cat /tmp/does-not-exist.txt > /tmp/cat-missing.out 2>/tmp/cat-missing.err')
    expect(code).toBe(1)
    const err = await kernel.filesystem.fs.readFile('/tmp/cat-missing.err', 'utf-8')
    expect(err).toContain('No such file or directory')
  })

  it('reports an error for a directory instead of hanging or crashing', async () => {
    await kernel.filesystem.fs.mkdir('/tmp/cat-dir', { recursive: true })
    const code = await kernel.shell.execute('cat /tmp/cat-dir > /tmp/cat-dir.out 2>/tmp/cat-dir.err')
    expect(code).toBe(1)
    const err = await kernel.filesystem.fs.readFile('/tmp/cat-dir.err', 'utf-8')
    expect(err).toContain('Is a directory')
  })

  it('echoes stdin back when no file is given', async () => {
    const code = await kernel.shell.execute('echo piped-in | cat > /tmp/cat-stdin.out')
    expect(code).toBe(0)
    expect((await kernel.filesystem.fs.readFile('/tmp/cat-stdin.out', 'utf-8')).trim()).toBe('piped-in')
  })
})
