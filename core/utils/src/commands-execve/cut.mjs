/**
 * Real `execve`'d `cut` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/cut.ts`) per `feat/1.0.0-execve-commands`. See `head.mjs`'s doc comment
 * for why there's no in-band interrupt handling and no `/dev`-path special case anymore.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, read, getcwd, open, close, stat, O_RDONLY } = globalThis.ecmaosSyscalls

const usage = `Usage: cut OPTION... [FILE]...
Remove sections from each line of files.

  -f, --fields=LIST       select only these fields
  -d, --delimiter=DELIM   use DELIM instead of TAB for field delimiter
  -c, --characters=LIST    select only these characters
  --help                  display this help and exit`

function readAllStdin() {
  const chunkSize = 65536
  const chunks = []
  while (true) {
    const buffer = new Uint8Array(chunkSize)
    const n = read(0, buffer, -1)
    if (n <= 0) break
    chunks.push(buffer.subarray(0, n))
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

function parseRange(range) {
  const result = []
  const parts = range.split(',')
  for (const part of parts) {
    if (part.includes('-')) {
      const [start, end] = part.split('-')
      const startNum = (start === '' || start === undefined) ? 1 : parseInt(start, 10)
      const endNum = (end === '' || end === undefined) ? Infinity : parseInt(end, 10)
      for (let i = startNum; i <= endNum; i++) result.push(i)
    } else {
      result.push(parseInt(part, 10))
    }
  }
  return result.sort((a, b) => a - b)
}

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    writeAll(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  let fields
  let delimiter = '\t'
  let characters
  const files = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-f' || arg.startsWith('-f')) {
      if (arg === '-f' && i + 1 < args.length) { i++; fields = args[i] }
      else if (arg.startsWith('-f') && arg.length > 2) fields = arg.slice(2)
      else if (arg.startsWith('--fields=')) fields = arg.slice(9)
    } else if (arg === '-c' || arg.startsWith('-c')) {
      if (arg === '-c' && i + 1 < args.length) { i++; characters = args[i] }
      else if (arg.startsWith('-c') && arg.length > 2) characters = arg.slice(2)
      else if (arg.startsWith('--characters=')) characters = arg.slice(13)
    } else if (arg === '-d' || arg.startsWith('-d')) {
      if (arg === '-d' && i + 1 < args.length) { i++; delimiter = args[i] }
      else if (arg.startsWith('-d') && arg.length > 2) delimiter = arg.slice(2)
      else if (arg.startsWith('--delimiter=')) delimiter = arg.slice(12)
    } else if (!arg.startsWith('-')) {
      files.push(arg)
    }
  }

  if (!fields && !characters) {
    writeAll(2, new TextEncoder().encode('cut: you must specify a list of bytes, characters, or fields\n'))
    return 1
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
        writeAll(2, new TextEncoder().encode(`cut: ${file}: ${message}\n`))
        hasError = true
      }
    }
  }

  let output = ''
  for (const line of lines) {
    if (characters) {
      const indices = parseRange(characters)
      const chars = line.split('')
      output += indices.map(i => chars[i - 1] || '').join('') + '\n'
    } else if (fields) {
      const indices = parseRange(fields)
      const parts = line.split(delimiter)
      output += indices.map(i => (parts[i - 1] || '')).join(delimiter) + '\n'
    }
  }
  writeAll(1, new TextEncoder().encode(output))

  return hasError ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`cut: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
