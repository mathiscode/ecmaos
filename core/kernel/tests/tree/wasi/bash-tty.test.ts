import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { PROGRAMS_ALL, TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/**
 * `/bin/bash` driven on the terminal as a person would: its prompt, readline's line editing and history, a background
 * job, and ^C for the one in front. It is interactive only where its descriptors 0 and 2 are the terminal, which the
 * shell leaves a program's stderr when it is not redirected.
 */
describe('bash on the terminal', () => {
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


  const start = async () => {
    const done = kernel.shell.execute('bash --noprofile --norc')
    await waitFor(() => kernel.shell.foregroundJob?.processes.length === 1 && kernel.terminal.ttyInputAttached)
    await waitFor(() => /bash-[\d.]+[#$] $/m.test(screenText()))
    const press = async (keys: string, wait = 300) => { kernel.terminal.input(keys, true); await new Promise(resolve => setTimeout(resolve, wait)) }
    return { done, press }
  }

  it('has the terminal for all three of its descriptors when stderr is not redirected', async () => {
    await kernel.shell.execute('bash -c "test -t 0 && test -t 1 && test -t 2 && echo three-ttys"')
    expect(screenText()).toMatch(/^three-ttys$/m)
    await kernel.shell.execute('bash -c "test -t 2 || echo redirected" 2> /dev/null')
    await kernel.shell.execute('bash -c "test -t 2 || echo redirected" 2>&1 | cat')
    await waitFor(() => screenText().match(/^redirected$/gm)?.length === 2)
  }, 60000)

  it('reads lines with readline, edits them and recalls the history', async () => {
    const { done, press } = await start()
    await press('echo one\r')
    await waitFor(() => /^one$/m.test(screenText()))
    await press('echo twx\x7fo\r') // a typo mended with backspace
    await waitFor(() => /^two$/m.test(screenText()))
    await press('\x1b[A') // up: the last line
    await press('\x01echo \x05 three\r') // ^A, text, ^E, text
    await waitFor(() => /^echo two three$/m.test(screenText()))
    await press('exit 7\r')
    expect(await done).toBe(7)
  }, 90000)

  it('runs a job in the background and ends the one in front with ^C', async () => {
    const { done, press } = await start()
    await press('sleep 60 &\r')
    await press('jobs\r')
    await waitFor(() => /\[1\]\+\s+Running\s+sleep 60/.test(screenText()))
    await press('sleep 30\r', 600)
    await press('\x03') // ^C
    await press('echo after $?\r')
    await waitFor(() => /^after 130$/m.test(screenText()))
    await press('kill %1\r')
    await press('exit\r')
    expect(await done).toBe(0)
  }, 90000)
})
