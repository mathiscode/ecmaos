import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { visibleWidth } from '@ecmaos/coreutils/lib/line-editor'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * The prompt's line editor, driven the way a keyboard drives it: through `keyHandler`, one key
 * event at a time. The editor's own arithmetic is covered in `lib/line-editor.test.ts`; this is the
 * wiring -- that `Terminal` routes the keys, that `PS1`/`PS2` and the non-printing markers reach the
 * width the editor uses, and that history and `^R` sit on the same line.
 */
describe('Terminal line editing', () => {
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

  type Internals = {
    _cmd: string
    _cursorPosition: number
    _multiLineMode: boolean
    _multiLineBuffer: string
    _search: unknown
  }
  const terminal = () => kernel.terminal
  const state = () => terminal() as unknown as Internals

  const event = (key: string, modifiers: Partial<Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>> = {}) =>
    ({ key, altKey: false, ctrlKey: false, shiftKey: false, metaKey: false, preventDefault() {}, stopPropagation() {}, ...modifiers }) as KeyboardEvent

  /** A printable character, as xterm reports it. */
  const press = (char: string) => terminal().keyHandler({ key: char, domEvent: event(char) })
  const type = async (text: string) => { for (const char of text) await press(char) }
  const ctrl = (letter: string) => terminal().keyHandler({ key: String.fromCharCode(letter.charCodeAt(0) - 96), domEvent: event(letter, { ctrlKey: true }) })
  const alt = (name: string) => terminal().keyHandler({ key: '', domEvent: event(name, { altKey: true }) })
  const named = (name: string) => terminal().keyHandler({ key: '', domEvent: event(name) })

  let written: string[] = []

  beforeEach(async () => {
    state()._cmd = ''
    state()._cursorPosition = 0
    state()._multiLineMode = false
    state()._multiLineBuffer = ''
    state()._search = undefined
    kernel.shell.env.delete('PS2')
    kernel.shell.env.delete('PROMPT')
    await terminal().clearHistory(0)
    written = []
    vi.spyOn(terminal(), 'write').mockImplementation((data: string | Uint8Array) => { written.push(String(data)) })
  })

  afterEach(() => { vi.restoreAllMocks() })

  describe('kill ring', () => {
    it('^W kills a word and ^Y yanks it back', async () => {
      await type('echo hello')
      await ctrl('w')
      expect(state()._cmd).toBe('echo ')
      await ctrl('y')
      expect(state()._cmd).toBe('echo hello')
    })

    it('^U and ^K cut either side of the cursor', async () => {
      await type('abcdef')
      await named('ArrowLeft'); await named('ArrowLeft'); await named('ArrowLeft')
      await ctrl('k')
      expect(state()._cmd).toBe('abc')
      await ctrl('u')
      expect(state()._cmd).toBe('')
    })

    it('does not insert a control character for an unbound ^X', async () => {
      await type('ab')
      await ctrl('x')
      expect(state()._cmd).toBe('ab')
    })
  })

  describe('motion', () => {
    it('^A and ^E move to the ends, ^B and ^F by a character', async () => {
      await type('abc')
      await ctrl('a')
      expect(state()._cursorPosition).toBe(0)
      await ctrl('f')
      expect(state()._cursorPosition).toBe(1)
      await ctrl('e')
      expect(state()._cursorPosition).toBe(3)
      await ctrl('b')
      expect(state()._cursorPosition).toBe(2)
    })

    it('Alt-B and Alt-F move by words', async () => {
      await type('one two')
      await alt('b')
      expect(state()._cursorPosition).toBe(4)
      await alt('f')
      expect(state()._cursorPosition).toBe(7)
    })

    it('Alt-Backspace kills the word before the cursor', async () => {
      await type('one two')
      await alt('Backspace')
      expect(state()._cmd).toBe('one ')
    })

    it('^D deletes the character under the cursor', async () => {
      await type('abc')
      await ctrl('a')
      await ctrl('d')
      expect(state()._cmd).toBe('bc')
    })
  })

  describe('history', () => {
    it('ArrowUp recalls the last command and ArrowDown returns to an empty line', async () => {
      await terminal()['_history'].add(0, 'first')
      await terminal()['_history'].add(0, 'second')

      await named('ArrowUp')
      expect(state()._cmd).toBe('second')
      await named('ArrowUp')
      expect(state()._cmd).toBe('first')
      await named('ArrowDown')
      await named('ArrowDown')
      expect(state()._cmd).toBe('')
    })

    it('does not go past either end', async () => {
      await terminal()['_history'].add(0, 'only')
      await named('ArrowUp')
      await named('ArrowUp')
      await named('ArrowUp')
      expect(state()._cmd).toBe('only')
    })
  })

  describe('^R reverse search', () => {
    it('finds a command, and Enter runs it', async () => {
      const history = terminal()['_history']
      await history.add(0, 'echo alpha > /tmp/rs-alpha.out')
      await history.add(0, 'echo beta > /tmp/rs-beta.out')

      await ctrl('r')
      await type('alpha')
      expect(written.join('')).toContain("(reverse-i-search)`alpha': echo alpha")

      await named('Enter')
      expect(await kernel.filesystem.fs.exists('/tmp/rs-alpha.out')).toBe(true)
      expect(await kernel.filesystem.fs.exists('/tmp/rs-beta.out')).toBe(false)
    })

    it('Escape cancels back to what was typed', async () => {
      await terminal()['_history'].add(0, 'echo found')
      await type('half')
      await ctrl('r')
      await type('found')
      await named('Escape')
      expect(state()._cmd).toBe('half')
      expect(state()._search).toBeUndefined()
    })

    it('any other key accepts the match into the line and then acts', async () => {
      await terminal()['_history'].add(0, 'echo found')
      await ctrl('r')
      await type('found')
      await ctrl('a')
      expect(state()._cmd).toBe('echo found')
      expect(state()._cursorPosition).toBe(0)
    })
  })

  describe('prompts', () => {
    it('shows $PS2 on a continuation line, defaulting to "> "', async () => {
      await type('echo one \\')
      await named('Enter')
      expect(written.join('')).toContain('\n> ')

      state()._multiLineMode = false
      state()._multiLineBuffer = ''
      kernel.shell.env.set('PS2', 'more> ')
      await type('echo two \\')
      written = []
      await named('Enter')
      expect(written.join('')).toContain('\nmore> ')
    })

    it('measures a continuation line against $PS2, not $PS1', async () => {
      kernel.shell.env.set('PS2', '....> ')
      state()._multiLineMode = true
      expect(terminal().promptWidth()).toBe(6)
      state()._multiLineMode = false
      expect(terminal().promptWidth()).toBe(visibleWidth(terminal().prompt()))
    })

    it('honors \\[ and \\] in the width and drops the markers from what is written', () => {
      kernel.shell.env.set('PROMPT', '\\[NONPRINTING\\]$ ')
      expect(terminal().prompt()).toBe('NONPRINTING$ ')
      expect(terminal().promptWidth()).toBe(2)
    })

    it('does not count colors written with \\e in the width', () => {
      kernel.shell.env.set('PROMPT', '\\[\\e[31m\\]x\\[\\e[0m\\]> ')
      expect(terminal().promptWidth()).toBe(3)
    })

    it('expands \\t \\d \\A \\! \\# \\j \\e \\\\', () => {
      kernel.shell.env.set('PROMPT', '\\t|\\d|\\A|\\!|\\#|\\j|\\\\')
      const prompt = terminal().prompt()
      const [time, date, hm, history, number, jobs, slash] = prompt.split('|')
      expect(time).toMatch(/^\d\d:\d\d:\d\d$/)
      expect(date).toMatch(/^\w{3} \w{3} \d\d$/)
      expect(hm).toMatch(/^\d\d:\d\d$/)
      expect(history).toMatch(/^\d+$/)
      expect(number).toMatch(/^\d+$/)
      expect(jobs).toMatch(/^\d+$/)
      expect(slash).toBe('\\')
    })
  })

  describe('multi-line input', () => {
    it('^C abandons a continuation instead of leaving the prompt stuck in it', async () => {
      await type('echo one \\')
      await named('Enter')
      expect(state()._multiLineMode).toBe(true)

      await ctrl('c')
      expect(state()._multiLineMode).toBe(false)
      expect(state()._multiLineBuffer).toBe('')
    })
  })

  describe('tab completion', () => {
    it('cycles through a directory when the line ends in a slash, without running ls', async () => {
      await kernel.filesystem.fs.mkdir('/tmp/tabdir', { recursive: true })
      await kernel.filesystem.fs.writeFile('/tmp/tabdir/one', '')
      await kernel.filesystem.fs.writeFile('/tmp/tabdir/two', '')
      const execute = vi.spyOn(kernel.shell, 'execute')

      await type('cat /tmp/tabdir/')
      await named('Tab')
      expect(state()._cmd).toBe('cat /tmp/tabdir/one')
      await named('Tab')
      expect(state()._cmd).toBe('cat /tmp/tabdir/two')
      expect(execute).not.toHaveBeenCalled()
    })
  })

  describe('paste', () => {
    it('inserts at the cursor and joins lines with spaces', async () => {
      await type('ab')
      await named('ArrowLeft')
      await terminal().paste('X\nY')
      expect(state()._cmd).toBe('aX Yb')
    })
  })

  describe('clearCommand and restoreCommand', () => {
    it('round-trip the line the editor holds', async () => {
      await type('half typed')
      const saved = terminal().clearCommand()
      expect(saved).toBe('half typed')
      expect(state()._cmd).toBe('')

      terminal().restoreCommand(saved)
      expect(state()._cmd).toBe('half typed')
      expect(state()._cursorPosition).toBe(10)
    })
  })
})
