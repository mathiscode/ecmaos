import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { PROGRAMS_ALL, TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/**
 * `/bin/ncdu` and `/bin/mg` are curses programs built to WebAssembly with ncurses (`core/utils/wasm/ncdu`, `core/utils/wasm/mg`).
 * Here, what runs without a terminal, and mg and ncdu driven on the terminal as a person would.
 */
describe('ncdu and mg', () => {
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

  // batch mode runs on a pty of its own (openpty and login_tty), with no terminal needed
  it('mg runs a batch file that edits and saves a file', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/mg-batch.mg', 'find-file /tmp/mg-batch.txt\ninsert "from a batch file"\nnewline\nsave-buffer\n')
    const result = await run('mg -b /tmp/mg-batch.mg')
    expect(result.code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/mg-batch.txt', 'utf8')).toBe('from a batch file\n')
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

  // `b` runs SHELL with system(), which starts it with posix_spawn (core/utils/wasm/ncdu/build.sh)
  it('ncdu spawns a shell in the directory shown, and comes back when it exits', async () => {
    await kernel.filesystem.fs.mkdir('/tmp/dsh/inner', { recursive: true })
    const done = kernel.shell.execute('ncdu /tmp/dsh')
    await waitFor(() => kernel.shell.foregroundJob?.processes.length === 1 && kernel.terminal.ttyInputAttached)
    await waitFor(() => screenText().includes('Total disk usage'))
    const press = async (keys: string) => { kernel.terminal.input(keys, true); await new Promise(resolve => setTimeout(resolve, 600)) }
    await press('b')
    await press('echo "in $(pwd) at level $NCDU_LEVEL"\r')
    await waitFor(() => screenText().includes('in /tmp/dsh at level 1'))
    await press('exit\r')
    await waitFor(() => screenText().includes('Total disk usage'))
    await press('q')
    expect(await done).toBe(0)
  }, 90000)

  /** Starts mg on `file` in the foreground and waits for its screen; `press` types keys and gives mg time to redraw */
  const startMg = async (file: string) => {
    const done = kernel.shell.execute(`mg ${file}`)
    await waitFor(() => kernel.shell.foregroundJob?.processes.length === 1 && kernel.terminal.ttyInputAttached)
    await waitFor(() => screenText().includes(file.split('/').pop()!))
    const press = async (keys: string) => { kernel.terminal.input(keys, true); await new Promise(resolve => setTimeout(resolve, 400)) }
    return { done, press }
  }

  it('mg edits a file and saves it', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/mg-edit.txt', 'second line\n')
    const { done, press } = await startMg('/tmp/mg-edit.txt')
    await press('first line\r')
    await press('\x18\x13') // C-x C-s
    await waitFor(() => screenText().includes('Wrote'))
    await press('\x18\x03') // C-x C-c
    expect(await done).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/mg-edit.txt', 'utf8')).toBe('first line\nsecond line\n')
  }, 90000)

  // mg starts a command with posix_spawn where it would fork (core/utils/wasm/mg/build.sh)
  it('mg runs a shell command and shows its output', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/mg-shell.txt', 'text\n')
    const { done, press } = await startMg('/tmp/mg-shell.txt')
    await press('\x1b!') // M-!: shell-command
    await press('echo from-the-shell\r')
    await waitFor(() => screenText().includes('from-the-shell') && screenText().includes('*Shell Command Output*'))
    await press('\x18\x03')
    expect(await done).toBe(0)
  }, 90000)
})
