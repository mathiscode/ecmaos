import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { PROGRAMS_ALL, TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/**
 * `/bin/nano` is GNU nano built to WebAssembly with ncurses (`core/utils-copyleft/wasm/nano`), driven here on the
 * terminal as a person would: editing and saving, and the programs it starts (a command, a filter, a formatter and a
 * linter), which it starts with posix_spawn where it would fork.
 */
describe('nano', () => {
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

  /** What is on the terminal screen (nano's alternate buffer while it runs). */
  const screenText = () => {
    const { active } = (kernel.terminal as unknown as { buffer: { active: { length: number, getLine(i: number): { translateToString(trim: boolean): string } | undefined } } }).buffer
    const lines: string[] = []
    for (let i = 0; i < active.length; i++) lines.push(active.getLine(i)?.translateToString(true) ?? '')
    return lines.join('\n')
  }

  /** Starts nano on `file` in the foreground and waits for its screen; `press` types keys and gives nano time to redraw */
  const startNano = async (file: string) => {
    const done = kernel.shell.execute(`nano ${file}`)
    await waitFor(() => kernel.shell.foregroundJob?.processes.length === 1 && kernel.terminal.ttyInputAttached)
    await waitFor(() => screenText().includes(file.split('/').pop()!))
    const press = async (keys: string) => { kernel.terminal.input(keys, true); await new Promise(resolve => setTimeout(resolve, 400)) }
    /** ^O, Enter for the name it has: writes the file */
    const save = async () => {
      await press('\x0f')
      await press('\r')
      await waitFor(() => screenText().includes('Wrote'))
    }
    return { done, press, save }
  }

  it('edits a file and saves it', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/nano-edit.txt', 'second line\n')
    const { done, press, save } = await startNano('/tmp/nano-edit.txt')
    await press('first line\r')
    await save()
    await press('\x18') // ^X
    expect(await done).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/nano-edit.txt', 'utf8')).toBe('first line\nsecond line\n')
  }, 90000)

  it('executes a command and inserts its output (^T)', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/nano-exec.txt', 'text\n')
    const { done, press, save } = await startNano('/tmp/nano-exec.txt')
    await press('\x14') // ^T
    await waitFor(() => screenText().includes('Command to execute'))
    await press('echo "from $(echo the-shell)"\r')
    await waitFor(() => screenText().includes('from the-shell'))
    await save()
    await press('\x18')
    expect(await done).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/nano-exec.txt', 'utf8')).toBe('from the-shell\ntext\n')
  }, 90000)

  // the text goes to the command from a thread while nano reads what comes back: cat writes as it reads, and more than
  // a pipe holds goes each way, so this would hang if one waited for the other
  it('filters the buffer through a command (^T with |)', async () => {
    const lines = Array.from({ length: 12000 }, (_, i) => `line ${String(i).padStart(5, '0')}`)
    await kernel.filesystem.fs.writeFile('/tmp/nano-filter.txt', lines.join('\n') + '\n')
    const { done, press, save } = await startNano('/tmp/nano-filter.txt')
    await press('\x14')
    await waitFor(() => screenText().includes('Command to execute'))
    await press('|cat; echo end of filter\r')
    await waitFor(() => screenText().includes('Read 12001 lines'))
    await save()
    await press('\x18')
    expect(await done).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/nano-filter.txt', 'utf8')).toBe(lines.join('\n') + '\nend of filter\n')
  }, 90000)

  it('runs the formatter and the linter a syntax names (^T ^O, ^T ^Y)', async () => {
    const fs = kernel.filesystem.fs
    await fs.writeFile('/root/.nanorc', 'syntax "checked" "\\.chk$"\nformatter sh /tmp/nano-format.sh\nlinter sh /tmp/nano-lint.sh\n')
    await fs.writeFile('/tmp/nano-format.sh', 'printf "formatted\\nsecond\\n" > "$1"\n')
    await fs.writeFile('/tmp/nano-lint.sh', 'echo "$1:2:1: the second line is wrong"\n')
    await fs.writeFile('/tmp/nano.chk', 'raw\n')
    try {
      const { done, press, save } = await startNano('/tmp/nano.chk')
      await press('\x14')
      await waitFor(() => screenText().includes('Command to execute'))
      await press('\x0f') // ^O: the formatter
      await waitFor(() => screenText().includes('formatted'))
      await save()
      await press('\x14')
      await waitFor(() => screenText().includes('Command to execute'))
      await press('\x19') // ^Y: the linter
      await waitFor(() => screenText().includes('the second line is wrong'))
      await press('\x18') // leaves the linter
      await press('\x18')
      expect(await done).toBe(0)
      expect(await fs.readFile('/tmp/nano.chk', 'utf8')).toBe('formatted\nsecond\n')
    } finally {
      await fs.unlink('/root/.nanorc')
    }
  }, 90000)
})
