/**
 * Real `execve`'d `history` -- migrated off `Kernel`'s legacy in-process `Process`
 * (`core/utils/src/commands/history.ts`). Listing, `N`, and `-d` (delete one entry) are plain reads/
 * writes of `~/.history`, no kernel state involved -- but `-c`/`-r` mutate/re-read the live, in-memory
 * history buffer a real `Terminal` keeps for its own up-arrow recall, which only the main thread can
 * reach. Those two go through the new `terminal_clear_history`/`terminal_reload_history` custom
 * syscalls (`#lib/main-thread-syscalls.ts`); `-d` also calls `terminal_reload_history` afterward, same
 * as the legacy command, so the terminal's in-memory buffer doesn't drift from the file it just
 * rewrote.
 */

import { join } from './lib/path-utils.mjs'

const { argv, exit, write, custom, stat, open, read, writeAll, close, O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC } = globalThis.ecmaosSyscalls

const usage = `Usage: history [OPTION]... [N]
Display or manipulate the command history.

  N              display the last N entries
  -c             clear the history list
  -d N           delete the history entry at position N
  -r             reload the history file (useful after manual edits)
  --help         display this help and exit

If N is provided without options, display the last N entries.
If no arguments are provided, display all history entries.

Note: History is automatically saved on each command execution.`

function writeStdout(text) { write(1, new TextEncoder().encode(text)) }
function writeStderr(text) { write(2, new TextEncoder().encode(text + '\n')) }

function exists(path) {
  try { stat(path); return true } catch { return false }
}

function readFile(path) {
  const fd = open(path, O_RDONLY)
  const chunkSize = 65536
  const chunks = []
  try {
    while (true) {
      const buffer = new Uint8Array(chunkSize)
      const n = read(fd, buffer, -1)
      if (n <= 0) break
      chunks.push(buffer.subarray(0, n))
      if (n < chunkSize) break
    }
  } finally {
    close(fd)
  }
  return new TextDecoder().decode(new Uint8Array(chunks.flatMap(c => [...c])))
}

function writeFile(path, content) {
  const fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
  try {
    writeAll(fd, new TextEncoder().encode(content))
  } finally {
    close(fd)
  }
}

function historyPath() {
  const home = globalThis.ecmaosSyscalls.env['HOME'] || '/root'
  return join(home, '.history')
}

function readHistoryLines() {
  const path = historyPath()
  if (!exists(path)) return []
  return readFile(path).split('\n').filter(line => line.length > 0)
}

async function main() {
  const args = argv.slice(1)

  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    writeStderr(usage)
    return 0
  }

  let clearHistory = false
  let deleteIndex = null
  let readHistory = false
  let numEntries = null

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue

    if (arg === '-c') {
      clearHistory = true
    } else if (arg === '-r') {
      readHistory = true
    } else if (arg === '-d') {
      if (i + 1 < args.length) {
        i++
        const nextArg = args[i]
        const index = parseInt(nextArg, 10)
        if (Number.isNaN(index)) {
          writeStderr(`history: invalid history number '${nextArg}'`)
          return 1
        }
        deleteIndex = index
      } else {
        writeStderr('history: -d requires a history number')
        return 1
      }
    } else if (!arg.startsWith('-')) {
      const num = parseInt(arg, 10)
      if (!Number.isNaN(num)) numEntries = num
    }
  }

  if (clearHistory) {
    await custom('terminal_clear_history')
    return 0
  }

  if (deleteIndex !== null) {
    const lines = readHistoryLines()
    if (deleteIndex < 1 || deleteIndex > lines.length) {
      writeStderr(`history: history number '${deleteIndex}' out of range`)
      return 1
    }
    const newLines = lines.filter((_, index) => index !== deleteIndex - 1)
    writeFile(historyPath(), newLines.join('\n'))
    await custom('terminal_reload_history').catch(() => {})
    return 0
  }

  if (readHistory) {
    await custom('terminal_reload_history').catch(() => {})
    return 0
  }

  const lines = readHistoryLines()
  if (lines.length === 0) return 0

  const displayLines = numEntries !== null ? lines.slice(-numEntries) : lines
  const startIndex = numEntries !== null ? lines.length - numEntries + 1 : 1

  let output = ''
  for (let i = 0; i < displayLines.length; i++) {
    output += `  ${startIndex + i}  ${displayLines[i]}\n`
  }
  writeStdout(output)

  return 0
}

try {
  exit(await main())
} catch (error) {
  writeStderr(`history: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
