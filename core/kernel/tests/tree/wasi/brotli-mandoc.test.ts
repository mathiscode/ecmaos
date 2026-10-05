import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/** `/bin/brotli` and `/bin/mandoc` are C programs built to WebAssembly (`core/utils/wasm/brotli`, `core/utils/wasm/mandoc`). */
describe('brotli and mandoc', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()
  })

  const run = async (command: string) => {
    const code = await kernel.shell.execute(`${command} > /tmp/bm.out 2> /tmp/bm.err`)
    return { code, out: await kernel.filesystem.fs.readFile('/tmp/bm.out', 'utf8'), err: await kernel.filesystem.fs.readFile('/tmp/bm.err', 'utf8') }
  }

  it('brotli compresses a file, restores it, and works as a filter', async () => {
    const fs = kernel.filesystem.fs
    const original = 'the quick brown fox jumps over the lazy dog\n'.repeat(2000)
    await fs.writeFile('/tmp/b.txt', original)
    expect((await run('brotli /tmp/b.txt')).code).toBe(0)
    expect((await fs.readFile('/tmp/b.txt.br')).length).toBeLessThan(original.length / 20)
    expect((await run('brotli -d -c /tmp/b.txt.br | wc -c')).out.trim()).toBe(String(original.length))
    expect((await run('brotli -c < /tmp/b.txt | brotli -dc | wc -c')).out.trim()).toBe(String(original.length))
    expect((await run('brotli -d -f -o /tmp/b2.txt /tmp/b.txt.br')).code).toBe(0)
    expect(await fs.readFile('/tmp/b2.txt', 'utf8')).toBe(original)
  }, 60000)

  it('brotli rejects a file that is not brotli', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/notbr.br', 'plain text, not a brotli stream\n'.repeat(20))
    const bad = await run('brotli -d -c /tmp/notbr.br')
    expect(bad.code).not.toBe(0)
    expect(bad.err).not.toBe('')
  }, 60000)

  /** mandoc's ascii output marks bold and underline by overstriking (`X\bX`, `_\bX`), as nroff does. */
  const unbold = (text: string) => text.replace(/.\x08/g, '')

  const page = ['.Dd October 5, 2026', '.Dt TESTPAGE 1', '.Os', '.Sh NAME', '.Nm testpage', '.Nd a page for the test',
    '.Sh SYNOPSIS', '.Nm', '.Op Fl v', '.Ar file', '.Sh DESCRIPTION', 'Prints \\fBbold\\fP words.'].join('\n') + '\n'

  it('mandoc formats an mdoc page as text, Markdown and HTML', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/t.1', page)
    const text = await run('mandoc -T ascii /tmp/t.1')
    expect(text.code).toBe(0)
    expect(unbold(text.out)).toContain('TESTPAGE(1)')
    expect(unbold(text.out)).toMatch(/testpage\s+- a page for the test/i)
    expect((await run('mandoc -T markdown /tmp/t.1')).out).toContain('testpage')
    expect((await run('mandoc -T html -O fragment /tmp/t.1')).out).toContain('<h1')
  }, 60000)

  it('mandoc formats a man(7) page from stdin and lints a broken one', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/m.1', '.TH OLD 1\n.SH NAME\nold \\- a man page\n.SH DESCRIPTION\nBody text.\n')
    const text = await run('mandoc -T ascii < /tmp/m.1')
    expect(unbold(text.out)).toContain('OLD(1)')
    expect(unbold(text.out)).toContain('Body text.')
    await kernel.filesystem.fs.writeFile('/tmp/bad.1', '.Dd today\n.Dt BAD 1\n.Os\n.Sh NAME\n.Nm bad\n.Nd broken\n.Xx nonsense\n')
    const lint = await run('mandoc -T lint /tmp/bad.1')
    expect(lint.err + lint.out).toMatch(/unknown|invalid|bad|skipping|date/i)
  }, 60000)
})
