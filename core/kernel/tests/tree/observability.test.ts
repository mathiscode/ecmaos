import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** The commands that read the machine's own state: `top`, `dmesg`, `lscpu`, `fastfetch`, `wall` and `write`. */
describe('observability commands', () => {
  let kernel: Kernel
  const run = async (command: string) => {
    const code = await kernel.shell.execute(`${command} > /tmp/obs.out 2> /tmp/obs.err`)
    return {
      code,
      out: await kernel.filesystem.fs.readFile('/tmp/obs.out', 'utf8'),
      err: await kernel.filesystem.fs.readFile('/tmp/obs.err', 'utf8')
    }
  }

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

  afterAll(async () => { await kernel.filesystem.fs.rm('/run/utmp.bak', { force: true }) })

  it('top -b -n 1 prints one screen with init in it and no CPU column', async () => {
    const { code, out } = await run('top -b -n 1')
    expect(code).toBe(0)
    const lines = out.split('\n')
    expect(lines[0]).toMatch(/^top - \d\d:\d\d:\d\d up /)
    expect(lines[1]).toMatch(/^Tasks: \d+ total$/)
    expect(out).toMatch(/PID\s+PPID\s+USER\s+COMMAND/)
    expect(out).toMatch(/^\s+1\s+0\s+root\s+init$/m)
    expect(out).not.toContain('%CPU')
  })

  it('top counts screens and rejects bad arguments', async () => {
    expect((await run('top -b -n 2 -d 0.1')).out.match(/^top - /gm)).toHaveLength(2)
    const bad = await run('top -n 0')
    expect(bad.code).toBe(1)
    expect(bad.err).toContain('positive')
  })

  it('dmesg prints the kernel log, filtered by level and count', async () => {
    await kernel.filesystem.fs.writeFile('/var/log/kernel.log', '2026-01-01 00:00:00 [INFO] one\n\n2026-01-01 00:00:01 [WARN] two\n\n2026-01-01 00:00:02 [INFO] three\n\n')
    expect((await run('dmesg')).out).toBe('2026-01-01 00:00:00 [INFO] one\n2026-01-01 00:00:01 [WARN] two\n2026-01-01 00:00:02 [INFO] three\n')
    expect((await run('dmesg -l warn')).out).toBe('2026-01-01 00:00:01 [WARN] two\n')
    expect((await run('dmesg -n 1')).out).toBe('2026-01-01 00:00:02 [INFO] three\n')
  })

  it('lscpu reports the logical processors and the byte order', async () => {
    const { code, out } = await run('lscpu')
    expect(code).toBe(0)
    expect(out).toMatch(/^Byte Order:\s+Little Endian$/m)
    expect(out).toMatch(/^CPU\(s\):\s+\d+$/m)
  })

  it('fastfetch names the OS and leaves out what it does not know', async () => {
    const { code, out } = await run('fastfetch --no-color')
    expect(code).toBe(0)
    const release = await kernel.filesystem.fs.readFile('/etc/os-release', 'utf8')
    expect(out).toContain(`OS: ${/^PRETTY_NAME="(.*)"$/m.exec(release)?.[1]}`)
    expect(out).toMatch(/Kernel: ecmaOS/)
    expect(out).not.toContain('\x1b')
    const plain = await run('neofetch --no-logo')
    expect(plain.code).toBe(0)
    expect(plain.out.split('\n')[0]).toMatch(/^root@/)
  })

  it('wall and write go to the terminals in /run/utmp, and say so when nobody is there', async () => {
    await kernel.filesystem.fs.writeFile('/run/utmp', 'root\ttty0\t1700000000000\n')
    expect((await run('wall -n maintenance in five minutes')).code).toBe(0)
    expect((await run('echo hello | write root')).code).toBe(0)
    const nobody = await run('echo hi | write alice')
    expect(nobody.code).toBe(1)
    expect(nobody.err).toContain('alice is not logged in')
    const wrongTty = await run('echo hi | write root tty5')
    expect(wrongTty.code).toBe(1)
    expect(wrongTty.err).toContain('not logged in on tty5')
    expect((await run('wall < /dev/null')).err).toContain('no message')
  })
})
