import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * seq/factor/rmdir/join/paste/sleep/mktemp/shuf migrated onto real execve, continuing the "migrate
 * opportunistically" plan. mktemp uses crypto.getRandomValues (available in a Web Worker by spec,
 * unlike window/document); shuf uses plain Math.random(); sleep is a plain setTimeout wait, no
 * in-band interrupt polling (a real execve'd process is killed like any other on ^C). factor's
 * original interactive-TTY readline branch was dropped -- see factor.mjs's doc comment.
 */
describe('text command batch 4: seq/factor/rmdir/join/paste/sleep/mktemp/shuf, real execve', () => {
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

  for (const name of ['seq', 'factor', 'rmdir', 'join', 'paste', 'sleep', 'mktemp', 'shuf']) {
    it(`${name} is a real execve file, not the legacy stub`, async () => {
      const content = await kernel.filesystem.fs.readFile(`/bin/${name}`, 'utf-8')
      expect(content.startsWith('#!ecmaos:bin:command:')).toBe(false)
    })
  }

  it('seq prints a numeric range', async () => {
    const code = await kernel.shell.execute('seq 1 5 > /tmp/seq.out')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/seq.out', 'utf-8')).toBe('1\n2\n3\n4\n5')
  })

  it('factor prints prime factors of a number', async () => {
    const code = await kernel.shell.execute('factor 12 > /tmp/factor.out')
    expect(code).toBe(0)
    expect((await kernel.filesystem.fs.readFile('/tmp/factor.out', 'utf-8')).trim()).toBe('12: 2 2 3')
  })

  it('rmdir removes an empty directory', async () => {
    await kernel.filesystem.fs.mkdir('/tmp/rmdir-test', { recursive: true })
    const code = await kernel.shell.execute('rmdir /tmp/rmdir-test')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.exists('/tmp/rmdir-test')).toBe(false)
  })

  it('join merges two files on a common field', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/join-a.txt', '1 apple\n2 banana\n')
    await kernel.filesystem.fs.writeFile('/tmp/join-b.txt', '1 red\n2 yellow\n')
    const code = await kernel.shell.execute('join /tmp/join-a.txt /tmp/join-b.txt > /tmp/join.out')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/join.out', 'utf-8')
    expect(out).toContain('apple red')
    expect(out).toContain('banana yellow')
  })

  it('paste merges lines of two files side by side', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/paste-a.txt', 'a\nb\n')
    await kernel.filesystem.fs.writeFile('/tmp/paste-b.txt', '1\n2\n')
    const code = await kernel.shell.execute('paste /tmp/paste-a.txt /tmp/paste-b.txt > /tmp/paste.out')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/paste.out', 'utf-8')).toBe('a\t1\nb\t2\n')
  })

  it('sleep actually waits for roughly the requested duration', async () => {
    const start = Date.now()
    const code = await kernel.shell.execute('sleep 0.2')
    const elapsed = Date.now() - start
    expect(code).toBe(0)
    expect(elapsed).toBeGreaterThanOrEqual(150)
  })

  it('mktemp creates a real file and prints its path', async () => {
    const code = await kernel.shell.execute('mktemp > /tmp/mktemp.out')
    expect(code).toBe(0)
    const createdPath = (await kernel.filesystem.fs.readFile('/tmp/mktemp.out', 'utf-8')).trim()
    expect(createdPath).toMatch(/^\/tmp\/tmp\./)
    expect(await kernel.filesystem.fs.exists(createdPath)).toBe(true)
  })

  it('mktemp -d creates a real directory', async () => {
    const code = await kernel.shell.execute('mktemp -d > /tmp/mktemp-d.out')
    expect(code).toBe(0)
    const createdPath = (await kernel.filesystem.fs.readFile('/tmp/mktemp-d.out', 'utf-8')).trim()
    const stats = await kernel.filesystem.fs.stat(createdPath)
    expect(stats.isDirectory()).toBe(true)
  })

  it('shuf -e treats each argument as an input line and echoes back the same set', async () => {
    const code = await kernel.shell.execute('shuf -e a b c > /tmp/shuf.out')
    expect(code).toBe(0)
    const out = (await kernel.filesystem.fs.readFile('/tmp/shuf.out', 'utf-8')).trim().split('\n')
    expect(out.sort()).toEqual(['a', 'b', 'c'])
  })

  it('all report an error and nonzero exit for invalid input', async () => {
    const code1 = await kernel.shell.execute('seq abc 2>/tmp/seq-missing.err')
    expect(code1).toBe(1)
    const code2 = await kernel.shell.execute('join /tmp/does-not-exist-4-a.txt /tmp/does-not-exist-4-b.txt 2>/tmp/join-missing.err')
    expect(code2).toBe(1)
    const code3 = await kernel.shell.execute('rmdir /tmp/does-not-exist-rmdir-batch4 2>/tmp/rmdir-missing.err')
    expect(code3).toBe(1)
  }, 20000)
})
