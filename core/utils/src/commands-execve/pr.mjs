/**
 * Real `execve`'d `pr` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/pr.ts`) per `feat/1.0.0-execve-commands`. See `head.mjs`'s doc comment
 * for why there's no in-band interrupt handling and no `/dev`-path special case anymore.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, read, getcwd, open, close, stat, O_RDONLY } = globalThis.ecmaosSyscalls

const usage = `Usage: pr [OPTION]... [FILE]...
Paginate or columnate files for printing.

  -l, --length=NUMBER    set page length (default: 66)
  -w, --width=NUMBER     set page width (default: 72)
  -h, --header=HEADER    set header string
  -t, --omit-header      omit page headers and footers
  -n, --number-lines     number lines
  --help                 display this help and exit`

function formatPage(lines, pageLength, pageWidth, header, omitHeader, numberLines, pageNum, filename) {
  const result = []
  const bodyLength = omitHeader ? pageLength : pageLength - 2

  if (!omitHeader && header !== undefined) {
    result.push(header.padEnd(pageWidth).slice(0, pageWidth))
    result.push('')
  } else if (!omitHeader) {
    const date = new Date().toLocaleString()
    result.push(`${filename} ${date}`.padEnd(pageWidth).slice(0, pageWidth))
    result.push('')
  }

  const startLine = (pageNum - 1) * bodyLength
  const endLine = Math.min(startLine + bodyLength, lines.length)

  for (let i = startLine; i < endLine; i++) {
    let line = lines[i] || ''
    line = line.length > pageWidth ? line.slice(0, pageWidth) : line.padEnd(pageWidth)
    if (numberLines) {
      const lineNum = (i + 1).toString().padStart(6)
      line = `${lineNum}  ${line.slice(0, pageWidth - 8)}`
    }
    result.push(line)
  }

  while (result.length < pageLength && !omitHeader) result.push('')

  if (!omitHeader) result.push(`Page ${pageNum}`.padStart(pageWidth))

  return result
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
  if (args.length > 0 && args[0] === '--help') {
    writeAll(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  let pageLength = 66
  let pageWidth = 72
  let header
  let omitHeader = false
  let numberLines = false
  const files = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('--header=')) {
      header = arg.slice(9)
    } else if (arg === '--header') {
      if (i + 1 < args.length) header = args[++i]
      else { writeAll(2, new TextEncoder().encode("pr: option '--header' requires an argument\n")); return 1 }
    } else if (arg === '-h') {
      if (i + 1 < args.length) header = args[++i]
      else { writeAll(2, new TextEncoder().encode(usage + '\n')); return 0 }
    } else if (arg.startsWith('-h') && arg.length > 2) {
      header = arg.slice(2)
    } else if (arg === '-l' || arg === '--length') {
      if (i + 1 < args.length) {
        const parsed = parseInt(args[++i], 10)
        if (!isNaN(parsed) && parsed > 0) pageLength = parsed
        else { writeAll(2, new TextEncoder().encode(`pr: invalid page length: ${args[i]}\n`)); return 1 }
      }
    } else if (arg.startsWith('--length=')) {
      const lengthStr = arg.slice(9)
      const parsed = parseInt(lengthStr, 10)
      if (!isNaN(parsed) && parsed > 0) pageLength = parsed
      else { writeAll(2, new TextEncoder().encode(`pr: invalid page length: ${lengthStr}\n`)); return 1 }
    } else if (arg.startsWith('-l')) {
      const lengthStr = arg.slice(2)
      if (lengthStr) {
        const parsed = parseInt(lengthStr, 10)
        if (!isNaN(parsed) && parsed > 0) pageLength = parsed
        else { writeAll(2, new TextEncoder().encode(`pr: invalid page length: ${lengthStr}\n`)); return 1 }
      }
    } else if (arg === '-w' || arg === '--width') {
      if (i + 1 < args.length) {
        const parsed = parseInt(args[++i], 10)
        if (!isNaN(parsed) && parsed > 0) pageWidth = parsed
        else { writeAll(2, new TextEncoder().encode(`pr: invalid page width: ${args[i]}\n`)); return 1 }
      }
    } else if (arg.startsWith('--width=')) {
      const widthStr = arg.slice(8)
      const parsed = parseInt(widthStr, 10)
      if (!isNaN(parsed) && parsed > 0) pageWidth = parsed
      else { writeAll(2, new TextEncoder().encode(`pr: invalid page width: ${widthStr}\n`)); return 1 }
    } else if (arg.startsWith('-w')) {
      const widthStr = arg.slice(2)
      if (widthStr) {
        const parsed = parseInt(widthStr, 10)
        if (!isNaN(parsed) && parsed > 0) pageWidth = parsed
        else { writeAll(2, new TextEncoder().encode(`pr: invalid page width: ${widthStr}\n`)); return 1 }
      }
    } else if (arg === '-t' || arg === '--omit-header') {
      omitHeader = true
    } else if (arg === '-n' || arg === '--number-lines') {
      numberLines = true
    } else if (arg.startsWith('-')) {
      const flags = arg.slice(1).split('')
      if (flags.includes('t')) omitHeader = true
      if (flags.includes('n')) numberLines = true
      const invalid = flags.find(f => !['t', 'n'].includes(f))
      if (invalid) {
        writeAll(2, new TextEncoder().encode(`pr: invalid option -- '${invalid}'\n`))
        writeAll(2, new TextEncoder().encode("Try 'pr --help' for more information.\n"))
        return 1
      }
    } else {
      files.push(arg)
    }
  }

  let lines = []

  if (files.length === 0) {
    lines = splitLines(readAllStdin())
  } else {
    const cwd = getcwd()
    for (const file of files) {
      try {
        lines.push(...splitLines(readWholeFileText(resolve(cwd, file))))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        writeAll(2, new TextEncoder().encode(`pr: ${file}: ${message}\n`))
      }
    }
  }

  const bodyLength = omitHeader ? pageLength : pageLength - 2
  const totalPages = Math.ceil(lines.length / bodyLength)
  const filename = files[0] ?? 'stdin'

  let output = ''
  for (let page = 1; page <= totalPages; page++) {
    for (const line of formatPage(lines, pageLength, pageWidth, header, omitHeader, numberLines, page, filename)) {
      output += line + '\n'
    }
  }
  writeAll(1, new TextEncoder().encode(output))

  return 0
}

try {
  exit(main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`pr: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
