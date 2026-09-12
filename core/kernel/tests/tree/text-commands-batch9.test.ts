import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * find migrated onto real execve. Needed a real lstat-backed isSymbolicLink (added to
 * globalThis.ecmaosSyscalls in /bin/node.mjs) since plain stat follows symlinks and can't tell
 * -type l apart on its own. See find.mjs's doc comment.
 */
describe('text command batch 9: find, real execve', () => {
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

    await kernel.filesystem.fs.mkdir('/tmp/find-root', { recursive: true })
    await kernel.filesystem.fs.mkdir('/tmp/find-root/subdir', { recursive: true })
    await kernel.filesystem.fs.writeFile('/tmp/find-root/a.txt', 'a')
    await kernel.filesystem.fs.writeFile('/tmp/find-root/b.log', 'b')
    await kernel.filesystem.fs.writeFile('/tmp/find-root/subdir/c.txt', 'c')
  })

  it('find is a real execve file, not the legacy stub', async () => {
    const content = await kernel.filesystem.fs.readFile('/bin/find', 'utf-8')
    expect(content.startsWith('#!ecmaos:bin:command:')).toBe(false)
  })

  it('lists all entries recursively with no filters', async () => {
    const code = await kernel.shell.execute('find /tmp/find-root > /tmp/find-all.out')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/find-all.out', 'utf-8')
    expect(out).toContain('/tmp/find-root/a.txt')
    expect(out).toContain('/tmp/find-root/b.log')
    expect(out).toContain('/tmp/find-root/subdir')
    expect(out).toContain('/tmp/find-root/subdir/c.txt')
  })

  it('filters by -name pattern', async () => {
    const code = await kernel.shell.execute('find /tmp/find-root -name "*.txt" > /tmp/find-name.out')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/find-name.out', 'utf-8')
    expect(out).toContain('a.txt')
    expect(out).toContain('c.txt')
    expect(out).not.toContain('b.log')
  })

  it('filters by -type d', async () => {
    const code = await kernel.shell.execute('find /tmp/find-root -type d > /tmp/find-type-d.out')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/find-type-d.out', 'utf-8')
    expect(out.trim()).toBe('/tmp/find-root/subdir')
  })

  it('filters by -type f', async () => {
    const code = await kernel.shell.execute('find /tmp/find-root -type f > /tmp/find-type-f.out')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/find-type-f.out', 'utf-8')
    expect(out).toContain('a.txt')
    expect(out).toContain('b.log')
    expect(out).toContain('c.txt')
    expect(out).not.toContain('subdir\n')
  })

  it('defaults to the current directory when args are given but no positional path', async () => {
    const code = await kernel.shell.execute('cd /tmp/find-root && find -name "*.txt" > /tmp/find-default.out')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/find-default.out', 'utf-8')
    expect(out).toContain('a.txt')
  })

  it('errors with no arguments at all, matching the original', async () => {
    const code = await kernel.shell.execute('find 2>/tmp/find-noargs.err')
    expect(code).toBe(1)
  })

  it('errors when given a non-directory path but still exits 0, matching the original', async () => {
    const code = await kernel.shell.execute('find /tmp/find-root/a.txt 2>/tmp/find-notdir.err')
    expect(code).toBe(0)
    const err = await kernel.filesystem.fs.readFile('/tmp/find-notdir.err', 'utf-8')
    expect(err).toContain('not a directory')
  })
})
