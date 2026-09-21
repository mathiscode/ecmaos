/**
 * Real `execve`'d `less` -- migrated off `Kernel.executeCommand`'s legacy shim
 * (`core/utils/src/commands/less.ts`). The original reached into `terminal.onKey`/`unlisten`; this
 * one is an ordinary program that puts its terminal in raw mode (`lib/tty.mjs`) and `read()`s single
 * keypresses from it, which works because `Kernel.executeViaExecve` routes the keyboard through the
 * real `@zenfs/linux` line discipline while a foreground process runs.
 */

import { resolve } from './lib/path-utils.mjs'
import { decodeKeys, rawMode, terminalSize, ttyFd } from './lib/tty.mjs'

const { argv, exit, read, writeAll, getcwd, open, close, stat, isDirectory, O_RDONLY } = globalThis.ecmaosSyscalls

const usage = `Usage: less [OPTION]... FILE
View file contents interactively.

  FILE    the file to view (if omitted, reads from stdin)
  --help  display this help and exit`

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const err = text => writeAll(2, encoder.encode(text + '\n'))

/** Reads `fd` to EOF: a short read is not EOF (a pipe returns what it has), only `n <= 0` is. */
function readAll(fd) {
  const chunks = []
  const buffer = new Uint8Array(65536)
  while (true) {
    const n = read(fd, buffer, -1)
    if (n <= 0) break
    chunks.push(decoder.decode(buffer.subarray(0, n), { stream: true }))
  }
  chunks.push(decoder.decode())
  return chunks.join('')
}

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

function page(lines, tty) {
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
    frame += '\n\x1b[2K' + visibleSlice(`-- ${currentLine + 1}-${endLine} / ${lines.length} (${percentage}%)`, 0, cols)
    linesRendered++
    out(frame)
  }

  out('\n\x1b[?25l')
  render()

  const buffer = new Uint8Array(64)
  while (true) {
    const n = read(tty, buffer, -1)
    if (n <= 0) return
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
}

function main() {
  const args = argv.slice(1)
  if (args[0] === '--help' || args[0] === '-h') {
    err(usage)
    return 0
  }

  const filePath = args[0] !== undefined && !args[0].startsWith('-') ? args[0] : undefined
  let content

  if (filePath) {
    const fullPath = resolve(getcwd(), filePath)
    try {
      stat(fullPath)
    } catch {
      err(`less: ${filePath}: No such file or directory`)
      return 1
    }
    if (isDirectory(fullPath)) {
      err(`less: ${filePath}: Is a directory`)
      return 1
    }
    const fd = open(fullPath, O_RDONLY)
    try {
      content = readAll(fd)
    } finally {
      close(fd)
    }
  } else {
    if (ttyFd() === 0) {
      err('less: Missing filename ("less --help" for help)')
      return 1
    }
    content = readAll(0)
  }

  const lines = content.split('\n')
  const tty = ttyFd()

  // No terminal to page on (`less f > out`, or a test harness): behave like `cat`, as real less does.
  if (tty === -1) {
    writeAll(1, encoder.encode(content))
    return 0
  }

  // `cat f | less`: stdin is the data pipe, so keys must come from the terminal fd, not fd 0.
  const restore = rawMode(tty)
  try {
    page(lines, tty)
  } finally {
    writeAll(tty, encoder.encode('\x1b[?25h\n'))
    restore()
  }
  return 0
}

try {
  exit(main())
} catch (error) {
  err(`less: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
