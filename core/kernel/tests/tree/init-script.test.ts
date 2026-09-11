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
  })

  it('writes a real, editable script at /boot/init on first boot', async () => {
    const content = await kernel.filesystem.fs.readFile('/boot/init', 'utf-8')
    expect(content).toMatch(/^#!ecmaos:bin:script:init/)
    expect(content).toContain('motd')
    expect(content).toContain('load-crontab')
    expect(content).toContain('screensaver-daemon')
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

  describe('load-crontab command', () => {
    it('requires a scope of system or user', async () => {
      const code = await kernel.shell.execute('load-crontab /etc/crontab bogus')
      expect(code).toBe(1)
    })

    it('loads a real crontab file and registers its entries', async () => {
      await kernel.filesystem.fs.writeFile('/tmp/test-crontab', '* * * * * echo hi\n')
      const code = await kernel.shell.execute('load-crontab /tmp/test-crontab system')
      expect(code).toBe(0)
      expect(kernel.intervals.getCron('cron:system:1')).toBeDefined()
    })
  })

  describe('screensaver-daemon command', () => {
    it('starts successfully for the default (matrix) screensaver', async () => {
      const code = await kernel.shell.execute('screensaver-daemon > /tmp/daemon-test.out')
      expect(code).toBe(0)
      const output = await kernel.filesystem.fs.readFile('/tmp/daemon-test.out', 'utf-8')
      expect(output).toContain('watching for idle activity')
    })
  })
})
