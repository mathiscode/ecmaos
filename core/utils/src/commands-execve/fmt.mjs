/**
 * Real `execve`'d `fmt` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/fmt.ts`) per `feat/1.0.0-execve-commands`. See `cat.mjs`'s doc comment
 * for why there's no in-band interrupt handling and no `/dev`-path special case anymore.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, read, getcwd, open, close, stat, O_RDONLY } = globalThis.ecmaosSyscalls

const usage = `Usage: fmt [OPTION]... [FILE]...
Reformat paragraph text.

  -w, --width=WIDTH      maximum line width (default: 75)
  -s, --split-only       split long lines, but do not join short lines
  -u, --uniform-spacing use uniform spacing (one space between words)
  --help                display this help and exit`

function readWholeFile(fullPath) {
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
  return bytes
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
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function normalizeWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim()
}

function splitLongLines(text, width) {
  if (text.length <= width) return [text]

  const result = []
  let remaining = text

  while (remaining.length > width) {
    let breakPoint = width
    const spaceIndex = remaining.lastIndexOf(' ', width)
    if (spaceIndex > 0) breakPoint = spaceIndex

    result.push(remaining.slice(0, breakPoint).trim())
    remaining = remaining.slice(breakPoint).trim()
  }

  if (remaining.length > 0) result.push(remaining)

  return result
}

function formatParagraph(paragraph, width, splitOnly, uniformSpacing) {
  if (paragraph.length === 0) return []

  let text = paragraph.join(' ')
  text = uniformSpacing ? normalizeWhitespace(text) : text.replace(/\s+/g, ' ')

  if (splitOnly) return splitLongLines(text, width)

  const words = text.split(/\s+/).filter(w => w.length > 0)
  if (words.length === 0) return []

  const result = []
  let currentLine = ''

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word

    if (testLine.length <= width) {
      currentLine = testLine
    } else {
      if (currentLine) result.push(currentLine)
      currentLine = word

      if (currentLine.length > width) {
        const split = splitLongLines(currentLine, width)
        if (split.length > 0) {
          result.push(...split.slice(0, -1))
          currentLine = split[split.length - 1] || word
        }
      }
    }
  }

  if (currentLine) result.push(currentLine)

  return result
}

function formatText(lines, width, splitOnly, uniformSpacing) {
  const result = []
  let currentParagraph = []

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed === '') {
      if (currentParagraph.length > 0) {
        result.push(...formatParagraph(currentParagraph, width, splitOnly, uniformSpacing))
        currentParagraph = []
      }
      result.push('')
    } else {
      currentParagraph.push(trimmed)
    }
  }

  if (currentParagraph.length > 0) {
    result.push(...formatParagraph(currentParagraph, width, splitOnly, uniformSpacing))
  }

  return result
}

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    writeAll(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  let width = 75
  let splitOnly = false
  let uniformSpacing = false
  const files = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue

    if (arg === '--help' || arg === '-h') {
      writeAll(2, new TextEncoder().encode(usage + '\n'))
      return 0
    } else if (arg === '-w' || arg === '--width') {
      if (i + 1 < args.length) {
        const widthStr = args[++i]
        const parsed = parseInt(widthStr, 10)
        if (!isNaN(parsed) && parsed > 0) width = parsed
        else { writeAll(2, new TextEncoder().encode(`fmt: invalid width: ${widthStr}\n`)); return 1 }
      }
    } else if (arg.startsWith('--width=')) {
      const widthStr = arg.slice(8)
      const parsed = parseInt(widthStr, 10)
      if (!isNaN(parsed) && parsed > 0) width = parsed
      else { writeAll(2, new TextEncoder().encode(`fmt: invalid width: ${widthStr}\n`)); return 1 }
    } else if (arg.startsWith('-w')) {
      const widthStr = arg.slice(2)
      if (widthStr) {
        const parsed = parseInt(widthStr, 10)
        if (!isNaN(parsed) && parsed > 0) width = parsed
        else { writeAll(2, new TextEncoder().encode(`fmt: invalid width: ${widthStr}\n`)); return 1 }
      }
    } else if (arg === '-s' || arg === '--split-only') {
      splitOnly = true
    } else if (arg === '-u' || arg === '--uniform-spacing') {
      uniformSpacing = true
    } else if (arg.startsWith('-')) {
      const flags = arg.slice(1).split('')
      if (flags.includes('s')) splitOnly = true
      if (flags.includes('u')) uniformSpacing = true
      const invalid = flags.find(f => !['s', 'u'].includes(f))
      if (invalid) {
        writeAll(2, new TextEncoder().encode(`fmt: invalid option -- '${invalid}'\nTry 'fmt --help' for more information.\n`))
        return 1
      }
    } else {
      files.push(arg)
    }
  }

  try {
    let lines = []

    if (files.length === 0) {
      const content = new TextDecoder().decode(readAllStdin())
      lines = content.split('\n')
      if (lines[lines.length - 1] === '') lines.pop()
    } else {
      const cwd = getcwd()
      for (const file of files) {
        const fullPath = resolve(cwd, file)
        try {
          const content = new TextDecoder().decode(readWholeFile(fullPath))
          const fileLines = content.split('\n')
          if (fileLines[fileLines.length - 1] === '') fileLines.pop()
          lines.push(...fileLines)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          writeAll(2, new TextEncoder().encode(`fmt: ${file}: ${message}\n`))
        }
      }
    }

    const formatted = formatText(lines, width, splitOnly, uniformSpacing)
    let output = ''
    for (const line of formatted) output += line + '\n'
    writeAll(1, new TextEncoder().encode(output))

    return 0
  } catch (error) {
    writeAll(2, new TextEncoder().encode(`fmt: ${error instanceof Error ? error.message : String(error)}\n`))
    return 1
  }
}

try {
  exit(main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`fmt: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
