/**
 * Real `execve`'d `nl` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/nl.ts`) per `feat/1.0.0-execve-commands`. See `head.mjs`'s doc comment
 * for why there's no in-band interrupt handling and no `/dev`-path special case anymore.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, write, read, getcwd, open, close, stat, O_RDONLY } = globalThis.ecmaosSyscalls

const usage = `Usage: nl [OPTION]... [FILE]...
Number lines of files.

  -v, --starting-line=NUMBER  first line number for each section (default: 1)
  -i, --increment=NUMBER      line number increment at each line (default: 1)
  -n, --format=FORMAT         line number format: ln, rn, rz (default: rn)
  -w, --width=NUMBER          use NUMBER columns for line numbers (default: 6)
  -s, --separator=STRING      add STRING after (possible) line number (default: TAB)
  --help                      display this help and exit`

function readAllStdin() {
  const chunkSize = 65536
  const chunks = []
  while (true) {
    const buffer = new Uint8Array(chunkSize)
    const n = read(0, buffer, -1)
    if (n <= 0) break
    chunks.push(buffer.subarray(0, n))
    if (n < chunkSize) break
  }
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(bytes)
}

function readWholeFileText(fullPath) {
  const size = stat(fullPath).size
  const fd = open(fullPath, O_RDONLY)
  const bytes = new Uint8Array(size)
  try {
    let bytesRead = 0
    while (bytesRead < size) {
      const chunk = new Uint8Array(size - bytesRead)
      const n = read(fd, chunk, -1)
      if (n <= 0) break
      bytes.set(chunk.subarray(0, n), bytesRead)
      bytesRead += n
    }
  } finally {
    close(fd)
  }
  return new TextDecoder().decode(bytes)
}

function splitLines(text) {
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    write(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  const files = []
  let startLine = 1
  let increment = 1
  let format = 'rn'
  let width = 6
  let separator = '\t'

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-v' || arg === '--starting-line') {
      if (i + 1 < args.length) { const num = parseInt(args[++i], 10); if (!isNaN(num)) startLine = num }
    } else if (arg.startsWith('--starting-line=')) {
      const num = parseInt(arg.slice(16), 10)
      if (!isNaN(num)) startLine = num
    } else if (arg === '-i' || arg === '--increment') {
      if (i + 1 < args.length) { const num = parseInt(args[++i], 10); if (!isNaN(num)) increment = num }
    } else if (arg.startsWith('--increment=')) {
      const num = parseInt(arg.slice(12), 10)
      if (!isNaN(num)) increment = num
    } else if (arg === '-n' || arg === '--format') {
      if (i + 1 < args.length) format = args[++i] || 'rn'
    } else if (arg.startsWith('--format=')) {
      format = arg.slice(9) || 'rn'
    } else if (arg === '-w' || arg === '--width') {
      if (i + 1 < args.length) { const num = parseInt(args[++i], 10); if (!isNaN(num)) width = num }
    } else if (arg.startsWith('--width=')) {
      const num = parseInt(arg.slice(8), 10)
      if (!isNaN(num)) width = num
    } else if (arg === '-s' || arg === '--separator') {
      if (i + 1 < args.length) separator = args[++i] || '\t'
    } else if (arg.startsWith('--separator=')) {
      separator = arg.slice(12) || '\t'
    } else if (!arg.startsWith('-')) {
      files.push(arg)
    }
  }

  const formatNumber = (num) => {
    const numStr = num.toString()
    if (format === 'rz') return numStr.padStart(width, '0')
    if (format === 'ln') return numStr.padEnd(width, ' ')
    return numStr.padStart(width, ' ')
  }

  let lines = []
  let hasError = false

  if (files.length === 0) {
    lines = splitLines(readAllStdin())
  } else {
    const cwd = getcwd()
    for (const file of files) {
      const fullPath = resolve(cwd, file)
      try {
        lines.push(...splitLines(readWholeFileText(fullPath)))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        write(2, new TextEncoder().encode(`nl: ${file}: ${message}\n`))
        hasError = true
      }
    }
  }

  let lineNumber = startLine
  let output = ''
  for (const line of lines) {
    output += `${formatNumber(lineNumber)}${separator}${line}\n`
    lineNumber += increment
  }
  write(1, new TextEncoder().encode(output))

  return hasError ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  write(2, new TextEncoder().encode(`nl: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
