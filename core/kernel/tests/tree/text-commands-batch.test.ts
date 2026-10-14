import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * head/tail/wc/nl/rev/tac migrated onto real execve in one batch - all six are `cat`-shaped
 * (open/read a file or stdin, transform in memory, write the result), continuing the "migrate
 * opportunistically" plan. See `cat-command.test.ts` for why there's no in-band interrupt handling
 * or `/dev`-path special case anymore in any of these.
 */
describe('text command batch: head/tail/wc/nl/rev/tac, real execve', () => {
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

    await kernel.filesystem.fs.writeFile('/tmp/text-batch.txt', 'one\ntwo\nthree\nfour\nfive\n')
  })

  for (const name of ['head', 'tail', 'wc', 'nl', 'rev', 'tac']) {
    it(`${name} is a real execve file, not the legacy stub`, async () => {
      const content = await kernel.filesystem.fs.readFile(`/bin/${name}`, 'utf-8')
      expect(content.startsWith('#!ecmaos:bin:command:')).toBe(false)
    })
  }

  it('head prints the first N lines of a file', async () => {
    const code = await kernel.shell.execute('head -n 2 /tmp/text-batch.txt > /tmp/head.out')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/head.out', 'utf-8')).toBe('one\ntwo\n')
  })

  it('head -c prints the first N bytes', async () => {
    const code = await kernel.shell.execute('head -c 7 /tmp/text-batch.txt > /tmp/head-c.out')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/head-c.out', 'utf-8')).toBe('one\ntwo')
  })

  it('head reads from stdin when no file given', async () => {
    const code = await kernel.shell.execute('echo piped | head -n 1 > /tmp/head-stdin.out')
    expect(code).toBe(0)
    expect((await kernel.filesystem.fs.readFile('/tmp/head-stdin.out', 'utf-8')).trim()).toBe('piped')
  })

  describe('tail options', () => {
    const tail = async (args: string, input?: string) => {
      const source = input === undefined ? '' : ` < /tmp/tail.in`
      if (input !== undefined) await kernel.filesystem.fs.writeFile('/tmp/tail.in', input)
      const code = await kernel.shell.execute(`tail ${args}${source} > /tmp/tail.out 2> /tmp/tail.err`)
      return { code, out: await kernel.filesystem.fs.readFile('/tmp/tail.out', 'utf-8'), err: await kernel.filesystem.fs.readFile('/tmp/tail.err', 'utf-8') }
    }

    it('-c takes the last bytes, in every spelling', async () => {
      await kernel.filesystem.fs.writeFile('/tmp/tail.txt', 'abcdefghij\n')
      expect((await tail('-c 4 /tmp/tail.txt')).out).toBe('hij\n')
      expect((await tail('-c4 /tmp/tail.txt')).out).toBe('hij\n')
      expect((await tail('--bytes=4 /tmp/tail.txt')).out).toBe('hij\n')
      expect((await tail('-c +9 /tmp/tail.txt')).out).toBe('ij\n')
      expect((await tail('-c 1k /tmp/tail.txt')).out).toBe('abcdefghij\n')
      expect((await tail('-c 0 /tmp/tail.txt')).out).toBe('')
    })

    it('-n takes lines, +N starts at line N, a missing final newline is kept as it was', async () => {
      expect((await tail('-n 2', 'a\nb\nc\nd\n')).out).toBe('c\nd\n')
      expect((await tail('-n +3', 'a\nb\nc\nd\n')).out).toBe('c\nd\n')
      expect((await tail('--lines=1', 'a\nb\nc')).out).toBe('c')
      expect((await tail('-n 5', 'a\nb\n')).out).toBe('a\nb\n')
      expect((await tail('-2', 'a\nb\nc\n')).out).toBe('b\nc\n')
      expect((await tail('-n 0', 'a\n')).out).toBe('')
    })

    it('passes bytes through untouched, headers for several files, and -q hides them', async () => {
      await kernel.filesystem.fs.writeFile('/tmp/tail.bin', new Uint8Array([0xff, 0xfe, 10, 0x80, 10]))
      await tail('-c 4 /tmp/tail.bin')
      expect(Array.from(await kernel.filesystem.fs.readFile('/tmp/tail.out'))).toEqual([0xfe, 10, 0x80, 10])
      await kernel.filesystem.fs.writeFile('/tmp/tail.a', 'A\n')
      await kernel.filesystem.fs.writeFile('/tmp/tail.b', 'B\n')
      expect((await tail('/tmp/tail.a /tmp/tail.b')).out).toBe('==> /tmp/tail.a <==\nA\n\n==> /tmp/tail.b <==\nB\n')
      expect((await tail('-q /tmp/tail.a /tmp/tail.b')).out).toBe('A\nB\n')
      expect((await tail('-v /tmp/tail.a')).out).toBe('==> /tmp/tail.a <==\nA\n')
    })

    it('says what is wrong: a bad count, an unknown option, a missing file', async () => {
      expect(await tail('-n x /tmp/tail.a')).toMatchObject({ code: 1, err: "tail: invalid number of lines: 'x'\n" })
      expect((await tail('-z /tmp/tail.a')).err).toMatch(/invalid option -- 'z'/)
      const missing = await tail('/tmp/nope-tail')
      expect(missing.code).toBe(1)
      expect(missing.err).toMatch(/cannot open '\/tmp\/nope-tail' for reading: No such file or directory/)
    })
  })

  it('tail prints the last N lines of a file', async () => {
    const code = await kernel.shell.execute('tail -n 2 /tmp/text-batch.txt > /tmp/tail.out')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/tail.out', 'utf-8')).toBe('four\nfive\n')
  })

  // Real `wc` counts newline characters, not text "segments" - confirmed against a real `wc`:
  // `printf 'one\ntwo\nthree\nfour\nfive\n' | wc` reports "5 5 24", not "6 5 24". The previous
  // expected values here (6/6) matched wc.mjs's own prior off-by-one bug rather than real wc
  // semantics - fixed alongside that bug (see wc.mjs's countText doc comment).
  it('wc counts lines, words, and bytes', async () => {
    const code = await kernel.shell.execute('wc /tmp/text-batch.txt > /tmp/wc.out')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/wc.out', 'utf-8')
    // GNU pads the counts to the width of the file's size: 24 bytes is two digits
    expect(out).toBe(' 5  5 24 /tmp/text-batch.txt\n')
  })

  it('wc -l shows only the line count', async () => {
    const code = await kernel.shell.execute('wc -l /tmp/text-batch.txt > /tmp/wc-l.out')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/wc-l.out', 'utf-8')
    expect(out.trim()).toBe('5 /tmp/text-batch.txt')
  })

  it('nl numbers each line', async () => {
    const code = await kernel.shell.execute('nl /tmp/text-batch.txt > /tmp/nl.out')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/nl.out', 'utf-8')
    const lines = out.trim().split('\n')
    expect(lines[0]?.trim()).toBe('1\tone')
    expect(lines[4]?.trim()).toBe('5\tfive')
  })

  it('rev reverses the characters of each line', async () => {
    const code = await kernel.shell.execute('rev /tmp/text-batch.txt > /tmp/rev.out')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/rev.out', 'utf-8')
    expect(out).toBe('eno\nowt\neerht\nruof\nevif\n')
  })

  it('tac prints lines in reverse order', async () => {
    const code = await kernel.shell.execute('tac /tmp/text-batch.txt > /tmp/tac.out')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/tac.out', 'utf-8')
    expect(out).toBe('five\nfour\nthree\ntwo\none\n')
  })

  it('all six report an error and nonzero exit for a missing file', async () => {
    for (const name of ['head', 'tail', 'wc', 'nl', 'rev', 'tac']) {
      const code = await kernel.shell.execute(`${name} /tmp/does-not-exist-batch.txt 2>/tmp/${name}-missing.err`)
      expect(code).toBe(1)
    }
  }, 20000)
})
