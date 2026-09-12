import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * strings/xxd/od/hash/cmp/comm/column migrated onto real execve, continuing the "migrate
 * opportunistically" plan. hash uses crypto.subtle.digest (Web Crypto), available inside a Web
 * Worker by spec, unlike window/document -- no bridge needed. column bundles `columnify` (a plain
 * npm package) the same way df/install already bundle human-format/semver. Same behavioral notes
 * as prior batches: no in-band interrupt handling, no /dev-path special case.
 */
describe('text command batch 3: strings/xxd/od/hash/cmp/comm/column, real execve', () => {
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

  for (const name of ['strings', 'xxd', 'od', 'hash', 'cmp', 'comm', 'column']) {
    it(`${name} is a real execve file, not the legacy stub`, async () => {
      const content = await kernel.filesystem.fs.readFile(`/bin/${name}`, 'utf-8')
      expect(content.startsWith('#!ecmaos:bin:command:')).toBe(false)
    })
  }

  it('strings extracts printable runs at least 4 chars long', async () => {
    const bytes = new Uint8Array([0, 0, ...Array.from('hello').map(c => c.charCodeAt(0)), 0, 0, 65, 66, 0])
    await kernel.filesystem.fs.writeFile('/tmp/strings-in.bin', bytes)
    const code = await kernel.shell.execute('strings /tmp/strings-in.bin > /tmp/strings.out')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/strings.out', 'utf-8')
    expect(out.trim()).toBe('hello')
  })

  it('xxd dumps bytes in hex with an ASCII gutter', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/xxd-in.txt', 'AB')
    const code = await kernel.shell.execute('xxd /tmp/xxd-in.txt > /tmp/xxd.out')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/xxd.out', 'utf-8')
    expect(out).toContain('4142')
    expect(out).toContain('AB')
  })

  it('od dumps bytes in octal by default', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/od-in.txt', 'A')
    const code = await kernel.shell.execute('od /tmp/od-in.txt > /tmp/od.out')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/od.out', 'utf-8')
    expect(out.trim()).toContain('101')
  })

  it('hash computes a real SHA-256 digest matching a known value', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/hash-in.txt', 'hello')
    const code = await kernel.shell.execute('hash /tmp/hash-in.txt > /tmp/hash.out')
    expect(code).toBe(0)
    const out = (await kernel.filesystem.fs.readFile('/tmp/hash.out', 'utf-8')).trim()
    expect(out.split(/\s+/)[0]).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  })

  it('cmp reports identical files as equal (exit 0)', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/cmp-a.txt', 'same')
    await kernel.filesystem.fs.writeFile('/tmp/cmp-b.txt', 'same')
    const code = await kernel.shell.execute('cmp /tmp/cmp-a.txt /tmp/cmp-b.txt')
    expect(code).toBe(0)
  })

  it('cmp reports differing files as unequal (exit 1)', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/cmp-c.txt', 'aaa')
    await kernel.filesystem.fs.writeFile('/tmp/cmp-d.txt', 'aab')
    const code = await kernel.shell.execute('cmp /tmp/cmp-c.txt /tmp/cmp-d.txt 2>/tmp/cmp.err')
    expect(code).toBe(1)
  })

  it('comm merges two sorted files into three columns', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/comm-a.txt', 'apple\nbanana\ncherry\n')
    await kernel.filesystem.fs.writeFile('/tmp/comm-b.txt', 'banana\ncherry\ndate\n')
    const code = await kernel.shell.execute('comm /tmp/comm-a.txt /tmp/comm-b.txt > /tmp/comm.out')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/comm.out', 'utf-8')
    expect(out).toContain('apple')
    expect(out).toContain('date')
  })

  it('column splits whitespace-separated input into words', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/column-in.txt', 'a b c\n')
    const code = await kernel.shell.execute('column /tmp/column-in.txt > /tmp/column.out')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/column.out', 'utf-8')
    expect(out.trim().split('\n')).toEqual(['a', 'b', 'c'])
  })

  it('all seven report an error and nonzero exit for a missing file', async () => {
    for (const cmd of ['strings', 'xxd', 'od', 'hash', 'cmp /tmp/does-not-exist-batch3.txt /tmp/does-not-exist-batch3.txt', 'comm /tmp/does-not-exist-batch3.txt /tmp/does-not-exist-batch3.txt', 'column']) {
      const cmdName = cmd.split(' ')[0]
      const code = cmd.includes(' ')
        ? await kernel.shell.execute(`${cmd} 2>/tmp/${cmdName}-missing.err`)
        : await kernel.shell.execute(`${cmd} /tmp/does-not-exist-batch3.txt 2>/tmp/${cmdName}-missing.err`)
      expect(code).toBe(1)
    }
  }, 20000)
})
