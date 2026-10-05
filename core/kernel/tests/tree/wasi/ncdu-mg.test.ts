import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/**
 * `/bin/ncdu` and `/bin/mg` are curses programs built to WebAssembly with ncurses (`core/utils/wasm/ncdu`, `core/utils/wasm/mg`).
 * Their screens are checked by hand in a browser; here, what runs without a terminal.
 */
describe('ncdu and mg', () => {
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
    ;(kernel.terminal as unknown as { _isMobile: boolean })._isMobile = false
  })

  const waitFor = async (check: () => boolean, timeoutMs = 20000) => {
    const start = Date.now()
    while (!check()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }

  /** What is on the terminal screen (the curses program's alternate buffer while it runs). */
  const screenText = () => {
    const { active } = (kernel.terminal as unknown as { buffer: { active: { length: number, getLine(i: number): { translateToString(trim: boolean): string } | undefined } } }).buffer
    const lines: string[] = []
    for (let i = 0; i < active.length; i++) lines.push(active.getLine(i)?.translateToString(true) ?? '')
    return lines.join('\n')
  }

  const run = async (command: string) => {
    const code = await kernel.shell.execute(`${command} > /tmp/nm.out 2> /tmp/nm.err`)
    return { code, out: await kernel.filesystem.fs.readFile('/tmp/nm.out', 'utf8'), err: await kernel.filesystem.fs.readFile('/tmp/nm.err', 'utf8') }
  }

  it('ncdu scans a directory and exports sizes as JSON', async () => {
    const fs = kernel.filesystem.fs
    await fs.mkdir('/tmp/du/sub', { recursive: true })
    await fs.writeFile('/tmp/du/big.bin', new Uint8Array(40000))
    await fs.writeFile('/tmp/du/sub/small.txt', 'hi')
    const result = await run('ncdu -0 -o - /tmp/du')
    expect(result.code).toBe(0)
    const tree = JSON.parse(result.out)
    expect(tree[0]).toBe(1) // export format version
    const text = JSON.stringify(tree)
    expect(text).toContain('"name":"big.bin"')
    expect(text).toContain('"name":"small.txt"')
    expect(text).toContain('"asize":40000')
  }, 60000)

  it('ncdu reports a directory it cannot scan on stderr', async () => {
    const result = await run('ncdu -0 -o - /tmp/not-there')
    expect(result.err).toContain('No such file or directory')
  }, 60000)

  it('mg prints its usage and exits non-zero for an unknown option', async () => {
    const result = await run('mg --no-such-option')
    expect(result.code).toBe(1)
    expect(result.err).toContain('usage: mg')
  }, 60000)

  // xterm.js sends these once the program has switched the keypad on (smkx); curses has to recognise them from its
  // terminfo entry. It did not while the ncurses key table was empty (see wasm/lib/ncurses.sh).
  it('ncdu takes the arrow keys: Down moves the selection, Enter opens it, Left goes back', async () => {
    const fs = kernel.filesystem.fs
    await fs.mkdir('/tmp/dk/big', { recursive: true })
    await fs.mkdir('/tmp/dk/small', { recursive: true })
    await fs.writeFile('/tmp/dk/big/data', new Uint8Array(200000))
    await fs.writeFile('/tmp/dk/small/data', 'x')
    const done = kernel.shell.execute('ncdu /tmp/dk')
    await waitFor(() => kernel.shell.foregroundJob?.processes.length === 1 && kernel.terminal.ttyInputAttached)
    await waitFor(() => screenText().includes('Total disk usage'))
    const press = async (keys: string) => { kernel.terminal.input(keys, true); await new Promise(resolve => setTimeout(resolve, 600)) }
    await press('\x1bOB') // Down
    await press('\r')
    await waitFor(() => screenText().includes('/tmp/dk/small'))
    expect(screenText()).not.toContain('/tmp/dk/big')
    await press('\x1bOD') // Left: up a directory
    await waitFor(() => /--- \/tmp\/dk -/.test(screenText()))
    await press('q')
    expect(await done).toBe(0)
  }, 90000)
})
