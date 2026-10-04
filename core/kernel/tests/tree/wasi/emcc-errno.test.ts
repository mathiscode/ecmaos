import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/**
 * A program that compares `errno` to `ENOENT` (Vim deciding a missing file is a new file, not a
 * permission error) only works when `env.__syscall_*` returns the numbers emscripten compiled in.
 */
describe('an emcc program checking errno', () => {
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

  it('sees ENOENT and EISDIR from failed stat, open and rmdir calls', async () => {
    const { readFileSync } = process.getBuiltinModule('node:fs')
    const bytes = readFileSync(`${process.cwd()}/tests/tree/wasi/fixtures/emcc-errno.wasm`)
    await kernel.filesystem.fs.writeFile('/tmp/emcc-errno', new Uint8Array(bytes), { mode: 0o755 })

    expect(await kernel.shell.execute('/tmp/emcc-errno > /tmp/emcc-errno.out')).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/emcc-errno.out', 'utf8')).toBe('stat=1 open=1 rmdir=1 dir=1\n')
  })
})
