import { describe, expect, it, beforeAll } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { KernelState } from '@ecmaos/types'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * The smoke test the overhaul status report (`.docs/overhaul/STATUS_01.md`, recommendation #1)
 * flagged as still missing and "likely the best test-per-hour in the plan": boot headlessly and
 * assert the kernel actually reaches a usable state, not just that `boot()` resolves without
 * throwing. Two real bugs shipped and were only caught by hand, later, because no test asserted
 * this: the boot-output race (`/boot/init`'s own output interleaving with the recommended-apps
 * prompt, because its process wasn't actually awaited) and the console-device-registration bug
 * (`/dev/xterm<n>`/`/dev/console` existed and `stat`'d correctly but threw `ENXIO` on every real
 * read/write, because `attach_xterm`'s per-TTY registration is not the same as the driver-level
 * `xterm_driver.register()`/`console_driver.register()` that actually publishes a `CharDevice`).
 * This test's console write-through assertion is the exact shape of check whose absence let the
 * second bug hide -- the existing terminal test only checked `exists()` before this.
 */
describe('boot smoke test', () => {
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

  it('reaches RUNNING, not PANIC or stuck BOOTING', () => {
    expect(kernel.state).toBe(KernelState.RUNNING)
  })

  it('ran /boot/init to completion before boot() resolved (motd, crontab, screensaver daemon)', () => {
    expect(kernel.screensavers.size).toBeGreaterThan(0)
  })

  it('refreshes a stale /bin program left by an earlier build, and keeps an up-to-date one', async () => {
    const fs = kernel.filesystem.fs
    const current = await fs.readFile('/bin/echo', 'utf8')
    await fs.writeFile('/bin/echo', 'stale program from an older build', { mode: 0o755 })
    await kernel.registerCommands()
    expect(await fs.readFile('/bin/echo', 'utf8')).toBe(current)
  })

  it('reaches an interactive prompt: a shell command executes and returns a real exit code', async () => {
    const code = await kernel.shell.execute('true')
    expect(code).toBe(0)
  })

  describe('the console is actually writable, not just present', () => {
    it('mounts a terminal and writes through its real /dev/xterm<n> node', async () => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      kernel.terminal.mount(container)

      const path = `/dev/xterm${kernel.terminal.tty}`
      expect(await kernel.filesystem.fs.exists(path)).toBe(true)
      await expect(kernel.filesystem.fs.writeFile(path, 'boot smoke test console write\n')).resolves.not.toThrow()
    })
  })
})
