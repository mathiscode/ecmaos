import { writeSync } from 'node:fs'
import { attach_xterm } from '@zenfs/linux'

import type { Kernel } from '@ecmaos/kernel/kernel'

type KeyEventInit = { key: string; domEvent: unknown }

const domEvent = (key: string, ctrl = false) => ({
  key, ctrlKey: ctrl, altKey: false, metaKey: false, shiftKey: false,
  preventDefault() {}, stopPropagation() {}
})

/** One typed character as the `{ key, domEvent }` pair the terminal's line editor takes. */
function keyEvent(ch: string): KeyEventInit {
  const code = ch.charCodeAt(0)
  if (ch === '\r' || ch === '\n') return { key: '\r', domEvent: domEvent('Enter') }
  if (ch === '\x7f') return { key: '\b', domEvent: domEvent('Backspace') }
  if (code < 32) return { key: ch, domEvent: domEvent(String.fromCharCode(code + 96), true) }
  return { key: ch, domEvent: domEvent(ch) }
}

/**
 * Connects the kernel's terminal to this process's stdin and stdout. Minimal: it feeds raw characters to the line
 * editor and does not yet parse escape sequences (arrows, Home/End, Tab), handle resize or bracketed paste.
 */
export function attachStdio(kernel: Kernel, io: { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream }) {
  // Not typed on the public interface: the Node host reaches into the xterm-based Terminal on purpose
  const term = kernel.terminal as unknown as {
    write(data: string | Uint8Array, callback?: () => void): void
    input(data: string, wasUserInput?: boolean): void
    keyHandler(event: KeyEventInit): unknown
    resize(cols: number, rows: number): void
    prompt(): string
    _zfsTty?: unknown
  }

  const xtermWrite = term.write.bind(term)
  term.write = (data, callback) => {
    writeSync(1, Buffer.from(data))
    return xtermWrite(data, callback)
  }

  // What `Terminal.mount()` does in a browser: without it a program's writes to its tty fail with ENXIO
  term._zfsTty = attach_xterm(term as never, { index: 0, input: false })
  if (io.stdout.columns) term.resize(io.stdout.columns, io.stdout.rows)
  if (io.stdin.isTTY) io.stdin.setRawMode(true)

  io.stdin.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    // The line discipline (running programs) is fed from `onData`; the line editor from `keyHandler`.
    term.input(text, true)
    // Not awaited: keys must not queue behind a running command, or ^C would wait for it.
    for (const ch of text) void term.keyHandler(keyEvent(ch))
  })

  term.write(term.prompt())
}
