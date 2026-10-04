import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** The checksum, encoding, size, compression and inspection commands. */
describe('text and file commands', () => {
  let kernel: Kernel
  let serial = 0
  const fs = () => kernel.filesystem.fs

  const sh = async (command: string) => {
    const base = `/tmp/cf-${serial++}`
    const code = await kernel.shell.execute(`cd /tmp/cf-work && ${command} > ${base}.out 2> ${base}.err`)
    const read = (suffix: string) => fs().readFile(`${base}.${suffix}`, 'utf-8').catch(() => '')
    return { code, out: await read('out'), err: await read('err') }
  }

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
    // jsdom defines `ontouchstart`, which makes the terminal skip the line discipline that saves and restores termios
    ;(kernel.terminal as unknown as { _isMobile: boolean })._isMobile = false
    await fs().mkdir('/tmp/cf-work', { recursive: true })
    await fs().writeFile('/tmp/cf-work/abc.txt', 'abc')
    await fs().writeFile('/tmp/cf-work/empty.txt', '')
    await fs().writeFile('/tmp/cf-work/hello.txt', 'hello world\n')
  }, 60000)

  describe('checksums', () => {
    const vectors: Array<[string, string, string, string]> = [
      ['md5sum', '', 'd41d8cd98f00b204e9800998ecf8427e', ''],
      ['md5sum', 'abc.txt', '900150983cd24fb0d6963f7d28e17f72', 'abc'],
      ['sha1sum', 'abc.txt', 'a9993e364706816aba3e25717850c26c9cd0d89d', 'abc'],
      ['sha256sum', 'abc.txt', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'abc'],
      ['sha384sum', 'abc.txt', 'cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7', 'abc'],
      ['sha512sum', 'abc.txt', 'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f', 'abc'],
    ]

    it.each(vectors)('%s gives the published sum for %s', async (command, file, sum, input) => {
      const result = file === '' ? await sh(`printf '${input}' | ${command}`) : await sh(`${command} ${file}`)
      expect(result.out).toBe(file === '' ? `${sum}  -\n` : `${sum}  ${file}\n`)
    }, 30000)

    it('md5 is right for text longer than one block, and across the padding boundaries', async () => {
      // known: 55, 56 and 64 byte inputs sit on the edges of MD5's padding
      const known: Record<number, string> = { 55: 'ef1772b6dff9a122358552954ad0df65', 56: '3b0c8ac703f828b04c6c197006d17218', 64: '014842d480b571495a4a0363793f7367' }
      for (const [length, sum] of Object.entries(known)) {
        await fs().writeFile(`/tmp/cf-work/a${length}`, 'a'.repeat(Number(length)))
        const result = await sh(`md5sum a${length}`)
        expect(result.out, `${length} bytes`).toBe(`${sum}  a${length}\n`)
      }
    }, 30000)

    it('prints several files, marks binary mode, and the BSD form', async () => {
      expect((await sh('md5sum abc.txt empty.txt')).out).toBe('900150983cd24fb0d6963f7d28e17f72  abc.txt\nd41d8cd98f00b204e9800998ecf8427e  empty.txt\n')
      expect((await sh('md5sum -b abc.txt')).out).toBe('900150983cd24fb0d6963f7d28e17f72 *abc.txt\n')
      expect((await sh('md5sum --tag abc.txt')).out).toBe('MD5 (abc.txt) = 900150983cd24fb0d6963f7d28e17f72\n')
    }, 30000)

    it('checks sums it wrote, and says which failed', async () => {
      await fs().writeFile('/tmp/cf-work/sums.txt', (await sh('sha256sum abc.txt hello.txt')).out)
      const good = await sh('sha256sum -c sums.txt')
      expect(good.out).toBe('abc.txt: OK\nhello.txt: OK\n')
      expect(good.code).toBe(0)
      await fs().writeFile('/tmp/cf-work/hello.txt', 'changed')
      const bad = await sh('sha256sum -c sums.txt')
      expect(bad.out).toBe('abc.txt: OK\nhello.txt: FAILED\n')
      expect(bad.code).toBe(1)
      expect(bad.err).toContain('1 computed checksum did NOT match')
      expect((await sh('sha256sum -c --status sums.txt')).out).toBe('')
      expect((await sh('sha256sum -c --quiet sums.txt')).out).toBe('hello.txt: FAILED\n')
      await fs().writeFile('/tmp/cf-work/hello.txt', 'hello world\n')
    }, 30000)

    it('reports a missing file', async () => {
      const result = await sh('md5sum nothing-here')
      expect(result.code).toBe(1)
      expect(result.err).toContain('nothing-here')
    }, 30000)

    it('hash takes md5 too', async () => {
      expect((await sh('hash -a md5 abc.txt')).out).toBe('900150983cd24fb0d6963f7d28e17f72  abc.txt\n')
    }, 30000)
  })

  describe('base64', () => {
    it('encodes with padding and decodes back', async () => {
      expect((await sh("printf 'hello' | base64")).out).toBe('aGVsbG8=\n')
      expect((await sh("printf 'hi' | base64")).out).toBe('aGk=\n')
      expect((await sh("printf 'abc' | base64")).out).toBe('YWJj\n')
      expect((await sh("printf 'aGVsbG8=' | base64 -d")).out).toBe('hello')
      expect((await sh("printf 'x' | base64 | base64 -d")).out).toBe('x')
    }, 30000)

    it('wraps at 76 columns by default, or where asked', async () => {
      await fs().writeFile('/tmp/cf-work/long.txt', 'x'.repeat(100))
      const wrapped = (await sh('base64 long.txt')).out.split('\n')
      expect(wrapped[0]).toHaveLength(76)
      expect((await sh('base64 -w 0 long.txt')).out.trimEnd().includes('\n')).toBe(false)
      expect((await sh('base64 -w 8 abc.txt')).out).toBe('YWJj\n')
    }, 30000)

    it('refuses what is not base64, and can skip garbage', async () => {
      expect((await sh("printf '!!!' | base64 -d")).code).toBe(1)
      expect((await sh("printf 'aG*Vsb G8=' | base64 -d -i")).out).toBe('hello')
    }, 30000)
  })

  describe('expr', () => {
    it('does arithmetic with the usual precedence', async () => {
      expect((await sh('expr 2 + 3')).out).toBe('5\n')
      expect((await sh('expr 2 + 3 \\* 4')).out).toBe('14\n')
      expect((await sh('expr \\( 2 + 3 \\) \\* 4')).out).toBe('20\n')
      expect((await sh('expr 7 / 2')).out).toBe('3\n')
      expect((await sh('expr 7 % 4')).out).toBe('3\n')
      expect((await sh('expr 5 - 8')).out).toBe('-3\n')
    }, 60000)

    it('compares numbers as numbers and anything else as strings', async () => {
      expect((await sh('expr 10 \\> 9')).out).toBe('1\n')
      expect((await sh('expr abc \\< abd')).out).toBe('1\n')
      expect((await sh('expr 1 = 2')).out).toBe('0\n')
      expect((await sh('expr 3 != 2')).out).toBe('1\n')
    }, 60000)

    it('has the string functions and the match operator', async () => {
      expect((await sh('expr length hello')).out).toBe('5\n')
      expect((await sh('expr substr hello 2 3')).out).toBe('ell\n')
      expect((await sh('expr index hello l')).out).toBe('3\n')
      expect((await sh("expr hello : 'h.*o'")).out).toBe('5\n')
      expect((await sh("expr hello : 'h\\(.*\\)o'")).out).toBe('ell\n')
      expect((await sh("expr hello : 'x'")).out).toBe('0\n')
    }, 60000)

    it('has | and &', async () => {
      expect((await sh("expr 0 \\| 7")).out).toBe('7\n')
      expect((await sh("expr 4 \\& 5")).out).toBe('4\n')
      expect((await sh("expr 0 \\& 5")).out).toBe('0\n')
    }, 60000)

    it('uses its status for truth, and 2 or 3 for trouble', async () => {
      expect((await sh('expr 1 + 1')).code).toBe(0)
      expect((await sh('expr 0')).code).toBe(1)
      expect((await sh("expr ''")).code).toBe(1)
      expect((await sh('expr 1 +')).code).toBe(2)
      expect((await sh('expr a + 1')).code).toBe(2)
      const zero = await sh('expr 1 / 0')
      expect(zero.code).toBe(3)
      expect(zero.err).toContain('division by zero')
      expect((await sh('expr')).code).toBe(2)
    }, 60000)
  })

  describe('du', () => {
    beforeAll(async () => {
      await fs().mkdir('/tmp/cf-du/a/b', { recursive: true })
      await fs().writeFile('/tmp/cf-du/a/f1', 'x'.repeat(2048))
      await fs().writeFile('/tmp/cf-du/a/b/f2', 'y'.repeat(1500))
      await fs().writeFile('/tmp/cf-du/top', 'z'.repeat(10))
    })

    it('lists directories depth first with sizes in KiB', async () => {
      expect((await sh('du /tmp/cf-du')).out).toBe('2\t/tmp/cf-du/a/b\n4\t/tmp/cf-du/a\n4\t/tmp/cf-du\n')
    }, 30000)

    it('shows files with -a, bytes with -b, and a summary with -s', async () => {
      expect((await sh('du -ab /tmp/cf-du/a')).out).toBe('1500\t/tmp/cf-du/a/b/f2\n1500\t/tmp/cf-du/a/b\n2048\t/tmp/cf-du/a/f1\n3548\t/tmp/cf-du/a\n')
      expect((await sh('du -sb /tmp/cf-du')).out).toBe('3558\t/tmp/cf-du\n')
      expect((await sh('du -s /tmp/cf-du')).out).toBe('4\t/tmp/cf-du\n')
    }, 30000)

    it('limits the depth, totals, and writes sizes people can read', async () => {
      expect((await sh('du -d 1 -b /tmp/cf-du')).out).toBe('1500\t/tmp/cf-du/a/b\n3548\t/tmp/cf-du/a\n3558\t/tmp/cf-du\n'.split('\n').filter(l => !l.includes('/a/b')).join('\n'))
      expect((await sh('du -sbc /tmp/cf-du/a /tmp/cf-du/top')).out).toBe('3548\t/tmp/cf-du/a\n10\t/tmp/cf-du/top\n3558\ttotal\n')
      expect((await sh('du -sh /tmp/cf-du/a')).out).toBe('3.5K\t/tmp/cf-du/a\n')
    }, 30000)

    it('uses the current directory by default, and reports a missing path', async () => {
      expect((await sh('du -sb')).out).toMatch(/^\d+\t\.\n$/)
      const missing = await sh('du /tmp/nothing-at-all')
      expect(missing.code).toBe(1)
      expect(missing.err).toContain('cannot access')
    }, 30000)
  })

  describe('egrep, fgrep and more', () => {
    it('egrep reads an extended pattern, fgrep a fixed string', async () => {
      await fs().writeFile('/tmp/cf-work/lines.txt', 'cat\ndog\nc.t\n')
      expect((await sh("egrep 'c(a|o)t|dog' lines.txt")).out).toBe('cat\ndog\n')
      expect((await sh("fgrep 'c.t' lines.txt")).out).toBe('c.t\n')
      expect((await sh("fgrep -c 'c' lines.txt")).out).toBe('2\n')
      expect((await sh("egrep nomatch lines.txt")).code).toBe(1)
    }, 30000)

    it('more shows a file', async () => {
      expect((await sh('more hello.txt')).out).toContain('hello world')
    }, 30000)
  })

  describe('chgrp', () => {
    it('changes the group by number or by name, and says what it did', async () => {
      await fs().writeFile('/tmp/cf-work/g.txt', 'x')
      expect((await sh('chgrp 7 g.txt')).code).toBe(0)
      expect((await fs().stat('/tmp/cf-work/g.txt')).gid).toBe(7)
      expect((await sh('chgrp -c 8 g.txt')).out).toContain("changed group of 'g.txt' to 8")
      expect((await sh('chgrp -v 8 g.txt')).out).toContain("retained as 8")
      expect((await sh('chgrp root g.txt')).code).toBe(0)
      expect((await fs().stat('/tmp/cf-work/g.txt')).gid).toBe(0)
    }, 30000)

    it('copies a group from a reference file, and refuses an unknown group', async () => {
      await fs().writeFile('/tmp/cf-work/ref.txt', 'x')
      await fs().chown('/tmp/cf-work/ref.txt', 0, 9)
      expect((await sh('chgrp --reference=ref.txt g.txt')).code).toBe(0)
      expect((await fs().stat('/tmp/cf-work/g.txt')).gid).toBe(9)
      const unknown = await sh('chgrp no-such-group g.txt')
      expect(unknown.code).toBe(1)
      expect(unknown.err).toContain('invalid group')
      expect((await sh('chgrp 1')).code).toBe(1)
    }, 30000)
  })

  describe('gzip, gunzip and zcat', () => {
    it('compresses a file, removing it, and gunzip restores it', async () => {
      await fs().writeFile('/tmp/cf-work/z.txt', 'compress me '.repeat(50))
      expect((await sh('gzip z.txt')).code).toBe(0)
      expect(await fs().exists('/tmp/cf-work/z.txt')).toBe(false)
      const packed = await fs().readFile('/tmp/cf-work/z.txt.gz')
      expect(packed[0]).toBe(0x1f)
      expect(packed[1]).toBe(0x8b)
      expect(packed.length).toBeLessThan(600)
      expect((await sh('gunzip z.txt.gz')).code).toBe(0)
      expect(await fs().readFile('/tmp/cf-work/z.txt', 'utf-8')).toBe('compress me '.repeat(50))
      expect(await fs().exists('/tmp/cf-work/z.txt.gz')).toBe(false)
    }, 30000)

    it('keeps the original with -k, writes to standard output with -c, and zcat reads', async () => {
      await fs().writeFile('/tmp/cf-work/k.txt', 'keep me\n')
      expect((await sh('gzip -k k.txt')).code).toBe(0)
      expect(await fs().exists('/tmp/cf-work/k.txt')).toBe(true)
      expect((await sh('zcat k.txt.gz')).out).toBe('keep me\n')
      expect((await sh('gzip -dc k.txt.gz')).out).toBe('keep me\n')
      expect((await sh('gzip -c k.txt | gunzip')).out).toBe('keep me\n')
      expect(await fs().exists('/tmp/cf-work/k.txt')).toBe(true)
    }, 30000)

    it('will not overwrite without -f, ignores a name with no suffix, and rejects what is not gzip', async () => {
      const again = await sh('gzip -k k.txt')
      expect(again.code).toBe(2)
      expect(again.err).toContain('already exists')
      expect((await sh('gzip -kf k.txt')).code).toBe(0)
      expect((await sh('gunzip hello.txt')).err).toContain('unknown suffix')
      await fs().writeFile('/tmp/cf-work/fake.gz', 'not gzip data')
      const fake = await sh('gunzip -t fake.gz')
      expect(fake.code).toBe(1)
      expect(fake.err).toContain('not in gzip format')
    }, 30000)

    it('tests a good file, and says gzip output can be read by it back through a pipe', async () => {
      expect((await sh('gzip -t k.txt.gz')).code).toBe(0)
      expect((await sh("printf 'round trip' | gzip | gunzip")).out).toBe('round trip')
    }, 30000)
  })

  describe('file', () => {
    it('knows text, and tells empty from data', async () => {
      expect((await sh('file -b hello.txt')).out).toBe('ASCII text\n')
      expect((await sh('file -b empty.txt')).out).toBe('empty\n')
      await fs().writeFile('/tmp/cf-work/bin.dat', new Uint8Array([0, 1, 2, 3, 255]))
      expect((await sh('file -b bin.dat')).out).toBe('data\n')
      await fs().writeFile('/tmp/cf-work/utf.txt', 'héllo\n')
      expect((await sh('file -b utf.txt')).out).toBe('Unicode text, UTF-8 text\n')
      await fs().writeFile('/tmp/cf-work/crlf.txt', 'a\r\nb\r\n')
      expect((await sh('file -b crlf.txt')).out).toBe('ASCII text, with CRLF line terminators\n')
    }, 30000)

    it('knows common signatures', async () => {
      const write = (name: string, bytes: number[]) => fs().writeFile(`/tmp/cf-work/${name}`, new Uint8Array(bytes))
      await write('s.png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 5, 0, 0, 0, 7])
      expect((await sh('file -b s.png')).out).toBe('PNG image data, 5 x 7\n')
      await write('s.pdf', [...new TextEncoder().encode('%PDF-1.7\n')])
      expect((await sh('file -b s.pdf')).out).toBe('PDF document, version 1.7\n')
      await write('s.wasm', [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])
      expect((await sh('file -b s.wasm')).out).toBe('WebAssembly (wasm) binary module\n')
      expect((await sh('file -b k.txt.gz')).out).toBe('gzip compressed data\n')
    }, 30000)

    it('knows scripts, JSON and HTML, directories and links', async () => {
      await fs().writeFile('/tmp/cf-work/run.sh', '#!/bin/sh\necho hi\n')
      expect((await sh('file -b run.sh')).out).toBe('Bourne-Again shell script, ASCII text executable\n')
      await fs().writeFile('/tmp/cf-work/d.json', '{"a": 1}\n')
      expect((await sh('file -b d.json')).out).toBe('JSON text data\n')
      await fs().writeFile('/tmp/cf-work/p.html', '<!DOCTYPE html>\n<html></html>\n')
      expect((await sh('file -b p.html')).out).toBe('HTML document, ASCII text\n')
      expect((await sh('file -b .')).out).toBe('directory\n')
      await fs().symlink('hello.txt', '/tmp/cf-work/ln').catch(() => {})
      expect((await sh('file -b ln')).out).toBe('symbolic link to hello.txt\n')
    }, 30000)

    it('prints names, MIME types, and reports a missing file', async () => {
      await fs().writeFile('/tmp/cf-work/nl.txt', 'x\n')
      expect((await sh('file nl.txt hello.txt')).out).toBe('nl.txt:    ASCII text\nhello.txt: ASCII text\n')
      expect((await sh('file -b abc.txt')).out).toBe('ASCII text, with no line terminators\n')
      expect((await sh('file -i hello.txt')).out).toBe('hello.txt: text/plain;charset=us-ascii\n')
      expect((await sh('file --mime-type -b hello.txt')).out).toBe('text/plain\n')
      const missing = await sh('file nothing-here')
      expect(missing.code).toBe(1)
      expect(missing.out).toContain('cannot open')
    }, 30000)
  })

  describe('hexdump', () => {
    it('shows the canonical form', async () => {
      expect((await sh("printf 'hello world\\n' | hexdump -C")).out).toBe(
        '00000000  68 65 6c 6c 6f 20 77 6f  72 6c 64 0a              |hello world.|\n0000000c\n')
    }, 30000)

    it('shows 16-bit words by default', async () => {
      expect((await sh("printf 'abcd' | hexdump")).out).toBe('0000000 6261 6463\n0000004\n')
      expect((await sh("printf 'abc' | hexdump")).out).toBe('0000000 6261 0063\n0000003\n')
    }, 30000)

    it('limits and skips, and squeezes repeated lines unless told not to', async () => {
      expect((await sh("printf '0123456789' | hexdump -C -s 2 -n 4")).out).toBe('00000002  32 33 34 35                                       |2345|\n00000006\n')
      await fs().writeFile('/tmp/cf-work/zeros', new Uint8Array(64))
      expect((await sh('hexdump -C zeros')).out).toBe('00000000  00 00 00 00 00 00 00 00  00 00 00 00 00 00 00 00  |................|\n*\n00000040\n')
      expect((await sh('hexdump -C -v zeros')).out.split('\n').length).toBe(6)
    }, 30000)

    it('reports a missing file', async () => {
      expect((await sh('hexdump nothing-here')).code).toBe(1)
    }, 30000)
  })

  describe('getent', () => {
    it('looks up users and groups by name or number, and lists a whole database', async () => {
      expect((await sh('getent passwd root')).out).toMatch(/^root:x:0:0:/)
      expect((await sh('getent passwd 0')).out).toMatch(/^root:/)
      expect((await sh('getent group root')).out).toMatch(/^root:x:0:/)
      expect((await sh('getent passwd')).out).toMatch(/^root:/)
    }, 30000)

    it('says 2 for a key that is not there, 1 for an unknown database', async () => {
      expect((await sh('getent passwd nobody-here')).code).toBe(2)
      expect((await sh('getent hosts localhost')).code).toBe(1)
      expect((await sh('getent')).code).toBe(1)
    }, 30000)
  })

  describe('stty and tput', () => {
    it('stty size and -a describe the terminal', async () => {
      expect((await sh('stty size')).out).toMatch(/^\d+ \d+\n$/)
      const all = await sh('stty -a')
      expect(all.out).toMatch(/speed 38400 baud; rows \d+; columns \d+;/)
      expect(all.out).toMatch(/\becho\b/)
      expect(all.out).toMatch(/\bicanon\b/)
    }, 30000)

    it('stty changes flags, and a change is undone when the program ends', async () => {
      const before = (await sh('stty -a')).out
      expect((await sh('stty -echo -icanon')).code).toBe(0)
      expect((await sh('stty -a')).out).toBe(before)
      expect((await sh('stty raw')).code).toBe(0)
      expect((await sh('stty sane')).code).toBe(0)
      const bad = await sh('stty nosuchsetting')
      expect(bad.code).toBe(1)
      expect(bad.err).toContain('invalid argument')
    }, 30000)

    it('tput gives sizes and the ANSI sequences', async () => {
      expect((await sh('tput cols')).out).toMatch(/^\d+\n$/)
      expect((await sh('tput lines')).out).toMatch(/^\d+\n$/)
      expect((await sh('tput colors')).out).toBe('256\n')
      expect((await sh('tput bold')).out).toBe('\x1b[1m')
      expect((await sh('tput sgr0')).out).toBe('\x1b[0m')
      expect((await sh('tput setaf 1')).out).toBe('\x1b[31m')
      expect((await sh('tput setab 9')).out).toBe('\x1b[101m')
      expect((await sh('tput setaf 200')).out).toBe('\x1b[38;5;200m')
      expect((await sh('tput cup 2 3')).out).toBe('\x1b[3;4H')
      expect((await sh('tput cuu 4')).out).toBe('\x1b[4A')
      expect((await sh('tput clear')).out).toBe('\x1b[H\x1b[2J')
      expect((await sh('tput -T xterm civis')).out).toBe('\x1b[?25l')
    }, 60000)

    it('tput refuses an unknown capability and a missing argument', async () => {
      expect((await sh('tput frobnicate')).code).toBe(1)
      expect((await sh('tput setaf')).code).toBe(1)
      expect((await sh('tput cup 1')).code).toBe(1)
      expect((await sh('tput')).code).toBe(1)
    }, 30000)
  })
})
