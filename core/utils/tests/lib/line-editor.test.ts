import { describe, expect, it } from 'vitest'

import { LineEditor, NONPRINTING_END, NONPRINTING_START, ReverseSearch, stripMarkers, visibleWidth } from '../../src/lib/line-editor.ts'

/**
 * The line editor against a recording host, so what it draws is asserted directly. No terminal, no
 * shell: that is the point of the extraction, and it means every escape sequence below is the
 * editor's own doing.
 */
const editorAt = (options: { cols?: number, prompt?: number } = {}) => {
  const out: string[] = []
  const editor = new LineEditor({
    write: data => { out.push(data) },
    cols: options.cols ?? 80,
    promptWidth: () => options.prompt ?? 2
  })
  return { editor, out, drawn: () => out.join(''), clear: () => { out.length = 0 } }
}

describe('visibleWidth', () => {
  it('ignores color codes', () => {
    expect(visibleWidth('\x1b[32mroot\x1b[0m# ')).toBe(6)
  })

  it('ignores anything between the non-printing markers', () => {
    expect(visibleWidth(`${NONPRINTING_START}garbage that takes no room${NONPRINTING_END}$ `)).toBe(2)
  })

  it('counts an emoji as one column', () => {
    expect(visibleWidth('👤 ')).toBe(2)
  })

  it('stripMarkers leaves the printable text', () => {
    expect(stripMarkers(`${NONPRINTING_START}x${NONPRINTING_END}y`)).toBe('xy')
  })
})

describe('LineEditor editing', () => {
  it('draws a character typed at the end and nothing else', () => {
    const { editor, drawn } = editorAt()
    editor.insert('a')
    expect(drawn()).toBe('a')
    expect(editor.text).toBe('a')
    expect(editor.cursor).toBe(1)
  })

  it('repaints the tail and returns the cursor when inserting mid-line', () => {
    const { editor, drawn, clear } = editorAt()
    editor.insert('ac')
    editor.left()
    clear()
    editor.insert('b')
    expect(editor.text).toBe('abc')
    expect(editor.cursor).toBe(2)
    // clear-to-end, the tail from the insertion point, then back to the cursor column (prompt 2 + 2 + 1)
    expect(drawn()).toBe('\x1b[Jbc\x1b[5G')
  })

  it('backspace removes the character before the cursor', () => {
    const { editor } = editorAt()
    editor.insert('abc')
    editor.left()
    expect(editor.backspace()).toBe(true)
    expect(editor.text).toBe('ac')
    expect(editor.cursor).toBe(1)
  })

  it('backspace at the start rings the bell and changes nothing', () => {
    const { editor, drawn } = editorAt()
    expect(editor.backspace()).toBe(false)
    expect(drawn()).toBe('\x07')
  })

  it('deleteForward removes the character under the cursor', () => {
    const { editor } = editorAt()
    editor.insert('abc')
    editor.home()
    editor.deleteForward()
    expect(editor.text).toBe('bc')
    expect(editor.cursor).toBe(0)
  })

  it('moves by words, skipping whitespace as readline does', () => {
    const { editor } = editorAt()
    editor.insert('one two  three')
    editor.wordLeft()
    expect(editor.cursor).toBe(9)
    editor.wordLeft()
    expect(editor.cursor).toBe(4)
    editor.wordRight()
    expect(editor.cursor).toBe(9)
  })

  it('set() changes the model without drawing', () => {
    const { editor, drawn } = editorAt()
    editor.set('hello', 2)
    expect(drawn()).toBe('')
    expect(editor.cursor).toBe(2)
    editor.set('hi', 99)
    expect(editor.cursor).toBe(2)
  })
})

describe('LineEditor line wrapping', () => {
  it('forces the wrap when the text ends exactly on the last column', () => {
    // prompt 2 + 6 chars = 8 = cols, so a terminal would leave the cursor on the last column with the
    // wrap pending; the editor forces it so its row arithmetic holds.
    const { editor, drawn } = editorAt({ cols: 8, prompt: 2 })
    editor.insert('abcdef')
    expect(drawn()).toBe('abcdef' + ' \r')
  })

  it('does not force a wrap when the text stops short of the edge', () => {
    const { editor, drawn } = editorAt({ cols: 8, prompt: 2 })
    editor.insert('abcde')
    expect(drawn()).toBe('abcde')
  })

  it('moves up a row when the cursor crosses back over a wrap', () => {
    const { editor, drawn, clear } = editorAt({ cols: 8, prompt: 2 })
    editor.insert('abcdefgh') // ends on row 1
    clear()
    editor.home()
    expect(drawn()).toBe('\x1b[1A\x1b[3G')
  })

  it('eraseBlock counts ceil(len / cols) rows, not floor', () => {
    const { editor, drawn, clear } = editorAt({ cols: 8, prompt: 2 })
    editor.insert('abcdef') // exactly one full row
    clear()
    editor.eraseBlock()
    // one row occupied: no upward move, or the erase would wipe the line above the prompt
    expect(drawn()).toBe('\r\x1b[J')
  })
})

describe('LineEditor kill ring', () => {
  it('^W kills the word before the cursor and ^Y brings it back', () => {
    const { editor } = editorAt()
    editor.insert('echo hello')
    editor.killWordBackward()
    expect(editor.text).toBe('echo ')
    editor.yank()
    expect(editor.text).toBe('echo hello')
  })

  it('consecutive kills accumulate, so ^W^W^Y restores both words', () => {
    const { editor } = editorAt()
    editor.insert('a bb ccc')
    editor.killWordBackward()
    editor.killWordBackward()
    expect(editor.text).toBe('a ')
    editor.yank()
    expect(editor.text).toBe('a bb ccc')
  })

  it('a motion between kills starts a new entry', () => {
    const { editor } = editorAt()
    editor.insert('aa bb')
    editor.killWordBackward()
    editor.home()
    editor.killWordForward()
    // Alt-D kills to the end of the word, not the space after it
    expect(editor.killRing).toEqual(['bb', 'aa'])
  })

  it('^U kills to the start and ^K to the end, and back-to-back they form one entry', () => {
    const { editor } = editorAt()
    editor.set('abcdef', 3)
    editor.killToStart()
    expect(editor.text).toBe('def')
    editor.killToEnd()
    expect(editor.text).toBe('')
    expect(editor.killRing).toEqual(['abcdef'])
  })

  it('yank with an empty ring does nothing', () => {
    const { editor } = editorAt()
    editor.yank()
    expect(editor.text).toBe('')
  })
})

describe('ReverseSearch', () => {
  const history = ['ls -la', 'cd /tmp', 'echo hello', 'cat notes', 'echo world']

  it('finds the newest match first', () => {
    const search = new ReverseSearch(history, '')
    for (const ch of 'echo') search.type(ch)
    expect(search.match).toBe('echo world')
  })

  it('^R steps to an older match, and stays on the last one rather than failing', () => {
    const search = new ReverseSearch(history, '')
    for (const ch of 'echo') search.type(ch)
    search.next()
    expect(search.match).toBe('echo hello')
    search.next()
    expect(search.match).toBe('echo hello')
    expect(search.failed).toBe(false)
  })

  it('reports a failed search when nothing matches', () => {
    const search = new ReverseSearch(history, '')
    for (const ch of 'zzz') search.type(ch)
    expect(search.match).toBeUndefined()
    expect(search.failed).toBe(true)
    expect(search.render()).toContain('failed reverse-i-search')
  })

  it('backspace widens the query again', () => {
    const search = new ReverseSearch(history, '')
    for (const ch of 'catz') search.type(ch)
    expect(search.failed).toBe(true)
    search.backspace()
    expect(search.match).toBe('cat notes')
  })

  it('remembers what was on the line, for a cancel', () => {
    expect(new ReverseSearch(history, 'half typed').originalText).toBe('half typed')
  })
})
