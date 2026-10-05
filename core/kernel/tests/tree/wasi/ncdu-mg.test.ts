import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/**
 * `/bin/ncdu` and `/bin/mg` are curses programs built to WebAssembly with ncurses (`core/utils/wasm/ncdu`, `core/utils/wasm/mg`).
 * Their screens are checked by hand in a browser; here, what runs without a terminal.
 */
describe('ncdu and mg', () => {
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
    const code = await kernel.shell.execute(`${command} > /tmp/nm.out 2> /tmp/nm.err`)
    return { code, out: await kernel.filesystem.fs.readFile('/tmp/nm.out', 'utf8'), err: await kernel.filesystem.fs.readFile('/tmp/nm.err', 'utf8') }
  }

  it('ncdu scans a directory and exports sizes as JSON', async () => {
    const fs = kernel.filesystem.fs
    await fs.mkdir('/tmp/du/sub', { recursive: true })
    await fs.writeFile('/tmp/du/big.bin', new Uint8Array(40000))
    await fs.writeFile('/tmp/du/sub/small.txt', 'hi')
    const result = await run('ncdu -0 -o - /tmp/du')
    expect(result.code).toBe(0)
    const tree = JSON.parse(result.out)
    expect(tree[0]).toBe(1) // export format version
    const text = JSON.stringify(tree)
    expect(text).toContain('"name":"big.bin"')
    expect(text).toContain('"name":"small.txt"')
    expect(text).toContain('"asize":40000')
  }, 60000)

  it('ncdu reports a directory it cannot scan on stderr', async () => {
    const result = await run('ncdu -0 -o - /tmp/not-there')
    expect(result.err).toContain('No such file or directory')
  }, 60000)

  it('mg prints its usage and exits non-zero for an unknown option', async () => {
    const result = await run('mg --no-such-option')
    expect(result.code).toBe(1)
    expect(result.err).toContain('usage: mg')
  }, 60000)
})
