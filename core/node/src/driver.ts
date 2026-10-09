import { StringDecoder } from 'node:string_decoder'

import { InputParser } from './input.ts'
import type { InputToken, KeyInput } from './input.ts'

// How long a lone ESC waits to see whether it starts an arrow key
const EscapeDelay = 40

/** What of the kernel's terminal the driver touches. Not on the public interface: the Node host reaches into the xterm-based Terminal on purpose. */
export interface DrivenTerminal {
  write(data: string | Uint8Array, callback?: () => void): void
  input(data: string, wasUserInput?: boolean): void
  keyHandler(event: KeyInput): Promise<void>
  paste(text: string): Promise<void>
  resize(cols: number, rows: number): void
  prompt(): string
  /** Whether a running program's line discipline owns the keyboard, so the line editor must not see keys */
  readonly ttyInputAttached?: boolean
}

/**
 * Feeds what a terminal sends (bytes) into the kernel's terminal: the line discipline for running programs, and the
 * line editor as parsed keys (arrows, Home/End, Delete, Alt chords, Tab, bracketed paste).
 *
 * `interactive` is a person at a keyboard (a tty). Without it the input is a pipe, with no framing: each key waits for the
 * last, so a script's lines run in order.
 */
export class TerminalDriver {
  private readonly _parser = new InputParser()
  private readonly _decoder = new StringDecoder('utf8')
  private _escapeTimer: ReturnType<typeof setTimeout> | undefined
  private _queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly _term: DrivenTerminal, private readonly _interactive: boolean) {}

  /** Resolves once every key fed so far has been handled */
  get idle(): Promise<unknown> { return this._queue }

  feed(chunk: Uint8Array) {
    const text = this._decoder.write(chunk as Buffer)
    if (!text) return
    clearTimeout(this._escapeTimer)
    // The line discipline (running programs) is fed from `onData`; the line editor from `keyHandler`.
    this._term.input(text, true)
    this._dispatch(this._parser.feed(text))
    if (this._parser.pending) this._escapeTimer = setTimeout(() => this._dispatch(this._parser.flush()), EscapeDelay)
  }

  resize(cols: number, rows: number) {
    if (cols > 0 && rows > 0) this._term.resize(cols, rows)
  }

  dispose() { clearTimeout(this._escapeTimer) }

  private _dispatch(tokens: InputToken[]) {
    const term = this._term
    // Decided now, not when a queued key is finally handled: `input()` has already given these keys to the program's
    // line discipline, and if the program has ended by the time the queue reaches them the line editor would run them
    // too (a password typed to `gateway up` ran again as a command). `keyHandler` ignores a key while a program owns
    // the keyboard, and its check runs before its first await, so calling it at once is what makes that check true.
    const owned = term.ttyInputAttached === true
    for (const token of tokens) {
      if (owned) { if (token.type !== 'paste') void term.keyHandler(token.input); continue }
      if (token.type === 'paste') { this._queue = this._queue.then(() => term.paste(token.text)).catch(() => {}); continue }
      const { input } = token
      const event = input.domEvent
      // Interrupt and suspend act at once, even with a command running: they must not wait behind it.
      if (this._interactive && event.ctrlKey && (event.key === 'c' || event.key === 'z')) { void term.keyHandler(input); continue }
      // Keys are handled in order (a history recall is asynchronous, so an Enter right behind an arrow would
      // otherwise run first), but Enter does not hold up the queue for as long as its command runs.
      const prior = this._queue
      if (this._interactive && event.key === 'Enter') this._queue = prior.then(() => { void term.keyHandler(input) }).catch(() => {})
      else this._queue = prior.then(() => term.keyHandler(input)).catch(() => {})
    }
  }
}
