/**
 * Real `execve`'d `fold` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/fold.ts`) per `feat/1.0.0-execve-commands`. See `head.mjs`'s doc comment
 * for why there's no in-band interrupt handling and no `/dev`-path special case anymore.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, read, getcwd, open, close, stat, O_RDONLY } = globalThis.ecmaosSyscalls

const usage = `Usage: fold [OPTION]... [FILE]...
Wrap each input line to fit in specified width.

  -w, --width=WIDTH   use WIDTH columns instead of 80
  -s, --spaces        break at spaces when possible
  -b, --bytes         count bytes instead of columns
  --help             display this help and exit`

function wrapLine(line, width, breakAtSpaces, countBytes) {
  if (!line) return ['']

  const result = []

  if (countBytes) {
    const encoder = new TextEncoder()
    let current = ''
    let currentBytes = 0

    for (let i = 0; i < line.length; i++) {
      const char = line[i]
      const charBytes = encoder.encode(char).length

      if (currentBytes + charBytes > width && current.length > 0) {
        if (breakAtSpaces) {
          const lastSpace = current.lastIndexOf(' ')
          if (lastSpace > 0) {
            result.push(current.slice(0, lastSpace))
            current = current.slice(lastSpace + 1) + char
            currentBytes = encoder.encode(current).length
            continue
          }
        }
        result.push(current)
        current = char || ''
        currentBytes = charBytes
      } else {
        current += char
        currentBytes += charBytes
      }
    }

    if (current.length > 0) result.push(current)
  } else {
    let current = ''

    for (let i = 0; i < line.length; i++) {
      const char = line[i]

      if (current.length >= width && current.length > 0) {
        if (breakAtSpaces) {
          const lastSpace = current.lastIndexOf(' ')
          if (lastSpace > 0) {
            result.push(current.slice(0, lastSpace))
            current = current.slice(lastSpace + 1) + char
            continue
          }
        }
        result.push(current)
        current = char || ''
      } else {
        current += char
      }
    }

    if (current.length > 0) result.push(current)
  }

  return result.length > 0 ? result : ['']
}

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

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    writeAll(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  let width = 80
  let breakAtSpaces = false
  let countBytes = false
  const files = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-w' || arg === '--width') {
      if (i + 1 < args.length) {
        const parsed = parseInt(args[++i], 10)
        if (!isNaN(parsed) && parsed > 0) width = parsed
        else { writeAll(2, new TextEncoder().encode(`fold: invalid width: ${args[i]}\n`)); return 1 }
      }
    } else if (arg.startsWith('--width=')) {
      const widthStr = arg.slice(8)
      const parsed = parseInt(widthStr, 10)
      if (!isNaN(parsed) && parsed > 0) width = parsed
      else { writeAll(2, new TextEncoder().encode(`fold: invalid width: ${widthStr}\n`)); return 1 }
    } else if (arg.startsWith('-w')) {
      const widthStr = arg.slice(2)
      if (widthStr) {
        const parsed = parseInt(widthStr, 10)
        if (!isNaN(parsed) && parsed > 0) width = parsed
        else { writeAll(2, new TextEncoder().encode(`fold: invalid width: ${widthStr}\n`)); return 1 }
      }
    } else if (arg === '-s' || arg === '--spaces') {
      breakAtSpaces = true
    } else if (arg === '-b' || arg === '--bytes') {
      countBytes = true
    } else if (arg.startsWith('-')) {
      const flags = arg.slice(1).split('')
      if (flags.includes('s')) breakAtSpaces = true
      if (flags.includes('b')) countBytes = true
      const invalid = flags.find(f => !['s', 'b'].includes(f))
      if (invalid) {
        writeAll(2, new TextEncoder().encode(`fold: invalid option -- '${invalid}'\n`))
        writeAll(2, new TextEncoder().encode("Try 'fold --help' for more information.\n"))
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
        writeAll(2, new TextEncoder().encode(`fold: ${file}: ${message}\n`))
        hasError = true
      }
    }
  }

  let output = ''
  for (const line of lines) {
    for (const wrappedLine of wrapLine(line, width, breakAtSpaces, countBytes)) output += wrappedLine + '\n'
  }
  writeAll(1, new TextEncoder().encode(output))

  return hasError ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`fold: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
