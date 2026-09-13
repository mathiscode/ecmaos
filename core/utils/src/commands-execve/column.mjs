/**
 * Real `execve`'d `column` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/column.ts`) per `feat/1.0.0-execve-commands`. `columnify` is a plain npm
 * package with no DOM/kernel dependency, bundled into this worker program by esbuild the same way
 * `human-format`/`semver` already are for `df`/`install`. See `head.mjs`'s doc comment for why
 * there's no in-band interrupt handling and no `/dev`-path special case anymore.
 */

import columnify from 'columnify'
import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, read, getcwd, open, close, stat, O_RDONLY } = globalThis.ecmaosSyscalls

const usage = `Usage: column [OPTION]... [FILE]...
Format input into columns.

  -t, --table              create a table
  -s, --separator=SEP      specify column separator (default: whitespace)
  -c, --columns=COLS       specify number of columns
  --help                   display this help and exit`

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

  let table = false
  let separator
  let columns
  const files = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-t' || arg === '--table') {
      table = true
    } else if (arg === '-s' || arg === '--separator') {
      if (i + 1 < args.length) separator = args[++i]
    } else if (arg.startsWith('--separator=')) {
      separator = arg.slice(12)
    } else if (arg.startsWith('-s')) {
      separator = arg.slice(2) || undefined
    } else if (arg === '-c' || arg === '--columns') {
      if (i + 1 < args.length) {
        const parsed = parseInt(args[++i], 10)
        if (!isNaN(parsed) && parsed > 0) columns = parsed
        else { writeAll(2, new TextEncoder().encode(`column: invalid column count: ${args[i]}\n`)); return 1 }
      }
    } else if (arg.startsWith('--columns=')) {
      const colsStr = arg.slice(10)
      const parsed = parseInt(colsStr, 10)
      if (!isNaN(parsed) && parsed > 0) columns = parsed
      else { writeAll(2, new TextEncoder().encode(`column: invalid column count: ${colsStr}\n`)); return 1 }
    } else if (arg.startsWith('-c')) {
      const colsStr = arg.slice(2)
      if (colsStr) {
        const parsed = parseInt(colsStr, 10)
        if (!isNaN(parsed) && parsed > 0) columns = parsed
        else { writeAll(2, new TextEncoder().encode(`column: invalid column count: ${colsStr}\n`)); return 1 }
      }
    } else if (!arg.startsWith('-')) {
      files.push(arg)
    } else {
      writeAll(2, new TextEncoder().encode(`column: invalid option -- '${arg.slice(1)}'\n`))
      writeAll(2, new TextEncoder().encode("Try 'column --help' for more information.\n"))
      return 1
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
        writeAll(2, new TextEncoder().encode(`column: ${file}: ${message}\n`))
        hasError = true
      }
    }
  }

  if (table && separator) {
    const data = []
    const headers = new Set()
    for (const line of lines) {
      if (!line.trim()) continue
      const parts = line.split(separator)
      const row = {}
      parts.forEach((part, idx) => { const h = `col${idx + 1}`; headers.add(h); row[h] = part.trim() })
      data.push(row)
    }
    if (data.length > 0) {
      writeAll(1, new TextEncoder().encode(columnify(data, { columns: Array.from(headers), columnSplitter: '  ', showHeaders: true })))
    }
  } else if (table) {
    const data = []
    const headers = new Set()
    for (const line of lines) {
      if (!line.trim()) continue
      const parts = line.trim().split(/\s+/)
      const row = {}
      parts.forEach((part, idx) => { const h = `col${idx + 1}`; headers.add(h); row[h] = part })
      data.push(row)
    }
    if (data.length > 0) {
      writeAll(1, new TextEncoder().encode(columnify(data, { columns: Array.from(headers), columnSplitter: '  ', showHeaders: true })))
    }
  } else {
    const words = []
    for (const line of lines) {
      if (separator) words.push(...line.split(separator).map(w => w.trim()).filter(w => w))
      else words.push(...line.trim().split(/\s+/).filter(w => w))
    }

    if (columns && columns > 0) {
      const rows = []
      for (let i = 0; i < words.length; i += columns) rows.push(words.slice(i, i + columns))

      const data = []
      for (const row of rows) {
        const rowObj = {}
        for (let i = 0; i < columns; i++) rowObj[`col${i + 1}`] = row[i] || ''
        data.push(rowObj)
      }

      if (data.length > 0) {
        writeAll(1, new TextEncoder().encode(columnify(data, {
          columns: Array.from({ length: columns }, (_, i) => `col${i + 1}`),
          columnSplitter: '  ',
          showHeaders: false
        })))
      }
    } else {
      let output = ''
      for (const word of words) output += word + '\n'
      writeAll(1, new TextEncoder().encode(output))
    }
  }

  return hasError ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`column: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
