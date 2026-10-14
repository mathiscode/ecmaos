/** Print the first lines (or bytes, with `-c`) of each file, or of stdin. */

import { resolve } from './lib/path-utils.mjs'
import { readFileBytes } from './lib/bytes.mjs'

const { argv, exit, writeAll, read, getcwd, open, close, stat, O_RDONLY } = globalThis.ecmaosSyscalls

const usage = `Usage: head [OPTION]... [FILE]...
Print the first 10 lines of each FILE to standard output.

  -n, -nNUMBER        print the first NUMBER lines instead of 10
  -NUMBER             the same as -nNUMBER
  -c, -cNUMBER        print the first NUMBER bytes instead of lines
  --help             display this help and exit`

/** Reads `fd` (stdin, or a file that may never end, such as `/dev/zero`) only until there is enough: `limitBytes` (`-c`) bytes, or `limitLines` (`-n`) newlines. */
function readUntilEnough(fd, limitBytes, limitLines) {
  const chunkSize = 65536
  const chunks = []
  let total = 0
  let newlines = 0

  while (true) {
    if (limitBytes !== null && total >= limitBytes) break
    if (limitBytes === null && newlines >= limitLines) break

    const buffer = new Uint8Array(chunkSize)
    const n = read(fd, buffer, -1)
    if (n <= 0) break

    const chunk = buffer.subarray(0, n)
    chunks.push(chunk)
    total += n
    if (limitBytes === null) {
      for (let i = 0; i < chunk.length; i++) if (chunk[i] === 0x0a) newlines++
    }
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

function readWholeFile(fullPath) {
  const bytes = readFileBytes(fullPath)
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
    } else if (/^-\d+$/.test(arg)) {
      // The obsolete `head -3` spelling of `-n 3`, which scripts still use.
      numLines = parseInt(arg.slice(1), 10)
    } else if (!arg.startsWith('-')) {
      files.push(arg)
    }
  }

  if (files.length === 0) {
    const bytes = readUntilEnough(0, numBytes, numLines)
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
      const fd = open(fullPath, O_RDONLY)
      let bytes
      try { bytes = readUntilEnough(fd, numBytes, numLines) } finally { close(fd) }
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
