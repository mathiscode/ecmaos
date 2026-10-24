import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { PROGRAMS_ALL, TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/**
 * `/bin/tmux` driven on the terminal: its server is a fork of the client that detaches, each pane a pty with a shell
 * on it, and the client draws them with ncurses.
 */
describe('tmux on the terminal', () => {
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
  })

  const waitFor = async (check: () => boolean, timeoutMs = 20000) => {
    const start = Date.now()
    while (!check()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out\n' + screenText().split('\n').filter(Boolean).slice(-12).join('\n'))
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }

  /** What is on the terminal screen (bash's alternate buffer while it runs). */
  const screenText = () => {
    const { active } = (kernel.terminal as unknown as { buffer: { active: { length: number, getLine(i: number): { translateToString(trim: boolean): string } | undefined } } }).buffer
    const lines: string[] = []
    for (let i = 0; i < active.length; i++) lines.push(active.getLine(i)?.translateToString(true) ?? '')
    return lines.join('\n')
  }



  it('starts a server, runs a command in a pane, splits it and detaches', async () => {
    const done = kernel.shell.execute('tmux new-session /bin/dash')
    await waitFor(() => kernel.shell.foregroundJob?.processes.length === 1 && kernel.terminal.ttyInputAttached)
    await waitFor(() => /\[\d+\]/.test(screenText()) || /\$ $/m.test(screenText()), 30000)
    const press = async (keys: string, wait = 500) => { kernel.terminal.input(keys, true); await new Promise(resolve => setTimeout(resolve, wait)) }
    await press('echo from-$((6*7))\r')
    await waitFor(() => /^# from-42$/m.test(screenText()))
    await press('\x02"') // C-b "
    await press('echo second\r')
    await waitFor(() => /^second$/m.test(screenText()))
    await press('\x02d') // C-b d
    expect(await done).toBe(0)
    await kernel.shell.execute('tmux ls')
    expect(screenText()).toMatch(/0: 1 windows/)
    await kernel.shell.execute('tmux kill-server')
  }, 120000)
})
