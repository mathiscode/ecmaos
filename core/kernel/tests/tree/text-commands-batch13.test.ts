import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * cal/date/printf/which/whoami/pwd/hostname/uname/nproc/uptime/motd migrated onto real execve --
 * all pure computation/syscalls, no live kernel/shell/terminal state. test/true/false were also
 * ported and then deliberately reverted back to the in-process legacy shim after this batch's own
 * testing showed a tight shell while-loop using `test` as its condition became measurably slower
 * (each real execve pays a worker spin-up cost a plain in-process call doesn't) -- see
 * legacy-command-shim.ts's doc comment.
 *
 * uname.mjs/hostname.mjs read env.KERNEL_NAME/env.KERNEL_VERSION/env.HOSTNAME, now threaded through
 * Shell's env at construction (kernel.ts) since a worker has no live `kernel` reference to read
 * kernel.name/kernel.version from directly, and `window` (unlike `navigator`) never existed in a
 * Worker context even before migration.
 */
describe('text command batch 13: cal/date/printf/which/whoami/pwd/hostname/uname/nproc/uptime/motd, real execve', () => {
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

  for (const name of ['cal', 'date', 'printf', 'which', 'whoami', 'pwd', 'hostname', 'uname', 'nproc', 'uptime', 'motd']) {
    it(`${name} is a real execve file, not the legacy stub`, async () => {
      const content = await kernel.filesystem.fs.readFile(`/bin/${name}`, 'utf-8')
      expect(content.startsWith('#!ecmaos:bin:command:')).toBe(false)
    })
  }

  for (const name of ['test', 'true', 'false']) {
    it(`${name} stays on the legacy in-process stub (deliberately not migrated)`, async () => {
      const content = await kernel.filesystem.fs.readFile(`/bin/${name}`, 'utf-8')
      expect(content.startsWith('#!ecmaos:bin:command:')).toBe(true)
    })
  }

  it('cal prints a calendar for the given month/year', async () => {
    const code = await kernel.shell.execute('cal 1 2024 > /tmp/cal-out.txt')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/cal-out.txt', 'utf-8')
    expect(out).toContain('January 2024')
  })

  it('date -I prints an ISO 8601 timestamp', async () => {
    const code = await kernel.shell.execute('date -I > /tmp/date-out.txt')
    expect(code).toBe(0)
    const out = (await kernel.filesystem.fs.readFile('/tmp/date-out.txt', 'utf-8')).trim()
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('printf formats arguments per the format string', async () => {
    const code = await kernel.shell.execute('printf "%s-%d\\n" hello 42 > /tmp/printf-out.txt')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/printf-out.txt', 'utf-8')
    expect(out).toBe('hello-42\n')
  })

  it('which locates a real command on PATH', async () => {
    const code = await kernel.shell.execute('which cat > /tmp/which-out.txt')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/which-out.txt', 'utf-8')
    expect(out.trim()).toBe('/bin/cat')
  })

  it('which exits 1 for a nonexistent command', async () => {
    const code = await kernel.shell.execute('which totally-not-a-real-command-xyz 2>/tmp/which-missing.err')
    expect(code).toBe(1)
  })

  it('whoami prints the current user', async () => {
    const code = await kernel.shell.execute('whoami > /tmp/whoami-out.txt')
    expect(code).toBe(0)
    const out = (await kernel.filesystem.fs.readFile('/tmp/whoami-out.txt', 'utf-8')).trim()
    expect(out.length).toBeGreaterThan(0)
  })

  it('pwd prints the real current working directory', async () => {
    const code = await kernel.shell.execute('cd /tmp && pwd > /tmp/pwd-out.txt')
    expect(code).toBe(0)
    const out = (await kernel.filesystem.fs.readFile('/tmp/pwd-out.txt', 'utf-8')).trim()
    expect(out).toBe('/tmp')
  })

  it('hostname prints a hostname string', async () => {
    const code = await kernel.shell.execute('hostname > /tmp/hostname-out.txt')
    expect(code).toBe(0)
    const out = (await kernel.filesystem.fs.readFile('/tmp/hostname-out.txt', 'utf-8')).trim()
    expect(out.length).toBeGreaterThan(0)
  })

  it('uname -s prints the kernel name', async () => {
    const code = await kernel.shell.execute('uname -s > /tmp/uname-out.txt')
    expect(code).toBe(0)
    const out = (await kernel.filesystem.fs.readFile('/tmp/uname-out.txt', 'utf-8')).trim()
    expect(out.length).toBeGreaterThan(0)
  })

  it('nproc prints a positive integer', async () => {
    const code = await kernel.shell.execute('nproc > /tmp/nproc-out.txt')
    expect(code).toBe(0)
    const out = (await kernel.filesystem.fs.readFile('/tmp/nproc-out.txt', 'utf-8')).trim()
    expect(Number(out)).toBeGreaterThan(0)
  })

  it('uptime prints an "up ..." line', async () => {
    const code = await kernel.shell.execute('uptime > /tmp/uptime-out.txt')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/uptime-out.txt', 'utf-8')
    expect(out).toContain('up')
  })

  it('motd prints /etc/motd contents when present', async () => {
    await kernel.filesystem.fs.writeFile('/etc/motd', 'Welcome to the test kernel\n')
    const code = await kernel.shell.execute('motd > /tmp/motd-out.txt')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/motd-out.txt', 'utf-8')
    expect(out).toContain('Welcome to the test kernel')
  })

  it('motd exits 0 silently when /etc/motd is absent', async () => {
    const code = await kernel.shell.execute('rm -f /etc/motd 2>/dev/null; motd > /tmp/motd-empty.out')
    expect(code).toBe(0)
  })
})
