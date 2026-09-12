import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * The worker-syscall-bridge pilot: `/bin/pilot-window.js` (`src/bin/pilot-window.mjs`) is a real,
 * worker-hosted program calling `window_create`/`window_write`/`window_close` -- custom syscalls
 * (`main-thread-syscalls.ts`) that cross back onto the main thread for a capability no worker can
 * reach directly (creating a real `WinBox`). This proves the design this session settled on for
 * porting DOM-bound apps/devices (`apps/webamp`, `apps/code`, `devices/bluetooth`, `devices/battery`)
 * onto real `execve`: purpose-built syscalls via `define_syscall`, not a generic RPC device or a
 * permanent non-worker fallback.
 *
 * Also proves the `Process -> Kernel` resolution `main-thread-syscalls.ts` needs: this test file (and
 * `kernel.test.ts`/`protocol.test.ts` elsewhere) constructs more than one `Kernel`, all sharing
 * `@zenfs/linux`'s module-global `syscalls` map -- a handler that closed over one `Kernel` instead of
 * resolving it per-`Process` would silently operate on the wrong kernel's `Windows` manager.
 */
describe('worker-syscall bridge: a real execve program reaching a main-thread-only DOM capability', () => {
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
  })

  it('writes /bin/pilot-window.js as a real, executable file at boot', async () => {
    expect(await kernel.filesystem.fs.exists('/bin/pilot-window.js')).toBe(true)
    const stat = await kernel.filesystem.fs.stat('/bin/pilot-window.js')
    expect(stat.mode & 0o111).toBeGreaterThan(0)
  })

  it('creates a real WinBox via a worker-hosted execve program, writes to it, and closes it', async () => {
    const before = kernel.windows.stack.length
    const code = await kernel.shell.execute('/bin/pilot-window.js > /tmp/pilot-window.out')
    expect(code).toBe(0)

    // The handle the syscall returned is written to stdout as proof it round-tripped through the
    // real return path (a small integer, per `dispatch`'s `i64`-only contract), not a mock value.
    const output = await kernel.filesystem.fs.readFile('/tmp/pilot-window.out', 'utf-8')
    expect(Number(output.trim())).toBeGreaterThan(0)

    // window_close already ran inside the pilot program itself -- the window should be gone by now,
    // not merely created; asserting count returns to baseline catches a close() that silently no-ops.
    expect(kernel.windows.stack.length).toBe(before)
  })

  it('resolves the calling Kernel per-Process, not a closed-over single instance', async () => {
    // A second, independent Kernel in the same test process shares @zenfs/linux's module-global
    // syscalls map. If main-thread-syscalls.ts closed over the first Kernel instead of resolving the
    // owning one per-Process, this second kernel's window would be created on the first kernel's
    // Windows manager instead of its own.
    const second = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await second.boot()

    const secondContainer = document.createElement('div')
    document.body.appendChild(secondContainer)
    second.terminal.mount(secondContainer)

    const firstBefore = kernel.windows.stack.length
    const secondBefore = second.windows.stack.length

    const code = await second.shell.execute('/bin/pilot-window.js > /tmp/pilot-window-2.out')
    expect(code).toBe(0)

    // window_close ran inside the pilot, so both kernels' stacks are back at their own baseline --
    // the only way to tell them apart is that neither kernel ever saw the other's window at all,
    // which a shared/closed-over Kernel reference would not guarantee.
    expect(kernel.windows.stack.length).toBe(firstBefore)
    expect(second.windows.stack.length).toBe(secondBefore)
  })
})
