/**
 * Real `execve`'d `rev` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/rev.ts`) per `feat/1.0.0-execve-commands`. See `head.mjs`'s doc comment
 * for why there's no in-band interrupt handling and no `/dev`-path special case anymore.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, write, read, getcwd, open, close, stat, O_RDONLY } = globalThis.ecmaosSyscalls

const usage = `Usage: rev [FILE]...
Reverse the characters of each line.

  --help  display this help and exit`

function reverseLine(line) {
  return [...line].reverse().join('')
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

  const files = []
  for (const arg of args) {
    if (!arg.startsWith('-')) {
      files.push(arg)
    } else {
      write(2, new TextEncoder().encode(`rev: invalid option -- '${arg.slice(1)}'\n`))
      write(2, new TextEncoder().encode("Try 'rev --help' for more information.\n"))
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
        write(2, new TextEncoder().encode(`rev: ${file}: ${message}\n`))
        hasError = true
      }
    }
  }

  let output = ''
  for (const line of lines) output += reverseLine(line) + '\n'
  write(1, new TextEncoder().encode(output))

  return hasError ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  write(2, new TextEncoder().encode(`rev: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
