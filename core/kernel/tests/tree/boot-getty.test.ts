import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { Terminal } from '#terminal.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 15000) {
  const start = Date.now()
  while (!await check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await new Promise(r => setTimeout(r, 20))
  }
}

/** A kernel with no auto-login: init starts first and its /etc/inittab runs a getty on the first terminal. */
describe('boot with a getty on TTY 0', () => {
  let kernel: Kernel
  let boot: Promise<void>
  const screen = () => {
    const buffer = kernel.terminal.buffer.active
    let text = ''
    for (let i = 0; i < buffer.length; i++) text += (buffer.getLine(i)?.translateToString(true) ?? '') + '\n'
    return text
  }
  const type = (data: string) => kernel.terminal.input(data, true)

  beforeAll(async () => {
    kernel = new Kernel({ dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    // jsdom calls every terminal a touch device, which keeps the line discipline off the keyboard; every
    // terminal init creates must be a desktop one, since getty takes the keyboard when it starts
    ;(Terminal.prototype as unknown as { _detectMobileSupport(): void })._detectMobileSupport = function (this: { _isMobile: boolean }) { this._isMobile = false }
    // the page has a container for each terminal; init creates each terminal when it starts its getty
    for (let n = 1; n <= 7; n++) {
      const tty = document.createElement('div')
      tty.id = `terminal-tty${n}`
      document.body.appendChild(tty)
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    boot = kernel.boot()
    await boot
    kernel.terminal.mount(container)
    ;(kernel.terminal as unknown as { _isMobile: boolean })._isMobile = false
  }, 30000)

  it('writes a getty entry into the default inittab', async () => {
    expect(await kernel.filesystem.fs.readFile('/etc/inittab', 'utf-8')).toContain('tty0::respawn:/sbin/getty tty0')
    expect(await kernel.filesystem.fs.readFile('/etc/inittab', 'utf-8')).toContain('tty7::respawn:/sbin/getty tty7')
  })

  it('shows getty\'s prompt, not the kernel\'s, and logs a user in through it', async () => {
    await waitFor(() => screen().includes('login:'))
    expect(screen()).not.toContain('Username')
    type('root\r')
    await waitFor(() => screen().trimEnd().endsWith('Password:'))
    type('root\r')
    await waitFor(() => kernel.shell.env.get('USER') === 'root' && screen().includes('root:'))
    expect(await kernel.filesystem.fs.readFile('/run/utmp', 'utf-8')).toContain('root\ttty0')
  }, 30000)

  it('runs the same getty on the other terminals, each with its own login', async () => {
    const tty3 = () => kernel.getShell(3)?.terminal
    await waitFor(() => tty3() !== undefined)
    const text = () => {
      const buffer = tty3()!.buffer.active
      let out = ''
      for (let i = 0; i < buffer.length; i++) out += (buffer.getLine(i)?.translateToString(true) ?? '') + '\n'
      return out
    }
    await waitFor(() => text().includes('login:'))
    expect(text()).not.toContain('Username')
    tty3()!.input('root\r', true)
    await waitFor(() => text().trimEnd().endsWith('Password:'))
    tty3()!.input('root\r', true)
    await waitFor(async () => (await kernel.filesystem.fs.readFile('/run/utmp', 'utf-8')).includes('root\ttty3'))
  }, 30000)
})
