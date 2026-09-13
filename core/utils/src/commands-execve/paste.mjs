/**
 * Real `execve`'d `paste` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/paste.ts`) per `feat/1.0.0-execve-commands`. See `head.mjs`'s doc comment
 * for why there's no in-band interrupt handling and no `/dev`-path special case anymore.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, read, getcwd, open, close, stat, O_RDONLY } = globalThis.ecmaosSyscalls

const usage = `Usage: paste [OPTION]... [FILE]...
Merge lines of files.

  -d, --delimiters=LIST  reuse characters from LIST instead of TABs
  -s, --serial           paste one file at a time instead of in parallel
  --help                 display this help and exit`

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

function readFileLines(fullPath) {
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
  const text = new TextDecoder().decode(bytes)
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

  const files = []
  let delimiters = '\t'
  let serial = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-d' || arg === '--delimiters') {
      if (i + 1 < args.length) delimiters = args[++i] || '\t'
    } else if (arg.startsWith('--delimiters=')) {
      delimiters = arg.slice(13)
    } else if (arg.startsWith('-d')) {
      delimiters = arg.slice(2) || '\t'
    } else if (arg === '-s' || arg === '--serial') {
      serial = true
    } else if (!arg.startsWith('-')) {
      files.push(arg)
    }
  }

  if (files.length === 0) {
    const text = readAllStdin()
    const lines = text.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    let output = ''
    for (const line of lines) output += line + '\n'
    writeAll(1, new TextEncoder().encode(output))
    return 0
  }

  const cwd = getcwd()
  const fileLines = []

  for (const file of files) {
    try {
      fileLines.push(readFileLines(resolve(cwd, file)))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeAll(2, new TextEncoder().encode(`paste: ${file}: ${message}\n`))
      return 1
    }
  }

  let output = ''
  if (serial) {
    for (const lines of fileLines) for (const line of lines) output += line + '\n'
  } else {
    const maxLines = Math.max(...fileLines.map(f => f.length))
    const delimiter = delimiters[0] || '\t'
    for (let i = 0; i < maxLines; i++) {
      const parts = fileLines.map(lines => lines[i] || '')
      output += parts.join(delimiter) + '\n'
    }
  }
  writeAll(1, new TextEncoder().encode(output))

  return 0
}

try {
  exit(main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`paste: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
