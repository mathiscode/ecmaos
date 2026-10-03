import { beforeAll, describe, expect, it } from 'vitest'

import { kill, processes } from '@zenfs/linux'

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

  // the built-in shell's line editor is driven by key events, not by the line discipline getty uses
  const event = (key: string, ctrlKey = false) => ({ key, ctrlKey, altKey: false, shiftKey: false, metaKey: false, preventDefault() {} }) as unknown as KeyboardEvent
  const keys = (key: string, domEvent: KeyboardEvent) => (kernel.terminal as unknown as { keyHandler(e: { key: string, domEvent: KeyboardEvent }): Promise<unknown> }).keyHandler({ key, domEvent })
  const line = async (text: string) => {
    for (const char of text) await keys(char, event(char))
    await keys('\r', event('Enter'))
  }
  const ctrlD = () => keys('\x04', event('d', true))
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
    await waitFor(() => count('login:') === 1)

    // a wrong password is refused and the prompt comes back
    type('alice\r')
    await waitFor(() => screen().includes('Password: '))
    type('nope\r')
    await waitFor(() => count('login:') === 2)
    expect(screen()).not.toContain('nope')

    type('alice\r')
    await waitFor(() => count('Password: ') === 2)
    type('wonderland\r')
    await waitFor(() => kernel.shell.env.get('USER') === 'alice')
    await waitFor(async () => (await kernel.filesystem.fs.readFile('/run/utmp', 'utf-8')).includes('alice\ttty0'))
    expect(screen()).not.toContain('wonderland')

    // the shell is ecmash, in the user's home
    await new Promise(r => setTimeout(r, 1500))
    type('pwd > /tmp/getty-pwd; echo $0 > /tmp/getty-name; cat /proc/self/status > /tmp/getty-status\r')
    await waitFor(async () => await kernel.filesystem.fs.exists('/tmp/getty-name'))
    await new Promise(r => setTimeout(r, 200))
    expect((await kernel.filesystem.fs.readFile('/tmp/getty-pwd', 'utf-8')).trim()).toBe('/home/alice')
    expect((await kernel.filesystem.fs.readFile('/tmp/getty-name', 'utf-8')).trim()).toBe('ecmash')

    // login starts the shell as the user who logged in, wherever programs can run as someone else
    const alice = [...(kernel.users.all as Map<number, { uid: number, username: string }>).values()].find(u => u.username === 'alice')!
    const want = kernel.programsRunAsUser ? alice.uid : 0
    expect(await kernel.filesystem.fs.readFile('/tmp/getty-status', 'utf-8')).toMatch(new RegExp(`Uid:\\t${want}\\t`))

    // leaving the shell ends the session and shows a fresh prompt
    type('exit\r')
    await waitFor(() => count('login:') === 3)
    expect(await kernel.filesystem.fs.readFile('/run/utmp', 'utf-8')).not.toContain('alice')

    // ^C at the prompt does not take the login down
    type('\x03')
    await new Promise(r => setTimeout(r, 300))
    expect(await Promise.race([done, new Promise(r => setTimeout(() => r('running'), 200))])).toBe('running')

    for (const proc of processes.values()) if (proc.argv?.[0]?.includes('getty')) proc.kill(9)
    await done
  }, 40000)

  it('runs the built-in shell for a user without a program, and returns to the prompt on exit and on ^D', async () => {
    await kernel.users.add({ username: 'bob', password: 'builder', home: '/home/bob' })
    await kernel.filesystem.fs.writeFile('/etc/motd', 'Welcome-to-the-test-system')
    const before = count('login:')
    // started by init from an inittab entry, which is what gives it a keyboard hold the built-in shell can borrow
    const inittab = await kernel.filesystem.fs.readFile('/etc/inittab', 'utf-8')
    await kernel.filesystem.fs.writeFile('/etc/inittab', inittab + '\ntty0::respawn:/sbin/getty tty0\n')
    kill(1, 1)
    await waitFor(() => count('login:') >= before + 1)
    type('bob\r')
    await waitFor(() => count('Password: ') >= 1 && screen().trimEnd().endsWith('Password:'))
    type('builder\r')
    await waitFor(() => kernel.shell.env.get('USER') === 'bob')
    await new Promise(r => setTimeout(r, 500))

    // the message of the day follows the login on the first terminal too, never precedes it
    expect(screen()).toContain('Welcome-to-the-test-system')
    expect(screen().indexOf('Welcome-to-the-test-system')).toBeGreaterThan(screen().indexOf('Password:'))

    // the built-in shell's own line editor is in charge
    await line('echo built-in > /tmp/bob-said')
    await waitFor(async () => await kernel.filesystem.fs.exists('/tmp/bob-said'))

    await line('exit')
    await waitFor(() => count('login:') >= before + 2)
    expect(screen()).toContain('logout')

    type('bob\r')
    await waitFor(() => screen().trimEnd().endsWith('Password:'))
    type('builder\r')
    await waitFor(() => kernel.shell.env.get('USER') === 'bob' && screen().trimEnd().endsWith('#') || screen().trimEnd().endsWith('$'))
    await new Promise(r => setTimeout(r, 500))
    await ctrlD()
    await waitFor(() => count('login:') >= before + 3)

    await kernel.filesystem.fs.writeFile('/etc/inittab', inittab)
    kill(1, 1)
    for (const proc of processes.values()) if (proc.argv?.[0]?.includes('getty')) proc.kill(9)
  }, 40000)

  it('/bin/login refuses to run without a terminal and a user name', async () => {
    expect(await kernel.shell.execute('/bin/login')).toBe(2)
    expect(await kernel.shell.execute('/bin/login -t 0')).toBe(2)
  })
})
