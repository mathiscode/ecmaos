/**
 * Real `execve`'d `expand` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/expand.ts`) per `feat/1.0.0-execve-commands`. See `head.mjs`'s doc
 * comment for why there's no in-band interrupt handling and no `/dev`-path special case anymore.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, read, getcwd, open, close, stat, O_RDONLY } = globalThis.ecmaosSyscalls

const usage = `Usage: expand [OPTION]... [FILE]...
Convert tabs to spaces in each FILE.

  -t, --tabs=NUMBER     have tabs NUMBER characters apart, not 8
  -t, --tabs=LIST       use comma separated list of tab positions
  --help               display this help and exit`

function parseTabStops(tabStr) {
  if (tabStr.includes(',')) {
    const stops = tabStr.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n > 0)
    return stops.length > 0 ? stops : [8]
  }
  const single = parseInt(tabStr, 10)
  return !isNaN(single) && single > 0 ? [single] : [8]
}

function expandTabs(line, tabStops) {
  let result = ''
  let column = 0

  for (let i = 0; i < line.length; i++) {
    const char = line[i]

    if (char === '\t') {
      let nextStop = tabStops[0] ?? 8
      for (const stop of tabStops) {
        if (stop > column) { nextStop = stop; break }
      }

      if (nextStop <= column) {
        const lastStop = tabStops[tabStops.length - 1] ?? 8
        nextStop = lastStop
        while (nextStop <= column) nextStop += lastStop
      }

      const spaces = nextStop - column
      result += ' '.repeat(spaces)
      column = nextStop
    } else {
      result += char
      if (char === '\n' || char === '\r') column = 0
      else column++
    }
  }

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
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    writeAll(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  let tabStops = [8]
  const files = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-t' || arg === '--tabs') {
      if (i + 1 < args.length) tabStops = parseTabStops(args[++i])
    } else if (arg.startsWith('--tabs=')) {
      tabStops = parseTabStops(arg.slice(7))
    } else if (arg.startsWith('-t')) {
      const tabStr = arg.slice(2)
      if (tabStr) tabStops = parseTabStops(tabStr)
    } else if (!arg.startsWith('-')) {
      files.push(arg)
    } else {
      writeAll(2, new TextEncoder().encode(`expand: invalid option -- '${arg.slice(1)}'\n`))
      writeAll(2, new TextEncoder().encode("Try 'expand --help' for more information.\n"))
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
        writeAll(2, new TextEncoder().encode(`expand: ${file}: ${message}\n`))
        hasError = true
      }
    }
  }

  let output = ''
  for (const line of lines) output += expandTabs(line, tabStops) + '\n'
  writeAll(1, new TextEncoder().encode(output))

  return hasError ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`expand: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
