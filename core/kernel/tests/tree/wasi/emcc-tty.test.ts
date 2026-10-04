import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/**
 * A real `emcc` build drives the terminal the way a full-screen editor does: `TCGETS`/`TCSETS` for
 * raw mode, `TIOCGWINSZ` for the size, and `poll` for the next key, all through `env.__syscall_*`.
 */
describe('an emcc program on a real terminal', () => {
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

  it('goes raw, sees the window size, polls for a key and restores the terminal', async () => {
    const { readFileSync } = process.getBuiltinModule('node:fs')
    const bytes = readFileSync(`${process.cwd()}/tests/tree/wasi/fixtures/emcc-tty.wasm`)
    await kernel.filesystem.fs.writeFile('/tmp/emcc-tty', new Uint8Array(bytes), { mode: 0o755 })

    const done = kernel.shell.execute('/tmp/emcc-tty > /tmp/emcc-tty.out')
    await waitFor(() => kernel.shell.foregroundJob?.processes.length === 1 && kernel.terminal.ttyInputAttached)
    await new Promise(resolve => setTimeout(resolve, 300))
    kernel.terminal.input('x', true)
    expect(await done).toBe(0)

    const out = await kernel.filesystem.fs.readFile('/tmp/emcc-tty.out', 'utf8')
    expect(out).toContain('isatty=1')
    expect(out).toMatch(/size=\d+x\d+ idle=0 poll=1 key=x/)
  })
})
