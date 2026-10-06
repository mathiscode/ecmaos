import { writeSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { attach_xterm } from '@zenfs/linux'

import type { Kernel } from '@ecmaos/kernel/kernel'

import { InputParser } from './input.ts'
import type { InputToken, KeyInput } from './input.ts'

// How long a lone ESC waits to see whether it starts an arrow key
const EscapeDelay = 40

/**
 * Connects the kernel's terminal to this process's stdin and stdout.
 *
 * On a TTY the terminal is put in raw mode and what you type is parsed into keys (arrows, Home/End, Delete, Alt chords,
 * Tab, bracketed paste); the window size follows `SIGWINCH`. Piped input has no such framing: it is fed one key at a
 * time, each waiting for the last, so a script's lines run in order.
 */
export function attachStdio(kernel: Kernel, io: { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream }) {
  // Not typed on the public interface: the Node host reaches into the xterm-based Terminal on purpose
  const term = kernel.terminal as unknown as {
    write(data: string | Uint8Array, callback?: () => void): void
    input(data: string, wasUserInput?: boolean): void
    keyHandler(event: KeyInput): Promise<void>
    paste(text: string): Promise<void>
    resize(cols: number, rows: number): void
    prompt(): string
    _zfsTty?: unknown
  }

  const interactive = !!io.stdin.isTTY
  const xtermWrite = term.write.bind(term)
  term.write = (data, callback) => {
    writeSync(1, Buffer.from(data))
    return xtermWrite(data, callback)
  }

  // What `Terminal.mount()` does in a browser: without it a program's writes to its tty fail with ENXIO
  term._zfsTty = attach_xterm(term as never, { index: 0, input: false })

  const parser = new InputParser()
  const decoder = new StringDecoder('utf8')
  let escapeTimer: ReturnType<typeof setTimeout> | undefined
  let queue: Promise<unknown> = Promise.resolve()

  const dispatch = (tokens: InputToken[]) => {
    for (const token of tokens) {
      if (token.type === 'paste') { queue = queue.then(() => term.paste(token.text)).catch(() => {}); continue }
      const { input } = token
      const event = input.domEvent
      // Interrupt and suspend act at once, even with a command running: they must not wait behind it.
      if (interactive && event.ctrlKey && (event.key === 'c' || event.key === 'z')) { void term.keyHandler(input); continue }
      // Keys are handled in order (a history recall is asynchronous, so an Enter right behind an arrow would
      // otherwise run first), but Enter does not hold up the queue for as long as its command runs.
      const prior = queue
      if (interactive && event.key === 'Enter') queue = prior.then(() => { void term.keyHandler(input) }).catch(() => {})
      else queue = prior.then(() => term.keyHandler(input)).catch(() => {})
    }
  }

  if (interactive) {
    io.stdin.setRawMode(true)
    // Bracketed paste: a paste arrives wrapped in markers, so it is inserted as text and not run as typed keys
    io.stdout.write('\x1b[?2004h')
    process.on('exit', () => {
      try { io.stdin.setRawMode(false); writeSync(1, '\x1b[?2004l') } catch { /* the terminal is already gone */ }
    })
  }

  const resize = () => { if (io.stdout.columns && io.stdout.rows) term.resize(io.stdout.columns, io.stdout.rows) }
  resize()
  io.stdout.on('resize', resize)

  io.stdin.on('data', (chunk: Buffer) => {
    const text = decoder.write(chunk)
    if (!text) return
    clearTimeout(escapeTimer)
    // The line discipline (running programs) is fed from `onData`; the line editor from `keyHandler`.
    term.input(text, true)
    dispatch(parser.feed(text))
    if (parser.pending) escapeTimer = setTimeout(() => dispatch(parser.flush()), EscapeDelay)
  })

  term.write(term.prompt())
}
