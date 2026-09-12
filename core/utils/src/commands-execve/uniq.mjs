/**
 * Real `execve`'d `uniq` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/uniq.ts`) per `feat/1.0.0-execve-commands`. See `head.mjs`'s doc comment
 * for why there's no in-band interrupt handling and no `/dev`-path special case anymore.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, write, read, getcwd, open, close, stat, O_RDONLY } = globalThis.ecmaosSyscalls

const usage = `Usage: uniq [OPTION]... [INPUT [OUTPUT]]
Report or omit repeated lines.

  -c, --count     prefix lines by the number of occurrences
  -d, --repeated  only print duplicate lines
  -u, --unique    only print unique lines
  --help          display this help and exit`

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
  let count = false
  let repeated = false
  let unique = false

  for (const arg of args) {
    if (arg === '-c' || arg === '--count') count = true
    else if (arg === '-d' || arg === '--repeated') repeated = true
    else if (arg === '-u' || arg === '--unique') unique = true
    else if (arg.startsWith('-')) {
      const flags = arg.slice(1).split('')
      if (flags.includes('c')) count = true
      if (flags.includes('d')) repeated = true
      if (flags.includes('u')) unique = true
      const invalid = flags.find(f => !['c', 'd', 'u'].includes(f))
      if (invalid) {
        write(2, new TextEncoder().encode(`uniq: invalid option -- '${invalid}'\n`))
        return 1
      }
    } else {
      files.push(arg)
    }
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
        write(2, new TextEncoder().encode(`uniq: ${file}: ${message}\n`))
        hasError = true
      }
    }
  }

  if (lines.length === 0) return hasError ? 1 : 0

  let output = ''
  let prevLine = null
  let countValue = 1

  const emit = (line, cnt) => {
    if (repeated && cnt === 1) return
    if (unique && cnt > 1) return
    output += (count ? `${cnt.toString().padStart(7)} ${line}` : line) + '\n'
  }

  for (const line of lines) {
    if (prevLine === null) {
      prevLine = line
      countValue = 1
      continue
    }
    if (line === prevLine) {
      countValue++
    } else {
      emit(prevLine, countValue)
      prevLine = line
      countValue = 1
    }
  }
  if (prevLine !== null) emit(prevLine, countValue)

  write(1, new TextEncoder().encode(output))
  return hasError ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  write(2, new TextEncoder().encode(`uniq: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
