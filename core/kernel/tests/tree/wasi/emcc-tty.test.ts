import { beforeAll, describe, expect, it } from 'vitest'
import { lflags } from '@zenfs/linux/uapi/abi'

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
 * raw mode, `TIOCGWINSZ` for the size, and `poll` for the next key, all through `env.__syscall_*`. The same program
 * built on WALI's musl (`fixtures/wali.build.sh`) runs with the same assertions.
 */
describe('a program on a real terminal', () => {
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

  // one kernel for both builds: a second kernel's terminal would not be the one the first registered as a device
  it.each(['emcc', 'wali'])('goes raw, sees the window size, polls for a key and restores the terminal (%s)', async abi => {
    const { readFileSync } = process.getBuiltinModule('node:fs')
    const bytes = readFileSync(`${process.cwd()}/tests/tree/wasi/fixtures/${abi === 'wali' ? 'wali-rawtty' : 'emcc-tty'}.wasm`)
    await kernel.filesystem.fs.writeFile(`/tmp/${abi}-tty`, new Uint8Array(bytes), { mode: 0o755 })

    const done = kernel.shell.execute(`/tmp/${abi}-tty > /tmp/${abi}-tty.out`)
    // the key goes in once the program has made the terminal raw (a WALI program takes longer to start) and has
    // done its first, idle poll
    await waitFor(() => kernel.terminal.ttyInputAttached && (kernel.terminal.zfsTty!.termios.lflag & lflags.ICANON) === 0)
    await new Promise(resolve => setTimeout(resolve, 300))
    kernel.terminal.input('x', true)
    expect(await done).toBe(0)

    const out = await kernel.filesystem.fs.readFile(`/tmp/${abi}-tty.out`, 'utf8')
    expect(out).toContain('isatty=1')
    expect(out).toMatch(/size=\d+x\d+ idle=0 poll=1 key=x/)
  })
})
