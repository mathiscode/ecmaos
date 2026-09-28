import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * Covers `Terminal`'s Enter handler across *several* Enter presses -- the one layer of the shell
 * that had no test at all, and where a live browser smoke test found three shipped-and-claimed
 * features broken at once.
 *
 * Every other shell test drives `Shell.execute(oneLine)` or `executeScriptText(wholeScript)`
 * directly, so they all passed while typing the same constructs at a real prompt did not work:
 * `cat <<EOF` ran immediately and the heredoc body was then executed as commands, and
 * `for i in 1 2 3; do` reported "Command not found: for". The Enter handler knew exactly one
 * continuation rule (a trailing backslash) and never consulted the parser, even though
 * `pendingHeredocDelimiter` had been written for precisely this and left uncalled.
 *
 * These drive the keyboard, not the shell, on purpose. A test that calls `Shell.execute` cannot
 * observe this class of bug.
 */
describe('Terminal multi-line input', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()
  })

  /** The Enter handler's private continuation state, which is what these assert against. */
  const state = () => kernel.terminal as unknown as {
    _cmd: string
    _cursorPosition: number
    _multiLineMode: boolean
    _multiLineBuffer: string
  }

  /** Type a whole line and press Enter, the way a person at the prompt would. */
  const typeLine = async (line: string) => {
    const terminal = state()
    terminal._cmd = line
    terminal._cursorPosition = line.length
    await kernel.terminal.keyHandler({
      key: '\r',
      domEvent: { key: 'Enter', altKey: false, ctrlKey: false, shiftKey: false, metaKey: false } as KeyboardEvent
    })
  }

  beforeEach(() => {
    const terminal = state()
    terminal._cmd = ''
    terminal._cursorPosition = 0
    terminal._multiLineMode = false
    terminal._multiLineBuffer = ''
  })

  it('stays in continuation after an opening heredoc instead of running it', async () => {
    await typeLine('cat <<EOF')
    expect(state()._multiLineMode).toBe(true)
  })

  it('runs a typed heredoc once its terminator arrives, delivering the body', async () => {
    await typeLine('cat <<EOF > /tmp/typed-heredoc.out')
    expect(state()._multiLineMode).toBe(true)

    await typeLine('first line')
    expect(state()._multiLineMode).toBe(true)

    await typeLine('second line')
    expect(state()._multiLineMode).toBe(true)

    await typeLine('EOF')
    expect(state()._multiLineMode).toBe(false)

    const out = await kernel.filesystem.fs.readFile('/tmp/typed-heredoc.out', 'utf-8')
    expect(out).toBe('first line\nsecond line\n')
  })

  it('runs a for loop typed across several lines', async () => {
    await typeLine('for i in 1 2 3; do')
    expect(state()._multiLineMode).toBe(true)

    await typeLine('echo loop-$i >> /tmp/typed-for.out')
    expect(state()._multiLineMode).toBe(true)

    await typeLine('done')
    expect(state()._multiLineMode).toBe(false)

    const out = await kernel.filesystem.fs.readFile('/tmp/typed-for.out', 'utf-8')
    expect(out).toBe('loop-1\nloop-2\nloop-3\n')
  })

  it('runs an if/else typed across several lines', async () => {
    await typeLine('if true; then')
    expect(state()._multiLineMode).toBe(true)
    await typeLine('echo taken > /tmp/typed-if.out')
    await typeLine('else')
    expect(state()._multiLineMode).toBe(true)
    await typeLine('echo not-taken > /tmp/typed-if.out')
    await typeLine('fi')
    expect(state()._multiLineMode).toBe(false)

    const out = await kernel.filesystem.fs.readFile('/tmp/typed-if.out', 'utf-8')
    expect(out).toBe('taken\n')
  })

  it('accepts do on its own line', async () => {
    await typeLine('for i in a b')
    expect(state()._multiLineMode).toBe(true)
    await typeLine('do')
    expect(state()._multiLineMode).toBe(true)
    await typeLine('echo $i >> /tmp/typed-for-do.out')
    await typeLine('done')
    expect(state()._multiLineMode).toBe(false)

    const out = await kernel.filesystem.fs.readFile('/tmp/typed-for-do.out', 'utf-8')
    expect(out).toBe('a\nb\n')
  })

  it('still runs a complete single line immediately', async () => {
    await typeLine('echo single > /tmp/typed-single.out')
    expect(state()._multiLineMode).toBe(false)
    expect(await kernel.filesystem.fs.readFile('/tmp/typed-single.out', 'utf-8')).toBe('single\n')
  })

  it('still runs a single-line for loop immediately', async () => {
    await typeLine('for i in 1 2; do echo compact-$i >> /tmp/typed-compact.out; done')
    expect(state()._multiLineMode).toBe(false)
    expect(await kernel.filesystem.fs.readFile('/tmp/typed-compact.out', 'utf-8')).toBe('compact-1\ncompact-2\n')
  })

  it('keeps the trailing-backslash continuation working', async () => {
    await typeLine('echo one \\')
    expect(state()._multiLineMode).toBe(true)
    await typeLine('two > /tmp/typed-backslash.out')
    expect(state()._multiLineMode).toBe(false)
    expect(await kernel.filesystem.fs.readFile('/tmp/typed-backslash.out', 'utf-8')).toBe('one two\n')
  })

  it('does not trap the prompt in continuation on a syntax error', async () => {
    // `fi` with nothing open can never become valid, so it must run (and fail) rather than leave
    // the user at a `>` prompt with no way to get back.
    await typeLine('fi')
    expect(state()._multiLineMode).toBe(false)
  })
})
