import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/**
 * A program that compares `errno` to `ENOENT` (Vim deciding a missing file is a new file, not a
 * permission error) only works when `env.__syscall_*` returns the numbers emscripten compiled in. The same programs
 * built on WALI's musl (`fixtures/wali.build.sh`) run with the same assertions.
 */
describe.each(['emcc', 'wali'])('the %s build checking errno', abi => {
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
    const bytes = readFileSync(`${process.cwd()}/tests/tree/wasi/fixtures/${abi}-errno.wasm`)
    await kernel.filesystem.fs.writeFile(`/tmp/${abi}-errno`, new Uint8Array(bytes), { mode: 0o755 })

    expect(await kernel.shell.execute(`/tmp/${abi}-errno > /tmp/${abi}-errno.out`)).toBe(0)
    expect(await kernel.filesystem.fs.readFile(`/tmp/${abi}-errno.out`, 'utf8')).toBe('stat=1 open=1 rmdir=1 dir=1\n')
  })

  it('reads a directory to its end through several getdents calls, and again after rewinddir', async () => {
    const { readFileSync } = process.getBuiltinModule('node:fs')
    const bytes = readFileSync(`${process.cwd()}/tests/tree/wasi/fixtures/${abi}-readdir.wasm`)
    await kernel.filesystem.fs.writeFile(`/tmp/${abi}-readdir-bin`, new Uint8Array(bytes), { mode: 0o755 })

    expect(await kernel.shell.execute(`/tmp/${abi}-readdir-bin > /tmp/${abi}-readdir.out`)).toBe(0)
    // zenfs lists no . or .. entries
    expect(await kernel.filesystem.fs.readFile(`/tmp/${abi}-readdir.out`, 'utf8')).toBe('entries=300 rewound=300\n')
  }, 30000)
})
