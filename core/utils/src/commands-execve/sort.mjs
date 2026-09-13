/**
 * Real `execve`'d `sort` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/sort.ts`) per `feat/1.0.0-execve-commands`. See `cat.mjs`'s doc comment
 * for why there's no in-band interrupt handling and no `/dev`-path special case anymore.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, read, getcwd, open, close, stat, O_RDONLY } = globalThis.ecmaosSyscalls

const usage = `Usage: sort [OPTION]... [FILE]...
Sort lines of text files.

  -r, --reverse  reverse the result of comparisons
  -n, --numeric   compare according to string numerical value
  -u, --unique    output only the first of an equal run
  --help          display this help and exit`

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

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    writeAll(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  const files = []
  let reverse = false
  let numeric = false
  let unique = false

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      writeAll(2, new TextEncoder().encode(usage + '\n'))
      return 0
    } else if (arg === '-r' || arg === '--reverse') {
      reverse = true
    } else if (arg === '-n' || arg === '--numeric') {
      numeric = true
    } else if (arg === '-u' || arg === '--unique') {
      unique = true
    } else if (arg.startsWith('-')) {
      const flags = arg.slice(1).split('')
      if (flags.includes('r')) reverse = true
      if (flags.includes('n')) numeric = true
      if (flags.includes('u')) unique = true
      const invalid = flags.find(f => !['r', 'n', 'u'].includes(f))
      if (invalid) {
        writeAll(2, new TextEncoder().encode(`sort: invalid option -- '${invalid}'\n`))
        return 1
      }
    } else {
      files.push(arg)
    }
  }

  let lines = []

  try {
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
          writeAll(2, new TextEncoder().encode(`sort: ${file}: ${message}\n`))
        }
      }
    }

    if (numeric) {
      lines.sort((a, b) => {
        const numA = parseFloat(a.trim())
        const numB = parseFloat(b.trim())
        if (isNaN(numA) && isNaN(numB)) return a.localeCompare(b)
        if (isNaN(numA)) return 1
        if (isNaN(numB)) return -1
        return reverse ? numB - numA : numA - numB
      })
    } else {
      lines.sort((a, b) => {
        return reverse ? b.localeCompare(a) : a.localeCompare(b)
      })
    }

    if (unique) {
      const seen = new Set()
      lines = lines.filter(line => {
        if (seen.has(line)) return false
        seen.add(line)
        return true
      })
    }

    let output = ''
    for (const line of lines) output += line + '\n'
    writeAll(1, new TextEncoder().encode(output))

    return 0
  } catch (error) {
    writeAll(2, new TextEncoder().encode(`sort: ${error instanceof Error ? error.message : String(error)}\n`))
    return 1
  }
}

try {
  exit(main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`sort: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
