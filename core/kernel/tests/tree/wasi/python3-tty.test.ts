import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { PROGRAMS_ALL, TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/** `/bin/python3` driven on the terminal as a person would: the REPL's prompt, an expression, a statement over two lines, and exit */
describe('python3 on the terminal', () => {
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
    for (let tries = 0; tries < 100 && await kernel.shell.execute('python3 -c "import json" > /dev/null 2>&1') !== 0; tries++) await new Promise(resolve => setTimeout(resolve, 500))
  }, 300000)

  const screenText = () => {
    const { active } = (kernel.terminal as unknown as { buffer: { active: { length: number, getLine(i: number): { translateToString(trim: boolean): string } | undefined } } }).buffer
    const lines: string[] = []
    for (let i = 0; i < active.length; i++) lines.push(active.getLine(i)?.translateToString(true) ?? '')
    return lines.join('\n')
  }

  const waitFor = async (check: () => boolean, timeoutMs = 30000) => {
    const start = Date.now()
    while (!check()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out\n' + screenText().split('\n').filter(Boolean).slice(-12).join('\n'))
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }

  it('shows a prompt, evaluates what is typed and exits with the status given', async () => {
    const done = kernel.shell.execute('python3')
    await waitFor(() => kernel.shell.foregroundJob?.processes.length === 1 && kernel.terminal.ttyInputAttached)
    await waitFor(() => /^>>> $/m.test(screenText()))
    const press = async (keys: string) => { kernel.terminal.input(keys, true); await new Promise(resolve => setTimeout(resolve, 400)) }
    await press('6 * 7\r')
    await waitFor(() => /^42$/m.test(screenText()))
    await press('for i in range(2):\r')
    await press('    print("n", i)\r')
    await press('\r')
    await waitFor(() => /^n 1$/m.test(screenText()))
    await press('raise SystemExit(5)\r')
    expect(await done).toBe(5)
  }, 120000)
})
