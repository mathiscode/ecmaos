import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/** `/bin/qjs` (QuickJS-ng) and `/bin/patch` (toybox) are C programs built to WebAssembly (`core/utils/wasm/quickjs`, `core/utils/wasm/toybox`). */
describe('qjs and patch', () => {
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
    const code = await kernel.shell.execute(`${command} > /tmp/qp.out 2> /tmp/qp.err`)
    return { code, out: await kernel.filesystem.fs.readFile('/tmp/qp.out', 'utf8'), err: await kernel.filesystem.fs.readFile('/tmp/qp.err', 'utf8') }
  }

  it('qjs evaluates an expression and runs a script with arguments, modules and the std library', async () => {
    expect(await run(`qjs -e 'console.log([1, 2, 3].map(x => x ** 2).join(","))'`)).toEqual({ code: 0, out: '1,4,9\n', err: '' })
    await kernel.filesystem.fs.writeFile('/tmp/q.mjs', `import * as std from 'qjs:std'\nimport * as os from 'qjs:os'\nconst text = std.loadFile('/tmp/q.txt')\nconsole.log(text.trim().toUpperCase(), scriptArgs.slice(1).join('+'), typeof os.getcwd()[0])\n`)
    await kernel.filesystem.fs.writeFile('/tmp/q.txt', 'hello\n')
    expect(await run('qjs /tmp/q.mjs a b')).toEqual({ code: 0, out: 'HELLO a+b string\n', err: '' })
  }, 60000)

  it('qjs reports an uncaught error on stderr with a non-zero exit, and exit() sets the status', async () => {
    const bad = await run(`qjs -e 'throw new Error("boom")'`)
    expect(bad.code).not.toBe(0)
    expect(bad.err).toContain('boom')
    expect((await run(`qjs -e 'import("qjs:std").then(s => s.exit(7))'`)).code).toBe(7)
  }, 60000)

  it('patch applies a unified diff, and -R undoes it', async () => {
    const fs = kernel.filesystem.fs
    await fs.mkdir('/tmp/pt', { recursive: true })
    await fs.writeFile('/tmp/pt/a.txt', 'one\ntwo\nthree\n')
    await fs.writeFile('/tmp/pt/fix.diff', '--- a.txt\n+++ a.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n')
    const applied = await run('cd /tmp/pt && patch -p0 < fix.diff')
    expect(applied.code).toBe(0)
    expect(await fs.readFile('/tmp/pt/a.txt', 'utf8')).toBe('one\nTWO\nthree\n')
    expect((await run('cd /tmp/pt && patch -R -p0 < fix.diff')).code).toBe(0)
    expect(await fs.readFile('/tmp/pt/a.txt', 'utf8')).toBe('one\ntwo\nthree\n')
  }, 60000)

  it('patch round-trips what diff -u produces, and fails on a hunk that does not apply', async () => {
    const fs = kernel.filesystem.fs
    await fs.writeFile('/tmp/pt/old.txt', 'a\nb\nc\nd\n')
    await fs.writeFile('/tmp/pt/new.txt', 'a\nB\nc\nd\ne\n')
    await kernel.shell.execute('diff -u /tmp/pt/old.txt /tmp/pt/new.txt > /tmp/pt/rt.diff')
    expect((await run('patch /tmp/pt/old.txt -i /tmp/pt/rt.diff')).code).toBe(0)
    expect(await fs.readFile('/tmp/pt/old.txt', 'utf8')).toBe('a\nB\nc\nd\ne\n')
    await fs.writeFile('/tmp/pt/other.txt', 'x\ny\n')
    const bad = await run('patch /tmp/pt/other.txt -i /tmp/pt/rt.diff')
    expect(bad.code).not.toBe(0)
  }, 60000)
})
