import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { PROGRAMS_ALL, TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/** `/bin/htop` is a curses program built to WebAssembly with ncurses (`core/utils-copyleft/wasm/htop`), driven here on the terminal as a person would */
describe('htop', () => {
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

  const waitFor = async (check: () => boolean, timeoutMs = 30000) => {
    const start = Date.now()
    while (!check()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }

  const screenText = () => {
    const { active } = (kernel.terminal as unknown as { buffer: { active: { length: number, getLine(i: number): { translateToString(trim: boolean): string } | undefined } } }).buffer
    const lines: string[] = []
    for (let i = 0; i < active.length; i++) lines.push(active.getLine(i)?.translateToString(true) ?? '')
    return lines.join('\n')
  }

  it('prints its version', async () => {
    const code = await kernel.shell.execute('htop --version > /tmp/htop.out 2> /tmp/htop.err')
    expect(code, await kernel.filesystem.fs.readFile('/tmp/htop.err', 'utf8')).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/htop.out', 'utf8')).toMatch(/^htop 3\.5\.3/)
  }, 60000)

  it('shows the processes from /proc, finds one by its name, and quits on q', async () => {
    const done = kernel.shell.execute('htop')
    await waitFor(() => kernel.shell.foregroundJob?.processes.length === 1 && kernel.terminal.ttyInputAttached)
    await waitFor(() => /PID\s+USER/.test(screenText()) && screenText().includes('F10'))
    await waitFor(() => /^\s*1\s+root\s.*\/sbin\/init/m.test(screenText())) // init, read from /proc/1/task/1/stat
    const screen = screenText()
    expect(screen).toMatch(/Tasks: [1-9]/)
    expect(screen).toMatch(/Mem\[/)
    expect(screen).toMatch(/\bcrond\b/)
    const press = async (keys: string) => { kernel.terminal.input(keys, true); await new Promise(resolve => setTimeout(resolve, 600)) }
    await press('\x1bOD') // a key curses has to recognise (Left), which the screen survives
    await press('q')
    expect(await done).toBe(0)
  }, 90000)
})
