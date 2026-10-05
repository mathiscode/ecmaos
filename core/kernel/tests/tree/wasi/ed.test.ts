import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/** `/bin/ed` is GNU ed built to WebAssembly (`core/utils-copyleft/wasm/ed`). It reads its commands from standard input, so a script drives it. */
describe('ed', () => {
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
    const code = await kernel.shell.execute(`${command} > /tmp/ed.out 2> /tmp/ed.err`)
    return { code, out: await kernel.filesystem.fs.readFile('/tmp/ed.out', 'utf8'), err: await kernel.filesystem.fs.readFile('/tmp/ed.err', 'utf8') }
  }

  it('edits a file from a script: substitute, append, delete, write', async () => {
    const fs = kernel.filesystem.fs
    await fs.writeFile('/tmp/e.txt', 'one\ntwo\nthree\n')
    await fs.writeFile('/tmp/e.ed', ['%s/t/T/g', '1a', 'inserted', '.', '$d', 'w', 'q', ''].join('\n'))
    const result = await run('ed -s /tmp/e.txt < /tmp/e.ed')
    expect(result.code).toBe(0)
    expect(await fs.readFile('/tmp/e.txt', 'utf8')).toBe('one\ninserted\nTwo\n')
  }, 60000)

  it('prints lines with p and n, reports the byte count, and searches with a regex', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/p.txt', 'alpha\nbeta\ngamma\n')
    const result = await run(`printf '/^b/p\\n2,3n\\nq\\n' | ed /tmp/p.txt`)
    expect(result.code).toBe(0)
    expect(result.out).toBe('17\nbeta\n2\tbeta\n3\tgamma\n')
  }, 60000)

  it('answers ? and exits non-zero for a command it cannot run in a script', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/q.txt', 'x\n')
    const result = await run(`printf 'zzz\\nq\\n' | ed -s /tmp/q.txt`)
    expect(result.out).toContain('?')
    expect(result.code).toBe(1)
  }, 60000)

  it('appends a file with r', async () => {
    const fs = kernel.filesystem.fs
    await fs.writeFile('/tmp/r.txt', 'head\n')
    await fs.writeFile('/tmp/r2.txt', 'tail\n')
    const result = await run(`printf '$r /tmp/r2.txt\\n,p\\nQ\\n' | ed -s /tmp/r.txt`)
    expect(result.out).toBe('head\ntail\n')
  }, 60000)
})
