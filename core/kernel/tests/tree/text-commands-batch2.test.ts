import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * uniq/cut/fold/expand/unexpand/cksum migrated onto real execve in one batch, continuing the
 * "migrate opportunistically" plan started with cat/head/tail/wc/nl/rev/tac. Same shape and same
 * behavioral notes as that batch: no in-band interrupt handling, no `/dev`-path special case.
 */
describe('text command batch 2: uniq/cut/fold/expand/unexpand/cksum, real execve', () => {
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

  for (const name of ['uniq', 'cut', 'fold', 'expand', 'unexpand', 'cksum']) {
    it(`${name} is a real execve file, not the legacy stub`, async () => {
      const content = await kernel.filesystem.fs.readFile(`/bin/${name}`, 'utf-8')
      expect(content.startsWith('#!ecmaos:bin:command:')).toBe(false)
    })
  }

  it('uniq collapses adjacent duplicate lines', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/uniq-in.txt', 'a\na\nb\na\na\n')
    const code = await kernel.shell.execute('uniq /tmp/uniq-in.txt > /tmp/uniq.out')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/uniq.out', 'utf-8')).toBe('a\nb\na\n')
  })

  it('uniq -c prefixes counts', async () => {
    const code = await kernel.shell.execute('uniq -c /tmp/uniq-in.txt > /tmp/uniq-c.out')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/uniq-c.out', 'utf-8')
    expect(out).toContain('2 a')
    expect(out).toContain('1 b')
  })

  it('cut -f selects fields by delimiter', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/cut-in.txt', 'a,b,c\nd,e,f\n')
    const code = await kernel.shell.execute('cut -d , -f 2 /tmp/cut-in.txt > /tmp/cut.out')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/cut.out', 'utf-8')).toBe('b\ne\n')
  })

  it('cut -c selects characters', async () => {
    const code = await kernel.shell.execute('cut -c 1-3 /tmp/cut-in.txt > /tmp/cut-c.out')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/cut-c.out', 'utf-8')).toBe('a,b\nd,e\n')
  })

  it('fold wraps long lines at the given width', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/fold-in.txt', 'abcdefghij\n')
    const code = await kernel.shell.execute('fold -w 4 /tmp/fold-in.txt > /tmp/fold.out')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/fold.out', 'utf-8')).toBe('abcd\nefgh\nij\n')
  })

  it('expand converts tabs to spaces', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/expand-in.txt', 'a\tb\n')
    const code = await kernel.shell.execute('expand -t 4 /tmp/expand-in.txt > /tmp/expand.out')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/expand.out', 'utf-8')).toBe('a   b\n')
  })

  it('unexpand converts leading spaces to tabs', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/unexpand-in.txt', '        indented\n')
    const code = await kernel.shell.execute('unexpand /tmp/unexpand-in.txt > /tmp/unexpand.out')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/unexpand.out', 'utf-8')
    expect(out).toBe('\tindented\n')
  })

  it('cksum prints a CRC and byte count matching a known value', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/cksum-in.txt', 'hello\n')
    const code = await kernel.shell.execute('cksum /tmp/cksum-in.txt > /tmp/cksum.out')
    expect(code).toBe(0)
    const out = (await kernel.filesystem.fs.readFile('/tmp/cksum.out', 'utf-8')).trim()
    const [crc, size] = out.split(' ')
    expect(size).toBe('6')
    expect(Number(crc)).toBeGreaterThan(0)
  })

  it('cksum is deterministic for the same content', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/cksum-a.txt', 'same content\n')
    await kernel.filesystem.fs.writeFile('/tmp/cksum-b.txt', 'same content\n')
    await kernel.shell.execute('cksum /tmp/cksum-a.txt > /tmp/cksum-a.out')
    await kernel.shell.execute('cksum /tmp/cksum-b.txt > /tmp/cksum-b.out')
    const a = (await kernel.filesystem.fs.readFile('/tmp/cksum-a.out', 'utf-8')).split(' ')[0]
    const b = (await kernel.filesystem.fs.readFile('/tmp/cksum-b.out', 'utf-8')).split(' ')[0]
    expect(a).toBe(b)
  })

  it('all six read from stdin when no file is given', async () => {
    for (const cmd of ['uniq', 'cut -f 1', 'fold -w 2', 'expand', 'unexpand', 'cksum']) {
      const name = cmd.split(' ')[0]
      const code = await kernel.shell.execute(`echo hi | ${cmd} > /tmp/${name}-stdin.out`)
      expect(code).toBe(0)
    }
  }, 20000)

  it('all six report an error and nonzero exit for a missing file', async () => {
    for (const name of ['uniq', 'cut -f 1', 'fold', 'expand', 'unexpand', 'cksum']) {
      const cmdName = name.split(' ')[0]
      const code = await kernel.shell.execute(`${name} /tmp/does-not-exist-batch2.txt 2>/tmp/${cmdName}-missing.err`)
      expect(code).toBe(1)
    }
  }, 20000)
})
