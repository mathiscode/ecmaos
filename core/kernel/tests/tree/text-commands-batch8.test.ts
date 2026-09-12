import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** sort migrated onto real execve. See sort.mjs's doc comment. */
describe('text command batch 8: sort, real execve', () => {
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

  it('sort is a real execve file, not the legacy stub', async () => {
    const content = await kernel.filesystem.fs.readFile('/bin/sort', 'utf-8')
    expect(content.startsWith('#!ecmaos:bin:command:')).toBe(false)
  })

  it('sorts lines of a file alphabetically', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/sort-in.txt', 'banana\napple\ncherry\n')
    const code = await kernel.shell.execute('sort /tmp/sort-in.txt > /tmp/sort-out.txt')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/sort-out.txt', 'utf-8')).toBe('apple\nbanana\ncherry\n')
  })

  it('sorts in reverse with -r', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/sort-rev-in.txt', 'apple\nbanana\ncherry\n')
    const code = await kernel.shell.execute('sort -r /tmp/sort-rev-in.txt > /tmp/sort-rev-out.txt')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/sort-rev-out.txt', 'utf-8')).toBe('cherry\nbanana\napple\n')
  })

  it('sorts numerically with -n', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/sort-num-in.txt', '10\n2\n1\n')
    const code = await kernel.shell.execute('sort -n /tmp/sort-num-in.txt > /tmp/sort-num-out.txt')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/sort-num-out.txt', 'utf-8')).toBe('1\n2\n10\n')
  })

  it('deduplicates with -u', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/sort-uniq-in.txt', 'b\na\nb\na\nc\n')
    const code = await kernel.shell.execute('sort -u /tmp/sort-uniq-in.txt > /tmp/sort-uniq-out.txt')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/sort-uniq-out.txt', 'utf-8')).toBe('a\nb\nc\n')
  })

  it('reads from stdin when no file is given', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/sort-pipe-in.txt', 'z\ny\nx\n')
    const code = await kernel.shell.execute('cat /tmp/sort-pipe-in.txt | sort > /tmp/sort-pipe-out.txt')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/sort-pipe-out.txt', 'utf-8')).toBe('x\ny\nz\n')
  })

  it('merges lines from multiple files', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/sort-multi-a.txt', 'c\na\n')
    await kernel.filesystem.fs.writeFile('/tmp/sort-multi-b.txt', 'd\nb\n')
    const code = await kernel.shell.execute('sort /tmp/sort-multi-a.txt /tmp/sort-multi-b.txt > /tmp/sort-multi-out.txt')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/sort-multi-out.txt', 'utf-8')).toBe('a\nb\nc\nd\n')
  })

  it('reports an error for a missing file but keeps a zero exit code, matching the original', async () => {
    const code = await kernel.shell.execute('sort /tmp/sort-does-not-exist.txt 2>/tmp/sort-missing.err')
    expect(code).toBe(0)
    const err = await kernel.filesystem.fs.readFile('/tmp/sort-missing.err', 'utf-8')
    expect(err).toContain('sort:')
  })
})
