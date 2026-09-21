import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * boot()'s post-login setup used to run unconditionally: MOTD display, user-crontab loading, and
 * the screensaver idle-timeout daemon were inline code, not something a user could see or change.
 * They now live in /boot/init's own script (real, editable, on disk), run as a tracked ecmaOS
 * `Process` the same way any other script runs -- these are real, booted-kernel proofs that they
 * still happen, just from there instead of from boot() directly.
 *
 * One shared, booted kernel for the whole file: several kernels booted in one file/process leaks
 * char_dev/Device registrations across them (a pre-existing, documented artifact of those
 * registries being module-level globals -- see the `devices` branch), which showed up here as
 * flaky failures once this file grew past a couple of `beforeAll` kernels.
 */
describe('/boot/init and its script commands', () => {
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

  it('writes a real, editable script at /boot/init on first boot', async () => {
    const content = await kernel.filesystem.fs.readFile('/boot/init', 'utf-8')
    expect(content).toMatch(/^#!ecmaos:bin:script:init/)
    expect(content).toContain('motd')
    expect(content).toContain('screensaver-daemon')
  })

  it('starts crond as a real process, outside this shell\'s own job table', async () => {
    // Started directly from `Kernel.boot()`, not a `crond &` line in /boot/init's own script -- see
    // the comment left in that script (and at the real call site) for why: backgrounding it through
    // `Shell`'s own pipeline parsing would push it onto `this.shell`'s `_jobs`, and since crond never
    // finishes, a later bare `wait` (every non-done job) would hang forever.
    expect(kernel.shell.listJobs().some(job => job.commandLine.includes('crond'))).toBe(false)

    // `void this.execute(...)` (the real call site) is fire-and-forget -- boot() doesn't await
    // crond actually registering its real Process, so give it a moment before checking `ps`.
    await new Promise(resolve => setTimeout(resolve, 100))

    const code = await kernel.shell.execute('ps > /tmp/init-script-ps.out')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/init-script-ps.out', 'utf-8')
    expect(out).toContain('crond')
  })

  it('registers the screensavers so a daemon started from the script has one to show', () => {
    expect(kernel.screensavers.size).toBeGreaterThan(0)
    expect(kernel.screensavers.has('matrix')).toBe(true)
  })

  describe('motd command', () => {
    it('prints nothing and exits 0 when /etc/motd does not exist', async () => {
      if (await kernel.filesystem.fs.exists('/etc/motd')) await kernel.filesystem.fs.unlink('/etc/motd')
      const code = await kernel.shell.execute('motd > /tmp/motd-test-empty.out')
      expect(code).toBe(0)
      const output = await kernel.filesystem.fs.exists('/tmp/motd-test-empty.out')
        ? await kernel.filesystem.fs.readFile('/tmp/motd-test-empty.out', 'utf-8')
        : ''
      expect(output.trim()).toBe('')
    })

    it('prints /etc/motd when it exists', async () => {
      await kernel.filesystem.fs.writeFile('/etc/motd', 'Welcome to the test suite')
      const code = await kernel.shell.execute('motd > /tmp/motd-test.out')
      expect(code).toBe(0)
      const output = await kernel.filesystem.fs.readFile('/tmp/motd-test.out', 'utf-8')
      expect(output).toContain('Welcome to the test suite')
    })
  })

  describe('screensaver-daemon command', () => {
    it('starts successfully for the default (matrix) screensaver', async () => {
      // Quiet on success like a real daemon (see screensaver-daemon.ts) -- exit code plus the
      // real Kernel.startScreensaverDaemon() stop-function contract is the actual signal here,
      // not stdout text, which /boot/init prints on every boot and shouldn't have to carry this.
      const code = await kernel.shell.execute('screensaver-daemon > /tmp/daemon-test.out')
      expect(code).toBe(0)
      const output = await kernel.filesystem.fs.exists('/tmp/daemon-test.out')
        ? await kernel.filesystem.fs.readFile('/tmp/daemon-test.out', 'utf-8')
        : ''
      expect(output.trim()).toBe('')
    })

    it('reports failure for an unconfigured screensaver', async () => {
      kernel.storage.local.setItem('screensaver', 'no-such-screensaver')
      const code = await kernel.shell.execute('screensaver-daemon 2> /tmp/daemon-test-err.out')
      expect(code).toBe(1)
      const output = await kernel.filesystem.fs.readFile('/tmp/daemon-test-err.out', 'utf-8')
      expect(output).toContain('no such screensaver configured')
      kernel.storage.local.setItem('screensaver', 'matrix')
    })
  })
})
