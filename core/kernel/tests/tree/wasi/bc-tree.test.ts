import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { PROGRAMS_ALL, TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/** `/bin/bc` (and `dc`, a link to it) and `/bin/tree` are C programs built to WebAssembly (`core/utils/wasm/bc`, `core/utils-copyleft/wasm/tree`). */
describe('bc, dc and tree', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions,
      programs: PROGRAMS_ALL
    })
    await kernel.boot()
  })

  const run = async (command: string) => {
    const code = await kernel.shell.execute(`${command} > /tmp/bt.out 2> /tmp/bt.err`)
    return {
      code,
      out: await kernel.filesystem.fs.readFile('/tmp/bt.out', 'utf8'),
      err: await kernel.filesystem.fs.readFile('/tmp/bt.err', 'utf8')
    }
  }

  it('bc does arbitrary-precision arithmetic from standard input', async () => {
    expect(await run(`echo '2^100; scale=20; 1/3; sqrt(2)' | bc`)).toEqual({
      code: 0,
      out: '1267650600228229401496703205376\n.33333333333333333333\n1.41421356237309504880\n',
      err: ''
    })
  }, 30000)

  it('bc -l has the math library, and a syntax error exits non-zero on stderr', async () => {
    expect((await run(`echo 'scale=10; a(1)*4' | bc -l`)).out).toBe('3.1415926532\n')
    const bad = await run(`echo '1 +* 2' | bc`)
    expect(bad.code).not.toBe(0)
    expect(bad.err).not.toBe('')
  }, 30000)

  it('dc is bc under another name', async () => {
    expect(await run(`echo '2 3 + 4 * p' | dc`)).toEqual({ code: 0, out: '20\n', err: '' })
  }, 30000)

  it('tree lists a directory as a tree', async () => {
    const fs = kernel.filesystem.fs
    await fs.mkdir('/tmp/treetest/a/b', { recursive: true })
    await fs.writeFile('/tmp/treetest/a/one.txt', '1')
    await fs.writeFile('/tmp/treetest/a/b/two.txt', '2')
    await fs.writeFile('/tmp/treetest/top.txt', '3')
    const result = await run(`tree --charset=ascii /tmp/treetest`)
    expect(result.code).toBe(0)
    expect(result.out).toBe(
      ['/tmp/treetest', '|-- a', '|   |-- b', '|   |   `-- two.txt', '|   `-- one.txt', '`-- top.txt', '', '3 directories, 3 files', ''].join('\n')
    )
  }, 30000)

  it('tree takes -L, -a and a pattern', async () => {
    expect((await run(`tree --charset=ascii -L 1 -n /tmp/treetest`)).out).toContain('2 directories') // the root and a; b is below the depth limit
    expect((await run(`tree --charset=ascii -P '*.txt' --prune /tmp/treetest`)).out).toContain('3 files')
  }, 30000)
})
