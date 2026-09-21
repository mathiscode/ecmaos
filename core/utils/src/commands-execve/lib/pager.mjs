/**
 * The interactive pager shared by `less` and `man`: renders `lines` a screen at a time on the
 * terminal `tty` fd, in raw mode, and scrolls on keys read from that same fd. Redraws when the
 * window is resized (`SIGWINCH`). See `less.mjs` for why it works from a plain worker.
 */

import { decodeKeys, rawMode, terminalSize, watchResize } from './tty.mjs'

const { read, writeAll } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()

const stripAnsi = text => text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')

/** `line` from visible column `offset`, at most `cols` visible characters, keeping its escape codes. */
function visibleSlice(line, offset, cols) {
  const visibleLength = stripAnsi(line).length
  offset = Math.min(Math.max(offset, 0), visibleLength)

  let visible = 0
  let skipped = 0
  let inEscape = false
  let result = ''

  for (const char of line) {
    if (char === '\x1b') inEscape = true
    if (inEscape) {
      if (skipped >= offset) result += char
      if (/[a-zA-Z]/.test(char)) inEscape = false
    } else if (skipped < offset) {
      skipped++
    } else {
      if (visible >= cols) break
      result += char
      visible++
    }
  }
  return result
}

function pageLines(lines, tty, label) {
  const out = text => writeAll(tty, encoder.encode(text))
  let currentLine = 0
  let horizontalOffset = 0
  let linesRendered = 0

  const size = () => {
    const { rows, cols } = terminalSize(tty)
    return { cols, displayRows: rows - 1 }
  }

  const render = () => {
    const { cols, displayRows } = size()

    currentLine = Math.max(0, Math.min(currentLine, Math.max(0, lines.length - displayRows)))
    const maxLineLength = Math.max(...lines.map(line => stripAnsi(line).length), 0)
    horizontalOffset = Math.max(0, Math.min(horizontalOffset, Math.max(0, maxLineLength - cols)))

    let frame = ''
    if (linesRendered > 0) frame += `\x1b[${linesRendered}A\r`

    const endLine = Math.min(currentLine + displayRows, lines.length)
    linesRendered = 0

    for (let i = currentLine; i < endLine; i++) {
      frame += '\x1b[2K' + visibleSlice(lines[i] || '', horizontalOffset, cols)
      linesRendered++
      if (i < endLine - 1) frame += '\n'
    }
    for (let i = endLine - currentLine; i < displayRows; i++) {
      frame += '\n\x1b[2K'
      linesRendered++
    }

    const percentage = lines.length > 0 ? Math.round((endLine / lines.length) * 100) : 100
    frame += '\n\x1b[2K' + visibleSlice(`-- ${label ? label + ' ' : ''}${currentLine + 1}-${endLine} / ${lines.length} (${percentage}%)`, 0, cols)
    linesRendered++
    out(frame)
  }

  out('\n\x1b[?25l')
  render()

  // A resize interrupts the blocking read (`EINTR`); redraw at the new size and keep waiting.
  const input = watchResize()
  try {
    const buffer = new Uint8Array(64)
    while (true) {
      const n = input.read(tty, buffer)
      if (n < 0) {
        render()
        continue
      }
      if (n === 0) return
      for (const key of decodeKeys(buffer.subarray(0, n))) {
        const { cols, displayRows } = size()
        const bottom = Math.max(0, lines.length - displayRows)
        switch (key) {
          case 'q': case 'Q': case 'Escape':
            return
          case 'ArrowUp':
            currentLine--
            break
          case 'ArrowDown': case 'Enter':
            currentLine++
            break
          case 'ArrowLeft':
            horizontalOffset -= Math.floor(cols / 2)
            break
          case 'ArrowRight':
            horizontalOffset += Math.floor(cols / 2)
            break
          case 'PageDown': case ' ':
            currentLine = Math.min(currentLine + displayRows, bottom)
            break
          case 'PageUp': case 'b': case 'B':
            currentLine = Math.max(0, currentLine - displayRows)
            break
          case 'Home': case 'g':
            currentLine = 0
            break
          case 'End': case 'G':
            currentLine = bottom
            break
          default:
            continue
        }
        render()
      }
    }
  } finally {
    input.stop()
  }
}

/**
 * Pages `lines` on `tty` until the user quits. `label` (a document name) is shown in the status
 * line. Puts the terminal in raw mode for the session and restores it, and the cursor, however it ends.
 */
export function page(lines, tty, label = '') {
  const restore = rawMode(tty)
  try {
    pageLines(lines, tty, label)
  } finally {
    writeAll(tty, encoder.encode('\x1b[?25h\n'))
    restore()
  }
}
