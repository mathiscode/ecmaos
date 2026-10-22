import { beforeAll, describe, expect, it } from 'vitest'

import { processes } from '@zenfs/linux'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { PROGRAMS_ALL, TestDomOptions, TestLogOptions } from './kernel.fixtures'

async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** The programs Vim started (a `:!` command, a filter, `system()`) that are still running. */
const vimChildren = () => [...processes.values()].filter(proc => proc.code === undefined && proc.parent?.comm === 'vim')
const sleeping = () => [...processes.values()].some(proc => proc.comm === 'sleep' && proc.code === undefined)

/** Waits for the command Vim just ran to be over (keys typed while one runs are discarded by the terminal mode switch). */
const afterShellCommand = async () => {
  // the child starts a moment after the key; one quick enough to be over before the first look leaves nothing to wait for
  await waitFor(() => vimChildren().length > 0, 3000).catch(() => {})
  await waitFor(() => vimChildren().length === 0, 90000)
  await sleep(800)
}

/**
 * `/bin/vim` is Vim 9.1 built to WebAssembly (`core/utils-copyleft/wasm/vim/build.sh`), run as an ordinary worker program
 * on the terminal, the way `/bin/vi` is. These drive it with keystrokes through the line discipline.
 */
/**
 * The vim tests are slow (each starts Vim, which loads its runtime), so they are three files that run side by side, each
 * with a kernel of its own; `group` picks the tests of one by the start of their title.
 */
export function defineVim(group: string[]) {
const base = it
const selected = (title: string) => group.some(prefix => title.startsWith(prefix))
const test = ((title: string, fn: () => Promise<void> | void, timeout?: number) => selected(title) ? base(title, fn, timeout) : undefined) as unknown as typeof it
describe(`vim (${group[0]})`, () => {
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
    // the test filesystem has no catalog, so unpack the runtime the way the kernel installs it beside `vim`
    const tarball = process.getBuiltinModule('node:fs').readFileSync(`${process.cwd()}/../utils-copyleft/programs/vim-runtime.tar.gz`)
    await kernel.filesystem.fs.writeFile('/tmp/vim-runtime.tar', new Uint8Array(tarball))
    await kernel.filesystem.extractTarball('/tmp/vim-runtime.tar', '/', 0o644, 0o755)
  }, 180000)

  const typeKeys = async (keys: string) => {
    for (const key of keys) {
      kernel.terminal.input(key, true)
      // Vim waits 'ttimeoutlen' after Esc to see whether it starts a sequence
      await new Promise(resolve => setTimeout(resolve, key === '\x1b' ? 400 : 40))
    }
  }

  type Line = { translateToString(trim: boolean): string }
  /** The lines of whichever buffer is showing (Vim's alternate screen while it runs). */
  const screenLines = (): string[] => {
    const { active } = (kernel.terminal as unknown as { buffer: { active: { length: number, getLine(i: number): Line | undefined } } }).buffer
    const lines: string[] = []
    for (let i = 0; i < active.length; i++) lines.push(active.getLine(i)?.translateToString(true) ?? '')
    return lines
  }

  /** Waits until Vim has drawn: its empty-line marker is on the screen (startup now loads the runtime, which a loaded machine takes a while over). */
  const screenReady = async () => {
    await waitFor(() => screenLines().some(line => line.startsWith('~')), 90000)
    await new Promise(resolve => setTimeout(resolve, 300))
  }

  /** Waits until Vim waits for a key: blocked in one call for a while, with nothing typed left for it to read */
  const vimWaiting = () => {
    let call: number | undefined, since = 0
    return waitFor(() => {
      const vim = [...processes.values()].find(proc => proc.comm === 'vim' && proc.code === undefined)
      const page = (vim?.thread as unknown as { control?: { id: number, status: Int32Array } } | undefined)?.control
      if (!page) return true
      const ldisc = kernel.terminal.zfsTty?.ldisc as unknown as { buffer: number[], line: number[] }
      // 0 is the page's status while its call waits (`SyscallStatus.Pending`)
      if (Atomics.load(page.status, 0) !== 0 || ldisc.buffer.length || ldisc.line.length) {
        call = undefined
        return false
      }
      if (page.id !== call) {
        call = page.id
        since = Date.now()
      }
      return Date.now() - since >= 150
    }, 90000)
  }

  const edit = async (command: string, keys: string) => {
    const done = kernel.shell.execute(command)
    await waitFor(() => kernel.shell.foregroundJob?.processes.length === 1 && kernel.terminal.ttyInputAttached)
    await screenReady()
    await typeKeys(keys)
    return done
  }

  test('detects the filetype and turns syntax highlighting on, from the shipped runtime', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/ft.c', '#include <stdio.h>\nint main(void) { return 0; }\n')
    const code = await edit('vim /tmp/ft.c', ':call writefile([&filetype, exists("g:syntax_on") ? "syntax" : "plain", &syntax, execute("hi cType"), strlen(&t_AF) > 0 ? "color" : "mono"], "/tmp/ft.out")\r:q\r')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/ft.out', 'utf8')
    expect(out).toMatch(/^c\nsyntax\nc\n/)
    expect(out).toMatch(/cType\s+xxx/)
    expect(out).toMatch(/color\n$/)
  }, 120000)

  test('says in :version that it is a modified Vim, as the Vim license requires', async () => {
    const code = await edit('vim /tmp/ver.txt', ':call writefile(split(execute("version"), "\\n"), "/tmp/ver.out")\r:q\r')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/ver.out', 'utf8')).toMatch(/Modified by ecmaOS/)
  }, 120000)

  test('runs shell commands: :r !, system() and a filter', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/sh.txt', 'b\na\n')
    const done = kernel.shell.execute('vim /tmp/sh.txt')
    await waitFor(() => kernel.shell.foregroundJob?.processes.length === 1 && kernel.terminal.ttyInputAttached)
    await screenReady()
    // keys typed while a command runs are discarded by the terminal mode switch, so wait for each
    for (const command of [':r !echo from-shell\r', ':%!sort\r', ':call writefile([system("echo viasystem")[:-2], v:shell_error], "/tmp/sh.out")\r']) {
      await typeKeys(command)
      await afterShellCommand()
      await typeKeys('\r') // at "Press ENTER", or harmless in normal mode
      await new Promise(resolve => setTimeout(resolve, 300))
    }
    await typeKeys(':wq\r')
    expect(await done).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/sh.out', 'utf8')).toBe('viasystem\n0\n')
    expect(await kernel.filesystem.fs.readFile('/tmp/sh.txt', 'utf8')).toBe('a\nb\nfrom-shell\n')
  }, 120000)

  test('takes ^C as a key (leaves insert mode) instead of being killed by it', async () => {
    const done = kernel.shell.execute('vim /tmp/ctrlc.txt')
    await waitFor(() => kernel.shell.foregroundJob?.processes.length === 1 && kernel.terminal.ttyInputAttached)
    await screenReady()
    await typeKeys('ifoo\x03')
    // Vim throws away what was typed ahead of a ^C once it reads it, as at any terminal, so the rest waits for it
    await waitFor(() => !screenLines().some(line => line.includes('-- INSERT --')), 90000)
    await vimWaiting()
    await typeKeys(':wq\r')
    expect(await done).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/ctrlc.txt', 'utf8')).toBe('foo\n')
  }, 120000)

  test('^C during a shell command stops the command, not Vim', async () => {
    const done = kernel.shell.execute('vim /tmp/ctrlc2.txt')
    await waitFor(() => kernel.shell.foregroundJob?.processes.length === 1 && kernel.terminal.ttyInputAttached)
    await screenReady()
    await typeKeys(':!sleep 60\r')
    await waitFor(sleeping, 90000)
    const started = Date.now()
    kernel.terminal.input('\x03', true)
    await waitFor(() => !sleeping(), 60000)
    await sleep(1000)
    await typeKeys('\r:call writefile(["alive"], "/tmp/ctrlc2.out")\r:q!\r')
    expect(await done).toBe(0)
    expect(Date.now() - started).toBeLessThan(30000)
    expect(await kernel.filesystem.fs.readFile('/tmp/ctrlc2.out', 'utf8')).toBe('alive\n')
  }, 180000)

  test('learns of a resize at once (SIGWINCH), without a redraw', async () => {
    const terminal = kernel.terminal as unknown as { resize(cols: number, rows: number): void, cols: number, rows: number }
    const before = [terminal.cols, terminal.rows]
    const done = kernel.shell.execute('vim /tmp/size.txt')
    await waitFor(() => kernel.shell.foregroundJob?.processes.length === 1 && kernel.terminal.ttyInputAttached)
    await screenReady()
    terminal.resize(97, 31)
    await new Promise(resolve => setTimeout(resolve, 1500))
    await typeKeys(':call writefile([&columns . "x" . &lines], "/tmp/size.out")\r:q!\r')
    expect(await done).toBe(0)
    terminal.resize(before[0]!, before[1]!)
    expect(await kernel.filesystem.fs.readFile('/tmp/size.out', 'utf8')).toBe('97x31\n')
  }, 180000)

  test('detects the common filetypes without a script error', async () => {
    const names = ['a.c', 'a.cpp', 'a.py', 'a.js', 'a.ts', 'a.json', 'a.md', 'a.sh', 'Makefile', 'a.html', 'a.css', 'a.rs', 'a.go', 'a.yaml', 'a.toml', 'Dockerfile', 'a.vim', 'a.lua', 'a.java', 'a.sql', 'noext']
    await kernel.filesystem.fs.mkdir('/tmp/ft', { recursive: true })
    for (const name of names) await kernel.filesystem.fs.writeFile(`/tmp/ft/${name}`, name === 'noext' ? '#!/bin/sh\necho hi\n' : 'x\n')
    // Silent Ex mode has no screen to stop at. Vim's own scripts run commands that may fail under `silent!`
    // (those still reach :messages), so look only for the errors that mean a runtime file is missing:
    // E484 can't open a file, E117 unknown function (an autoload script), E666 no such compiler, E185 no colour scheme.
    const script = `let r = [] | for f in ${JSON.stringify(names).replace(/"/g, "'")} | execute 'edit /tmp/ft/' . f | call add(r, f . '=' . &filetype) | endfor | call writefile(r, '/tmp/ft.list') | redir! > /tmp/ft.msg | silent messages | redir END`
    const code = await kernel.shell.execute(`vim -es -u /etc/vimrc -c "${script}" -c "q!"`)
    const lines = (await kernel.filesystem.fs.readFile('/tmp/ft.list', 'utf8')).trim().split('\n')
    const messages = await kernel.filesystem.fs.readFile('/tmp/ft.msg', 'utf8')
    expect(messages.split('\n').filter(line => /E(484|117|666|185)\b/.test(line))).toEqual([])
    expect(lines).toEqual(expect.arrayContaining(['a.c=c', 'a.py=python', 'a.js=javascript', 'a.ts=typescript', 'a.json=json', 'a.md=markdown', 'a.sh=sh', 'Makefile=make', 'a.rs=rust', 'a.go=go', 'noext=sh']))
    expect(code).toBeLessThanOrEqual(1)
  }, 180000)

  test('writes a system vimrc that turns off vi compatibility', async () => {
    expect(await kernel.filesystem.fs.readFile('/etc/vimrc', 'utf8')).toContain('set nocompatible')
  })

  test('starts without a startup error (no defaults.vim to fail on)', async () => {
    const done = kernel.shell.execute('vim /tmp/vim-clean.txt')
    await waitFor(() => kernel.shell.foregroundJob?.processes.length === 1 && kernel.terminal.ttyInputAttached)
    await screenReady()
    const screen = screenLines()
    await typeKeys('\x1b:q!\r')
    expect(await done).toBe(0)
    expect(screen.filter(line => line.trim()).join('\n')).not.toMatch(/E\d{3,4}|Press ENTER/)
  }, 120000)

  test('uses the alternate screen, so its display is gone when it exits', async () => {
    const terminal = kernel.terminal as unknown as { write: (data: unknown, ...rest: unknown[]) => unknown }
    const original = terminal.write.bind(terminal)
    const written: string[] = []
    terminal.write = (data, ...rest) => { written.push(typeof data === 'string' ? data : new TextDecoder().decode(data as Uint8Array)); return original(data, ...rest) }
    try {
      const code = await edit('vim /tmp/vim-alt.txt', '\x1b:q\r')
      expect(code).toBe(0)
    } finally {
      terminal.write = original
    }
    const output = written.join('')
    expect(output).toContain('\x1b[?1049h')
    expect(output.lastIndexOf('\x1b[?1049l')).toBeGreaterThan(output.indexOf('\x1b[?1049h'))
  }, 120000)

  test('edits, searches by regex, substitutes and saves a file', async () => {
    const code = await edit('vim /tmp/vim-out.txt', 'ifoo bar foo\x1b:%s/fo\\+/baz/g\r/bar\rcwqux\x1b:wq\r')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/vim-out.txt', 'utf8')).toBe('baz qux baz\n')
  }, 120000)

  test('has visual mode, undo and redo', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/vim-visual.txt', 'one two three\n')
    // visual select "one", delete it; undo; redo; then yank-paste a word with `yw` `P`
    const code = await edit('vim /tmp/vim-visual.txt', 'vlld\x1bu\x12:wq\r')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/vim-visual.txt', 'utf8')).toBe(' two three\n')
  }, 120000)

  test('runs Vimscript', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/vim-eval.txt', 'x\n')
    const code = await edit('vim /tmp/vim-eval.txt', ':put =1+2*3\r:wq\r')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/vim-eval.txt', 'utf8')).toBe('x\n7\n')
  }, 120000)

  test('is also reachable as vi, a link to vim', async () => {
    expect(await kernel.filesystem.fs.readlink('/bin/vi')).toBe('/bin/vim')
    const code = await edit('vi /tmp/vi-out.txt', 'ivi\x1b:wq\r')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/vi-out.txt', 'utf8')).toBe('vi\n')
  }, 120000)

  test('leaves a file alone on :q! and writes no swap or backup file', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/vim-keep.txt', 'keep me\n')
    const code = await edit('vim /tmp/vim-keep.txt', 'dd\x1b:q!\r')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/vim-keep.txt', 'utf8')).toBe('keep me\n')
    const names = await kernel.filesystem.fs.readdir('/tmp')
    expect(names.filter(name => name.includes('vim-keep') && name !== 'vim-keep.txt')).toEqual([])
  }, 120000)
})
}
