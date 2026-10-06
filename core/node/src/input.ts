/* eslint-disable no-control-regex -- parsing terminal escape sequences */
/** What the terminal's line editor takes: the typed text and the DOM-shaped event describing the key. */
export interface KeyInput {
  key: string
  domEvent: {
    key: string
    ctrlKey: boolean
    altKey: boolean
    metaKey: boolean
    shiftKey: boolean
    preventDefault(): void
    stopPropagation(): void
  }
}

export type InputToken =
  | { type: 'key', input: KeyInput }
  | { type: 'paste', text: string }

const PasteStart = '\x1b[200~'
const PasteEnd = '\x1b[201~'

type Modifiers = { ctrl?: boolean, alt?: boolean, shift?: boolean, meta?: boolean }

function key(name: string, text: string, mods: Modifiers = {}): InputToken {
  return {
    type: 'key',
    input: {
      key: text,
      domEvent: {
        key: name,
        ctrlKey: !!mods.ctrl, altKey: !!mods.alt, metaKey: !!mods.meta, shiftKey: !!mods.shift,
        preventDefault() {}, stopPropagation() {}
      }
    }
  }
}

// `ESC [ n ~` and `ESC [ <letter>` names. Home and End have several spellings between terminals.
const Tilde: Record<number, string> = { 1: 'Home', 2: 'Insert', 3: 'Delete', 4: 'End', 5: 'PageUp', 6: 'PageDown', 7: 'Home', 8: 'End' }
const Final: Record<string, string> = { A: 'ArrowUp', B: 'ArrowDown', C: 'ArrowRight', D: 'ArrowLeft', H: 'Home', F: 'End', Z: 'Tab' }

/** xterm's modifier parameter: 1 + shift(1) + alt(2) + ctrl(4) + meta(8) */
function modifiers(param: number): Modifiers {
  const bits = Math.max(param, 1) - 1
  return { shift: !!(bits & 1), alt: !!(bits & 2), ctrl: !!(bits & 4), meta: !!(bits & 8) }
}

/** The key a single character stands for */
function character(ch: string): InputToken {
  const code = ch.codePointAt(0)!
  if (ch === '\r' || ch === '\n') return key('Enter', '\r')
  if (ch === '\t') return key('Tab', '\t')
  if (ch === '\x7f' || ch === '\b') return key('Backspace', '\b')
  if (code < 32) return key(String.fromCharCode(code + 96), ch, { ctrl: true })
  return key(ch, ch)
}

/**
 * Turns the bytes a terminal sends into keys, as xterm.js's `onKey` would deliver them. It holds on to a partial
 * escape sequence between `feed` calls, and a lone ESC is only reported by `flush` (call it after a short delay), since
 * `ESC` and the start of an arrow key are the same byte.
 */
export class InputParser {
  private _buffer = ''
  private _paste?: string

  /** Whether an incomplete sequence is waiting for more input */
  get pending() { return this._buffer.length > 0 }

  feed(text: string): InputToken[] {
    this._buffer += text
    const tokens: InputToken[] = []

    while (this._buffer.length > 0) {
      if (this._paste !== undefined) {
        const end = this._buffer.indexOf(PasteEnd)
        if (end === -1) {
          // Keep a possible partial end marker; take the rest as pasted text
          const keep = this.partial(this._buffer, PasteEnd)
          this._paste += this._buffer.slice(0, this._buffer.length - keep)
          this._buffer = this._buffer.slice(this._buffer.length - keep)
          break
        }
        tokens.push({ type: 'paste', text: this._paste + this._buffer.slice(0, end) })
        this._paste = undefined
        this._buffer = this._buffer.slice(end + PasteEnd.length)
        continue
      }

      if (this._buffer.startsWith(PasteStart)) {
        this._paste = ''
        this._buffer = this._buffer.slice(PasteStart.length)
        continue
      }

      if (this._buffer[0] === '\x1b') {
        const parsed = this.escape(this._buffer)
        if (parsed === 'incomplete') break
        tokens.push(...parsed.tokens)
        this._buffer = this._buffer.slice(parsed.length)
        continue
      }

      const ch = String.fromCodePoint(this._buffer.codePointAt(0)!)
      tokens.push(character(ch))
      this._buffer = this._buffer.slice(ch.length)
    }

    return tokens
  }

  /** Reports a held-back ESC as the Escape key, and drops anything else half-received */
  flush(): InputToken[] {
    if (this._paste !== undefined) return []
    const pending = this._buffer
    this._buffer = ''
    if (pending === '\x1b') return [key('Escape', '\x1b')]
    // `ESC` then a partial sequence: treat the ESC as Escape, the rest as typed text
    if (pending.startsWith('\x1b')) return [key('Escape', '\x1b'), ...this.feed(pending.slice(1))]
    return []
  }

  /** How many trailing characters of `text` are a prefix of `marker` */
  private partial(text: string, marker: string) {
    for (let length = Math.min(marker.length - 1, text.length); length > 0; length--) {
      if (text.endsWith(marker.slice(0, length))) return length
    }
    return 0
  }

  private escape(buffer: string): 'incomplete' | { tokens: InputToken[], length: number } {
    if (buffer.length === 1) return 'incomplete'
    if (PasteStart.startsWith(buffer) && buffer.length < PasteStart.length) return 'incomplete'

    const next = buffer[1]!

    // CSI: ESC [ params final
    if (next === '[') {
      const match = /^\x1b\[([0-9;]*)([\x40-\x7e])/.exec(buffer)
      if (!match) return /^\x1b\[[0-9;?<=>]*$/.test(buffer) ? 'incomplete' : { tokens: [key('[', '[', { alt: true })], length: 2 }
      const [whole, params, final] = match as unknown as [string, string, string]
      const numbers = params.split(';').map(part => part === '' ? 0 : Number(part))
      const mods = modifiers(numbers[1] ?? 0)
      let name: string | undefined
      if (final === '~') name = Tilde[numbers[0] ?? 0]
      else name = Final[final]
      if (!name) return { tokens: [], length: whole.length } // a sequence we do not use: drop it whole
      if (final === 'Z') return { tokens: [key('Tab', '\t', { shift: true })], length: whole.length }
      return { tokens: [key(name, '', mods)], length: whole.length }
    }

    // SS3: ESC O final (application cursor keys)
    if (next === 'O') {
      if (buffer.length === 2) return 'incomplete'
      const name = Final[buffer[2]!]
      return { tokens: name ? [key(name, '')] : [], length: 3 }
    }

    // Meta-as-escape: ESC then a key is that key with Alt held
    const ch = String.fromCodePoint(buffer.codePointAt(1)!)
    const token = character(ch)
    if (token.type === 'key') token.input.domEvent.altKey = true
    return { tokens: [token], length: 1 + ch.length }
  }
}
