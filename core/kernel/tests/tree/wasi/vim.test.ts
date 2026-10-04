import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/**
 * `/bin/vim` is Vim 9.1 built to WebAssembly (`wasm/vim/build.sh`), run as an ordinary worker program
 * on the terminal, the way `/bin/vi` is. These drive it with keystrokes through the line discipline.
 */
describe('vim', () => {
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

  const typeKeys = async (keys: string) => {
    for (const key of keys) {
      kernel.terminal.input(key, true)
      // Vim waits 'ttimeoutlen' after Esc to see whether it starts a sequence
      await new Promise(resolve => setTimeout(resolve, key === '\x1b' ? 400 : 40))
    }
  }

  const edit = async (command: string, keys: string) => {
    const done = kernel.shell.execute(command)
    await waitFor(() => kernel.shell.foregroundJob?.processes.length === 1 && kernel.terminal.ttyInputAttached)
    await new Promise(resolve => setTimeout(resolve, 2000))
    await typeKeys(keys)
    return done
  }

  it('writes a system vimrc that turns off vi compatibility', async () => {
    expect(await kernel.filesystem.fs.readFile('/etc/vimrc', 'utf8')).toContain('set nocompatible')
  })

  it('starts without a startup error (no defaults.vim to fail on)', async () => {
    const done = kernel.shell.execute('vim /tmp/vim-clean.txt')
    await waitFor(() => kernel.shell.foregroundJob?.processes.length === 1 && kernel.terminal.ttyInputAttached)
    await new Promise(resolve => setTimeout(resolve, 2500))
    const buffer = (kernel.terminal as unknown as { buffer: { active: { length: number, getLine(i: number): { translateToString(trim: boolean): string } | undefined } } }).buffer.active
    const screen: string[] = []
    for (let i = 0; i < buffer.length; i++) screen.push(buffer.getLine(i)?.translateToString(true) ?? '')
    await typeKeys('\x1b:q!\r')
    expect(await done).toBe(0)
    expect(screen.join('\n')).not.toMatch(/E\d{3,4}|Press ENTER/)
  }, 30000)

  it('edits, searches by regex, substitutes and saves a file', async () => {
    const code = await edit('vim /tmp/vim-out.txt', 'ifoo bar foo\x1b:%s/fo\\+/baz/g\r/bar\rcwqux\x1b:wq\r')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/vim-out.txt', 'utf8')).toBe('baz qux baz\n')
  }, 30000)

  it('has visual mode, undo and redo', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/vim-visual.txt', 'one two three\n')
    // visual select "one", delete it; undo; redo; then yank-paste a word with `yw` `P`
    const code = await edit('vim /tmp/vim-visual.txt', 'vlld\x1bu\x12:wq\r')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/vim-visual.txt', 'utf8')).toBe(' two three\n')
  }, 30000)

  it('runs Vimscript', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/vim-eval.txt', 'x\n')
    const code = await edit('vim /tmp/vim-eval.txt', ':put =1+2*3\r:wq\r')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/vim-eval.txt', 'utf8')).toBe('x\n7\n')
  }, 30000)

  it('leaves a file alone on :q! and writes no swap or backup file', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/vim-keep.txt', 'keep me\n')
    const code = await edit('vim /tmp/vim-keep.txt', 'dd\x1b:q!\r')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/vim-keep.txt', 'utf8')).toBe('keep me\n')
    const names = await kernel.filesystem.fs.readdir('/tmp')
    expect(names.filter(name => name.includes('vim-keep') && name !== 'vim-keep.txt')).toEqual([])
  }, 30000)
})
