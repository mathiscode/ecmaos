/**
 * The line editor: what a shell prompt does with keys, kept apart from what draws it.
 *
 * `Terminal` used to carry four editors - `keyHandler`, `readline`, and one each for the mobile text
 * field and the mobile password field - sharing a `_cmd`/`_cursorPosition` pair that five other
 * methods also mutated, and repeating the same wrap-aware cursor math at about a dozen sites. This is
 * the one editor: a model (`text`, `cursor`, a kill ring) plus the repaint it implies, talking to the
 * screen only through a three-member host so it has no idea whether xterm.js or a raw tty is behind it.
 *
 * Two things a host must provide that are easy to get subtly wrong:
 *
 * - `promptWidth()` is the *visible* width of the prompt, in columns. Cursor math is done in columns,
 *   so a prompt measured with its color codes counted lands the cursor a few cells right of where
 *   it is. Use {@link visibleWidth}, which also honors the `\x01`...`\x02` non-printing markers.
 * - `write` may be called with any mix of text and escape sequences; nothing here reads the screen.
 *
 * Line-wrap model: a line's cells are numbered from the start of the prompt, so the character at
 * offset `n` sits at row `floor((promptWidth + n) / cols)`, column `(promptWidth + n) % cols`. A
 * terminal defers the wrap when text ends exactly on the last column, leaving the cursor there rather
 * than on the next row; {@link LineEditor} forces the wrap (a space and a carriage return) so that the
 * floor model holds. Without it, a line that filled a row exactly moved the cursor one row too far.
 */

/** What the editor needs from whatever is showing the line. */
export interface LineEditorHost {
  write(data: string): void
  /** Terminal width in columns. Read on every operation, since it changes on resize. */
  readonly cols: number
  /** Visible width of the prompt that precedes the line, in columns. */
  promptWidth(): number
}

/** Start and end of a run that occupies no columns, as in readline's `RL_PROMPT_START_IGNORE`. */
export const NONPRINTING_START = '\x01'
export const NONPRINTING_END = '\x02'

const CSI = /\x1b\[[0-9;?]*[a-zA-Z]/g
const NONPRINTING = new RegExp(`${NONPRINTING_START}[^${NONPRINTING_END}]*${NONPRINTING_END}`, 'g')

/** The prompt with its non-printing markers removed, ready to be written. */
export function stripMarkers(prompt: string): string {
  return prompt.split(NONPRINTING_START).join('').split(NONPRINTING_END).join('')
}

/**
 * How many columns a prompt occupies: ANSI color/cursor sequences and anything inside a
 * `\x01`...`\x02` pair take none. Uses code points, so an emoji counts once; a wide character still
 * counts as one column, the same as the rest of the editor's arithmetic.
 */
export function visibleWidth(prompt: string): number {
  const printable = prompt.replace(NONPRINTING, '').replace(CSI, '')
  return [...stripMarkers(printable)].length
}

const isWordChar = (char: string | undefined) => !!char && !/\s/.test(char)

export class LineEditor {
  private _text = ''
  private _cursor = 0
  private _killRing: string[] = []
  /** Whether the previous operation was a kill, so the next one extends it instead of starting a new one. */
  private _lastWasKill = false

  constructor(private readonly host: LineEditorHost) {}

  get text() { return this._text }
  get cursor() { return this._cursor }
  get length() { return this._text.length }
  get killRing(): readonly string[] { return this._killRing }

  /**
   * Sets the model without touching the screen. For a caller that has just drawn the line itself
   * (history recall, completion) and only needs the editor to agree about what is there.
   */
  set(text: string, cursor: number = text.length) {
    this._text = text
    this._cursor = Math.max(0, Math.min(cursor, text.length))
    this._lastWasKill = false
  }

  /** Forgets the line without drawing anything. */
  reset() {
    this.set('')
  }

  // - geometry -----------------------------------------------------------------------------------

  private cell(offset: number) {
    const cols = Math.max(1, this.host.cols)
    const at = this.host.promptWidth() + offset
    return { row: Math.floor(at / cols), col: at % cols }
  }

  /** Moves the physical cursor from line offset `from` to offset `to`. */
  private move(from: number, to: number) {
    if (from === to) return
    const a = this.cell(from)
    const b = this.cell(to)
    const rows = b.row - a.row
    if (rows > 0) this.host.write(`\x1b[${rows}B`)
    else if (rows < 0) this.host.write(`\x1b[${-rows}A`)
    this.host.write(`\x1b[${b.col + 1}G`)
  }

  /**
   * Repaints from line offset `from`, assuming the physical cursor is there: clears to the end of the
   * screen, writes the tail, forces the wrap if the tail ended exactly on the last column, then
   * returns the cursor to where the model says it is.
   */
  private repaint(from: number) {
    const tail = this._text.slice(from)
    this.host.write('\x1b[J')
    if (tail) this.host.write(tail)
    const end = this.cell(this._text.length)
    if (this._text.length > 0 && end.col === 0 && end.row > 0) this.host.write(' \r')
    this.move(this._text.length, this._cursor)
  }

  // - editing ------------------------------------------------------------------------------------

  /** Inserts text at the cursor. */
  insert(text: string) {
    if (!text) return
    this._lastWasKill = false
    const atEnd = this._cursor === this._text.length
    this._text = this._text.slice(0, this._cursor) + text + this._text.slice(this._cursor)
    const from = this._cursor
    this._cursor += text.length
    if (atEnd) {
      this.host.write(text)
      const end = this.cell(this._text.length)
      if (end.col === 0 && end.row > 0) this.host.write(' \r')
      return
    }
    this.repaint(from)
  }

  /** Deletes the character before the cursor. Returns false (and rings the bell) at the start. */
  backspace(): boolean {
    this._lastWasKill = false
    if (this._cursor === 0) { this.host.write('\x07'); return false }
    const old = this._cursor
    this._cursor--
    this._text = this._text.slice(0, this._cursor) + this._text.slice(old)
    this.move(old, this._cursor)
    this.repaint(this._cursor)
    return true
  }

  /** Deletes the character under the cursor. */
  deleteForward(): boolean {
    this._lastWasKill = false
    if (this._cursor >= this._text.length) return false
    this._text = this._text.slice(0, this._cursor) + this._text.slice(this._cursor + 1)
    this.repaint(this._cursor)
    return true
  }

  // - motion -------------------------------------------------------------------------------------

  private goto(target: number) {
    this._lastWasKill = false
    if (target === this._cursor) return
    const from = this._cursor
    this._cursor = target
    this.move(from, target)
  }

  left() { if (this._cursor > 0) this.goto(this._cursor - 1) }
  right() { if (this._cursor < this._text.length) this.goto(this._cursor + 1) }
  home() { this.goto(0) }
  end() { this.goto(this._text.length) }
  wordLeft() { this.goto(this.wordStart()) }
  wordRight() { this.goto(this.wordEnd()) }

  /** Start of the word before the cursor: skips whitespace, then the word. */
  private wordStart(): number {
    let target = this._cursor
    while (target > 0 && !isWordChar(this._text[target - 1])) target--
    while (target > 0 && isWordChar(this._text[target - 1])) target--
    return target
  }

  /** Start of the next word: skips the rest of this one, then the whitespace after it. */
  private wordEnd(): number {
    let target = this._cursor
    while (target < this._text.length && isWordChar(this._text[target])) target++
    while (target < this._text.length && !isWordChar(this._text[target])) target++
    return target
  }

  // - the kill ring ------------------------------------------------------------------------------

  /**
   * Removes `[start, end)` and files it on the kill ring. Consecutive kills accumulate into one entry,
   * so `^W^W^Y` restores both words; `backward` decides which end the new text joins.
   */
  private kill(start: number, end: number, backward: boolean) {
    if (start >= end) return
    const removed = this._text.slice(start, end)
    if (this._lastWasKill && this._killRing.length > 0) {
      const last = this._killRing.length - 1
      this._killRing[last] = backward ? removed + this._killRing[last] : this._killRing[last] + removed
    } else {
      this._killRing.push(removed)
      if (this._killRing.length > 30) this._killRing.shift()
    }

    const old = this._cursor
    this._text = this._text.slice(0, start) + this._text.slice(end)
    this._cursor = start
    this.move(old, start)
    this.repaint(start)
    this._lastWasKill = true
  }

  /** `^W`: the word before the cursor. */
  killWordBackward() { this.kill(this.wordStart(), this._cursor, true) }
  /** `Alt-D`: the word after the cursor. */
  killWordForward() {
    let end = this._cursor
    while (end < this._text.length && !isWordChar(this._text[end])) end++
    while (end < this._text.length && isWordChar(this._text[end])) end++
    this.kill(this._cursor, end, false)
  }
  /** `^U`: everything before the cursor. */
  killToStart() { this.kill(0, this._cursor, true) }
  /** `^K`: everything after the cursor. */
  killToEnd() { this.kill(this._cursor, this._text.length, false) }

  /** `^Y`: inserts the most recent kill. */
  yank() {
    const text = this._killRing[this._killRing.length - 1]
    if (!text) return
    this.insert(text)
    this._lastWasKill = false
  }

  // - whole-line operations ----------------------------------------------------------------------

  /**
   * Erases the line and the prompt in front of it from the screen, leaving the cursor at the start of
   * the block's first row. The block is `ceil(len / cols)` rows, not `floor`: a terminal defers the
   * wrap when text ends on the last column, so the floor count moved one row too far up and the erase
   * wiped what was printed above the prompt.
   */
  eraseBlock() {
    const cols = Math.max(1, this.host.cols)
    const rows = Math.max(0, Math.ceil((this.host.promptWidth() + this._cursor) / cols) - 1)
    if (rows > 0) this.host.write(`\x1b[${rows}A`)
    this.host.write('\r\x1b[J')
  }

  /**
   * Replaces the line: erases the block, writes `render(text)` (which supplies the prompt and any
   * coloring) and puts the model at the end. This is what history recall and completion do.
   */
  replace(text: string, render: (text: string) => string) {
    this.eraseBlock()
    this.set(text)
    this.host.write(render(text))
  }

  /** Clears the line off the screen and returns what it held. */
  clear(): string {
    const text = this._text
    this.reset()
    this.host.write('\r\x1b[2K')
    return text
  }
}

/**
 * `^R`: incremental search backward through history.
 *
 * A separate small machine from {@link LineEditor} because while it is active the prompt line shows
 * `(reverse-i-search)`query': match` rather than the edit buffer; accepting it hands the match back as
 * the buffer, cancelling restores what was there. Pure state and no I/O, so the caller decides how to
 * draw it.
 */
export class ReverseSearch {
  private _query = ''
  private _from: number
  private _found = -1

  /** @param entries oldest first, as `History` stores them */
  constructor(private readonly entries: readonly string[], private readonly original: string) {
    this._from = entries.length - 1
    this.find()
  }

  get query() { return this._query }
  get match(): string | undefined { return this._found >= 0 ? this.entries[this._found] : undefined }
  get failed() { return this._query.length > 0 && this._found < 0 }
  /** The buffer to restore on cancel. */
  get originalText() { return this.original }

  private find() {
    if (!this._query) { this._found = -1; return }
    for (let i = Math.min(this._from, this.entries.length - 1); i >= 0; i--) {
      if (this.entries[i]?.includes(this._query)) { this._found = i; return }
    }
    this._found = -1
  }

  /** Adds a character to the query and re-searches from the current match. */
  type(char: string) {
    this._query += char
    if (this._found >= 0) this._from = this._found
    this.find()
  }

  /** Removes the last character of the query. */
  backspace() {
    this._query = this._query.slice(0, -1)
    this._from = this.entries.length - 1
    this.find()
  }

  /** `^R` again: the next older match. */
  next() {
    if (this._found <= 0) return
    const current = this._found
    this._from = current - 1
    this.find()
    // Nothing older: stay on the match we had rather than dropping to "failed", as readline does.
    if (this._found < 0) this._found = current
  }

  /** What the prompt line should read. */
  render(): string {
    return `(${this.failed ? 'failed ' : ''}reverse-i-search)\`${this._query}': ${this.match ?? ''}`
  }
}
