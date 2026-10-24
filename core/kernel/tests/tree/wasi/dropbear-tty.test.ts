import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { PROGRAMS_ALL, TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/**
 * `ssh` driven on the terminal as a person would: it logs in to the server over loopback, which gives it a login shell
 * on a pty, and what is typed goes through the connection to that shell and back.
 */
describe('ssh on the terminal', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions,
      programs: PROGRAMS_ALL
    })
    await kernel.boot()
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
    ;(kernel.terminal as unknown as { _isMobile: boolean })._isMobile = false
    for (let tries = 0; tries < 100 && await kernel.shell.execute('dropbearkey -t ed25519 -f /tmp/probe > /dev/null 2>&1') !== 0; tries++) await new Promise(resolve => setTimeout(resolve, 500))
  }, 120000)

  const screenText = () => {
    const { active } = (kernel.terminal as unknown as { buffer: { active: { length: number, getLine(i: number): { translateToString(trim: boolean): string } | undefined } } }).buffer
    const lines: string[] = []
    for (let i = 0; i < active.length; i++) lines.push(active.getLine(i)?.translateToString(true) ?? '')
    return lines.join('\n')
  }

  const waitFor = async (check: () => boolean, timeoutMs = 30000) => {
    const start = Date.now()
    while (!check()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out\n' + screenText().split('\n').filter(Boolean).slice(-15).join('\n'))
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }

  it('logs in to a server and runs commands in its shell on a pty', async () => {
    const run = (command: string) => kernel.shell.execute(command)
    await run('dropbearkey -t ed25519 -f /tmp/hostkey > /dev/null 2>&1; dropbearkey -t ed25519 -f /tmp/id > /dev/null 2>&1')
    await run('dropbearkey -y -f /tmp/id > /tmp/pub.out')
    const pub = (await kernel.filesystem.fs.readFile('/tmp/pub.out', 'utf8')).split('\n')[1]
    await kernel.filesystem.fs.mkdir('/root/.ssh', { recursive: true })
    await kernel.filesystem.fs.writeFile('/root/.ssh/authorized_keys', pub + '\n')
    await run('chmod 700 /root /root/.ssh; chmod 600 /root/.ssh/authorized_keys')
    // the server goes into the background by itself (a fork that detaches), as `dropbear` does when it is not told -F
    expect(await run('dropbear -E -s -r /tmp/hostkey -p 127.0.0.1:2222 > /tmp/server.out 2>&1')).toBe(0)
    await new Promise(resolve => setTimeout(resolve, 2000))

    const done = run('ssh -y -i /tmp/id -p 2222 root@127.0.0.1')
    await waitFor(() => kernel.shell.foregroundJob?.processes.length === 1 && kernel.terminal.ttyInputAttached)
    const press = async (keys: string, wait = 400) => { kernel.terminal.input(keys, true); await new Promise(resolve => setTimeout(resolve, wait)) }
    await new Promise(resolve => setTimeout(resolve, 1500))
    await press('echo from-$((6*7))-ssh\r', 1000)
    await waitFor(() => /^from-42-ssh$/m.test(screenText()))
    await press('exit 4\r')
    // the session ends when the shell does (its status does not come back over a pty yet; a command without one does)
    await done
    expect(screenText()).toMatch(/Connection to root@127\.0\.0\.1:2222 exited/)
  }, 120000)
})
