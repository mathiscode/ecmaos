/**
 * Real `execve`'d `unexpand` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/unexpand.ts`) per `feat/1.0.0-execve-commands`. See `head.mjs`'s doc
 * comment for why there's no in-band interrupt handling and no `/dev`-path special case anymore.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, write, read, getcwd, open, close, stat, O_RDONLY } = globalThis.ecmaosSyscalls

const usage = `Usage: unexpand [OPTION]... [FILE]...
Convert spaces to tabs in each FILE.

  -t, --tabs=NUMBER     have tabs NUMBER characters apart, not 8
  -t, --tabs=LIST      use comma separated list of tab positions
  -a, --all            convert all spaces, not just leading spaces
  --help               display this help and exit`

function parseTabStops(tabStr) {
  if (tabStr.includes(',')) {
    const stops = tabStr.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n > 0)
    return stops.length > 0 ? stops : [8]
  }
  const single = parseInt(tabStr, 10)
  return !isNaN(single) && single > 0 ? [single] : [8]
}

function getNextTabStop(column, tabStops) {
  if (tabStops.length === 1) {
    const interval = tabStops[0] ?? 8
    return Math.ceil((column + 1) / interval) * interval
  }
  for (const stop of tabStops) if (stop > column) return stop
  const lastStop = tabStops[tabStops.length - 1]
  let nextStop = lastStop ?? 8
  while (nextStop <= column) nextStop += lastStop ?? 8
  return nextStop
}

function unexpandLeadingSpaces(line, tabStops) {
  let leadingSpaces = 0
  let i = 0
  while (i < line.length && line[i] === ' ') { leadingSpaces++; i++ }
  if (leadingSpaces === 0) return line

  let result = ''
  let column = 0
  let spaceIdx = 0

  while (spaceIdx < leadingSpaces) {
    const nextStop = getNextTabStop(column, tabStops)
    const spacesToNextStop = nextStop - column
    const remainingSpaces = leadingSpaces - spaceIdx

    if (spacesToNextStop <= remainingSpaces) {
      result += '\t'
      column = nextStop
      spaceIdx += spacesToNextStop
    } else {
      result += ' '
      column++
      spaceIdx++
    }
  }

  return result + line.slice(leadingSpaces)
}

function convertSpacesToTabs(startColumn, spaceCount, tabStops) {
  let result = ''
  let column = startColumn
  let spaceIdx = 0

  while (spaceIdx < spaceCount) {
    const nextStop = getNextTabStop(column, tabStops)
    const spacesToNextStop = nextStop - column
    const remainingSpaces = spaceCount - spaceIdx

    if (spacesToNextStop <= remainingSpaces && spacesToNextStop > 1) {
      result += '\t'
      column = nextStop
      spaceIdx += spacesToNextStop
    } else if (spacesToNextStop === 1 && remainingSpaces >= 1) {
      result += '\t'
      column = nextStop
      spaceIdx += 1
    } else {
      result += ' '
      column++
      spaceIdx++
    }
  }

  return result
}

function unexpandAllSpaces(line, tabStops) {
  let result = ''
  let column = 0
  let spaceCount = 0
  let spaceStartColumn = 0

  for (let i = 0; i < line.length; i++) {
    const char = line[i]

    if (char === ' ') {
      if (spaceCount === 0) spaceStartColumn = column
      spaceCount++
      column++
    } else {
      if (spaceCount > 0) {
        result += convertSpacesToTabs(spaceStartColumn, spaceCount, tabStops)
        spaceCount = 0
      }
      result += char
      if (char === '\n' || char === '\r') column = 0
      else column++
    }
  }

  if (spaceCount > 0) result += ' '.repeat(spaceCount)

  return result
}

function unexpandTabs(line, tabStops, all) {
  return all ? unexpandAllSpaces(line, tabStops) : unexpandLeadingSpaces(line, tabStops)
}

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

  let tabStops = [8]
  let all = false
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
    } else if (arg === '-a' || arg === '--all') {
      all = true
    } else if (arg.startsWith('-')) {
      const flags = arg.slice(1).split('')
      if (flags.includes('a')) all = true
      const invalid = flags.find(f => f !== 'a')
      if (invalid) {
        write(2, new TextEncoder().encode(`unexpand: invalid option -- '${invalid}'\n`))
        write(2, new TextEncoder().encode("Try 'unexpand --help' for more information.\n"))
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
        write(2, new TextEncoder().encode(`unexpand: ${file}: ${message}\n`))
        hasError = true
      }
    }
  }

  let output = ''
  for (const line of lines) output += unexpandTabs(line, tabStops, all) + '\n'
  write(1, new TextEncoder().encode(output))

  return hasError ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  write(2, new TextEncoder().encode(`unexpand: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
