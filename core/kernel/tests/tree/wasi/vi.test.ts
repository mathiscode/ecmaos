import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/**
 * `/bin/vi` is busybox's vi built to WebAssembly (`wasm/vi/build.sh`), run as an ordinary worker
 * program on the terminal: raw mode, window size and `poll` come from `wasi-preview1.mjs`.
 */
describe('vi', () => {
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
    ;(kernel.terminal as unknown as { _isMobile: boolean })._isMobile = false
  })

  const typeKeys = async (keys: string) => {
    for (const key of keys) {
      kernel.terminal.input(key, true)
      // vi reads Esc followed quickly by another key as one escape sequence
      await new Promise(resolve => setTimeout(resolve, key === '\x1b' ? 400 : 40))
    }
  }

  const edit = async (command: string, keys: string) => {
    const done = kernel.shell.execute(command)
    await waitFor(() => kernel.shell.foregroundJob?.processes.length === 1 && kernel.terminal.ttyInputAttached)
    await new Promise(resolve => setTimeout(resolve, 1500))
    await typeKeys(keys)
    return done
  }

  it('is installed, and edits, searches by regex, substitutes and saves a file', async () => {
    const code = await edit('vi /tmp/vi-out.txt', 'ifoo bar foo\x1b:%s/fo\\+/baz/g\r/bar\rcwqux\x1b:wq\r')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/vi-out.txt', 'utf8')).toBe('baz qux baz\n')
  }, 30000)

  it('opens an existing file and leaves it alone on :q!', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/vi-keep.txt', 'keep me\n')
    const code = await edit('vi /tmp/vi-keep.txt', 'dd\x1b:q!\r')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/vi-keep.txt', 'utf8')).toBe('keep me\n')
  }, 30000)

  it('has no vim alias: vim is the real Vim, a separate program', async () => {
    const lstat = await kernel.filesystem.fs.lstat('/bin/vim')
    expect(lstat.isSymbolicLink()).toBe(false)
  })
})
