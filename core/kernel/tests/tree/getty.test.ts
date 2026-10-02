import { beforeAll, describe, expect, it } from 'vitest'

import { processes } from '@zenfs/linux'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10000) {
  const start = Date.now()
  while (!await check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await new Promise(r => setTimeout(r, 20))
  }
}

describe('/sbin/getty', () => {
  let kernel: Kernel
  const type = (data: string) => kernel.terminal.input(data, true)
  const screen = () => {
    const buffer = kernel.terminal.buffer.active
    let text = ''
    for (let i = 0; i < buffer.length; i++) text += (buffer.getLine(i)?.translateToString(true) ?? '') + '\n'
    return text
  }
  const count = (needle: string) => screen().split(needle).length - 1

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
    ;(kernel.terminal as unknown as { _isMobile: boolean })._isMobile = false
    await kernel.users.add({ username: 'alice', password: 'wonderland', home: '/home/alice', shell: '/bin/ecmash' })
  })

  it('logs a user in, runs their shell, and asks again when it exits', async () => {
    const done = kernel.shell.execute('/sbin/getty tty0')
    await waitFor(() => count('login: ') === 1)

    // a wrong password is refused and the prompt comes back
    type('alice\r')
    await waitFor(() => screen().includes('Password: '))
    type('nope\r')
    await waitFor(() => count('login: ') === 2)
    expect(screen()).not.toContain('nope')

    type('alice\r')
    await waitFor(() => count('Password: ') === 2)
    type('wonderland\r')
    await waitFor(() => kernel.shell.env.get('USER') === 'alice')
    expect(await kernel.filesystem.fs.readFile('/run/utmp', 'utf-8')).toContain('alice\ttty0')
    expect(screen()).not.toContain('wonderland')

    // the shell is ecmash, in the user's home
    await new Promise(r => setTimeout(r, 1500))
    type('pwd > /tmp/getty-pwd; echo $0 > /tmp/getty-name\r')
    await waitFor(async () => await kernel.filesystem.fs.exists('/tmp/getty-name'))
    await new Promise(r => setTimeout(r, 200))
    expect((await kernel.filesystem.fs.readFile('/tmp/getty-pwd', 'utf-8')).trim()).toBe('/home/alice')
    expect((await kernel.filesystem.fs.readFile('/tmp/getty-name', 'utf-8')).trim()).toBe('ecmash')

    // leaving the shell ends the session and shows a fresh prompt
    type('exit\r')
    await waitFor(() => count('login: ') === 3)
    expect(await kernel.filesystem.fs.readFile('/run/utmp', 'utf-8')).not.toContain('alice')

    // ^C at the prompt does not take the login down
    type('\x03')
    await new Promise(r => setTimeout(r, 300))
    expect(await Promise.race([done, new Promise(r => setTimeout(() => r('running'), 200))])).toBe('running')

    for (const proc of processes.values()) if (proc.argv?.[0]?.includes('getty')) proc.kill(9)
    await done
  }, 40000)
})
