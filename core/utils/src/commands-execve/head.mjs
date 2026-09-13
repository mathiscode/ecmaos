/**
 * Real `execve`'d `head` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/head.ts`) per `feat/1.0.0-execve-commands`. No special in-band interrupt
 * handling (see `cat.mjs`'s doc comment for why: a real `execve`'d process is killed like any other).
 * The old `/dev`-path special case is dropped too -- every migrated coreutil just opens the real path
 * with the plain `open`/`read` syscalls; a real device file either supports that or errors like any
 * other unsupported open, exactly as real Linux's own `head /dev/something` would.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, read, getcwd, open, close, stat, O_RDONLY } = globalThis.ecmaosSyscalls

const usage = `Usage: head [OPTION]... [FILE]...
Print the first 10 lines of each FILE to standard output.

  -n, -nNUMBER        print the first NUMBER lines instead of 10
  -c, -cNUMBER        print the first NUMBER bytes instead of lines
  --help             display this help and exit`

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

function firstNLines(bytes, numLines) {
  const text = new TextDecoder().decode(bytes)
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  const output = lines.slice(0, numLines).join('\n')
  return output ? new TextEncoder().encode(output + '\n') : new Uint8Array(0)
}

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    writeAll(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  let numLines = 10
  let numBytes = null
  const files = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-n' || arg.startsWith('-n')) {
      if (arg === '-n' && i + 1 < args.length) {
        i++
        const num = parseInt(args[i], 10)
        if (!isNaN(num)) numLines = num
      } else if (arg.length > 2) {
        const num = parseInt(arg.slice(2), 10)
        if (!isNaN(num)) numLines = num
      }
    } else if (arg === '-c' || arg.startsWith('-c')) {
      if (arg === '-c' && i + 1 < args.length) {
        i++
        const num = parseInt(args[i], 10)
        if (!isNaN(num)) numBytes = num
      } else if (arg.length > 2) {
        const num = parseInt(arg.slice(2), 10)
        if (!isNaN(num)) numBytes = num
      }
    } else if (!arg.startsWith('-')) {
      files.push(arg)
    }
  }

  if (files.length === 0) {
    const bytes = readAllStdin()
    const output = numBytes !== null ? bytes.subarray(0, numBytes) : firstNLines(bytes, numLines)
    writeAll(1, output)
    return 0
  }

  const cwd = getcwd()
  const isMultipleFiles = files.length > 1
  let hasError = false

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    const fullPath = resolve(cwd, file)

    if (isMultipleFiles) {
      const header = i > 0 ? '\n' : ''
      writeAll(1, new TextEncoder().encode(`${header}==> ${file} <==\n`))
    }

    try {
      const bytes = readWholeFile(fullPath)
      const output = numBytes !== null ? bytes.subarray(0, Math.min(numBytes, bytes.length)) : firstNLines(bytes, numLines)
      writeAll(1, output)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const reason = message.includes('ENOENT') ? 'No such file or directory' : message
      writeAll(2, new TextEncoder().encode(`head: ${file}: ${reason}\n`))
      hasError = true
    }
  }

  return hasError ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`head: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
