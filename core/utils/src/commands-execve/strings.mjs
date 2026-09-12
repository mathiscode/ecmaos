/**
 * Real `execve`'d `strings` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/strings.ts`) per `feat/1.0.0-execve-commands`. See `head.mjs`'s doc
 * comment for why there's no in-band interrupt handling and no `/dev`-path special case anymore.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, write, read, getcwd, open, close, stat, O_RDONLY } = globalThis.ecmaosSyscalls

const usage = `Usage: strings [OPTION]... [FILE]...
Print the sequences of printable characters in files.

  -n, --bytes=MIN_LEN    print sequences of at least MIN_LEN characters (default: 4)
  --help                 display this help and exit`

function extractStrings(data, minLen) {
  const strings = []
  let current = ''

  for (let i = 0; i < data.length; i++) {
    const byte = data[i]
    if (byte >= 32 && byte <= 126) {
      current += String.fromCharCode(byte)
    } else {
      if (current.length >= minLen) strings.push(current)
      current = ''
    }
  }
  if (current.length >= minLen) strings.push(current)

  return strings
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
  return bytes
}

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

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    write(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  let minLen = 4
  const files = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-n' || arg === '--bytes') {
      if (i + 1 < args.length) {
        const parsed = parseInt(args[++i], 10)
        if (!isNaN(parsed) && parsed > 0) minLen = parsed
        else { write(2, new TextEncoder().encode(`strings: invalid minimum length: ${args[i]}\n`)); return 1 }
      }
    } else if (arg.startsWith('--bytes=')) {
      const lenStr = arg.slice(8)
      const parsed = parseInt(lenStr, 10)
      if (!isNaN(parsed) && parsed > 0) minLen = parsed
      else { write(2, new TextEncoder().encode(`strings: invalid minimum length: ${lenStr}\n`)); return 1 }
    } else if (arg.startsWith('-n')) {
      const lenStr = arg.slice(2)
      if (lenStr) {
        const parsed = parseInt(lenStr, 10)
        if (!isNaN(parsed) && parsed > 0) minLen = parsed
        else { write(2, new TextEncoder().encode(`strings: invalid minimum length: ${lenStr}\n`)); return 1 }
      }
    } else if (!arg.startsWith('-')) {
      files.push(arg)
    } else {
      write(2, new TextEncoder().encode(`strings: invalid option -- '${arg.slice(1)}'\n`))
      write(2, new TextEncoder().encode("Try 'strings --help' for more information.\n"))
      return 1
    }
  }

  if (files.length === 0) {
    const data = readAllStdin()
    let output = ''
    for (const str of extractStrings(data, minLen)) output += str + '\n'
    write(1, new TextEncoder().encode(output))
    return 0
  }

  const cwd = getcwd()
  let hasError = false

  for (const file of files) {
    const fullPath = resolve(cwd, file)
    try {
      const data = readWholeFile(fullPath)
      let output = ''
      for (const str of extractStrings(data, minLen)) output += str + '\n'
      write(1, new TextEncoder().encode(output))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      write(2, new TextEncoder().encode(`strings: ${file}: ${message}\n`))
      hasError = true
    }
  }

  return hasError ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  write(2, new TextEncoder().encode(`strings: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
