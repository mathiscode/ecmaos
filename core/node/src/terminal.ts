import { writeSync } from 'node:fs'
import { attach_xterm } from '@zenfs/linux'

import type { Kernel } from '@ecmaos/kernel/kernel'

import { TerminalDriver } from './driver.ts'
import type { DrivenTerminal } from './driver.ts'

/**
 * Gives the kernel's terminal its `@zenfs/linux` TTY, as `Terminal.mount()` does in a browser. Boot needs it: a program that
 * init starts writes to its tty, and with none that write waits for ever, so the boot would sit out its whole timeout.
 */
export function attachTty(kernel: Kernel) {
  const term = kernel.terminal as unknown as { _zfsTty?: unknown }
  if (!term._zfsTty) term._zfsTty = attach_xterm(term as never, { index: 0, input: false })
}

/**
 * Connects the kernel's terminal to this process's stdin and stdout.
 *
 * On a TTY the terminal is put in raw mode and what you type is parsed into keys; the window size follows `SIGWINCH`.
 * Piped input has no such framing: it is fed one key at a time, each waiting for the last, so a script's lines run in order.
 */
export function attachStdio(kernel: Kernel, io: { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream }) {
  const term = kernel.terminal as unknown as DrivenTerminal & { _zfsTty?: unknown }

  const interactive = !!io.stdin.isTTY
  const xtermWrite = term.write.bind(term)
  term.write = (data, callback) => {
    writeSync(1, Buffer.from(data))
    return xtermWrite(data, callback)
  }

  // Without a TTY a program's writes to it fail with ENXIO
  attachTty(kernel)

  const driver = new TerminalDriver(term, interactive)

  if (interactive) {
    io.stdin.setRawMode(true)
    // Bracketed paste: a paste arrives wrapped in markers, so it is inserted as text and not run as typed keys
    io.stdout.write('\x1b[?2004h')
    process.on('exit', () => {
      try { io.stdin.setRawMode(false); writeSync(1, '\x1b[?2004l') } catch { /* the terminal is already gone */ }
    })
  }

  const resize = () => { if (io.stdout.columns && io.stdout.rows) driver.resize(io.stdout.columns, io.stdout.rows) }
  resize()
  io.stdout.on('resize', resize)

  const onData = (chunk: Buffer) => driver.feed(chunk)
  io.stdin.on('data', onData)

  // The input is gone (a script ran out, or the terminal closed): finish what was typed, then halt, as a shell does
  const onEnd = () => { void driver.idle.then(() => kernel.stop('halt')) }
  io.stdin.on('end', onEnd)

  term.write(term.prompt())

  /** Gives the terminal back: raw mode off, no more listening. The process can then exit, or hand the terminal on. */
  return function detach() {
    driver.dispose()
    io.stdin.off('data', onData)
    io.stdin.off('end', onEnd)
    io.stdout.off('resize', resize)
    if (interactive) { try { io.stdin.setRawMode(false); writeSync(1, '\x1b[?2004l') } catch { /* gone already */ } }
    io.stdin.pause()
    io.stdin.unref?.()
  }
}
