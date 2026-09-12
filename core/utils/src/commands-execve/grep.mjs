/**
 * Real `execve`'d `grep` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/grep.ts`) per `feat/1.0.0-execve-commands`. See `cat.mjs`'s doc comment
 * for why there's no in-band interrupt handling and no `/dev`-path special case anymore.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, write, read, getcwd, open, close, stat, O_RDONLY } = globalThis.ecmaosSyscalls

const usage = `Usage: grep [OPTION]... PATTERN [FILE]...
Search for PATTERN in each FILE.

  -i, --ignore-case   ignore case distinctions
  -n, --line-number   print line number with output lines
  --help              display this help and exit`

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
    if (n < chunkSize) break
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
    write(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  let ignoreCase = false
  let showLineNumbers = false
  const positional = []

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      write(2, new TextEncoder().encode(usage + '\n'))
      return 0
    } else if (arg === '-i' || arg === '--ignore-case') {
      ignoreCase = true
    } else if (arg === '-n' || arg === '--line-number') {
      showLineNumbers = true
    } else if (arg.startsWith('-')) {
      const flags = arg.slice(1).split('')
      if (flags.includes('i')) ignoreCase = true
      if (flags.includes('n')) showLineNumbers = true
      const invalid = flags.find(f => !['i', 'n'].includes(f))
      if (invalid) {
        write(2, new TextEncoder().encode(`grep: invalid option -- '${invalid}'\n`))
        return 1
      }
    } else {
      positional.push(arg)
    }
  }

  if (positional.length === 0) {
    write(2, new TextEncoder().encode('grep: pattern is required\n'))
    return 1
  }

  const pattern = positional[0]
  const files = positional.slice(1)

  let regex
  try {
    regex = new RegExp(pattern, ignoreCase ? 'i' : '')
  } catch (error) {
    write(2, new TextEncoder().encode(`grep: invalid pattern: ${error instanceof Error ? error.message : String(error)}\n`))
    return 1
  }

  let output = ''
  let exitCode = 0

  if (files.length === 0) {
    const content = new TextDecoder().decode(readAllStdin())
    const lines = content.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()

    let lineNumber = 1
    for (const line of lines) {
      if (regex.test(line)) {
        output += showLineNumbers ? `${lineNumber}:${line}\n` : `${line}\n`
      }
      lineNumber++
    }
  } else {
    const cwd = getcwd()
    for (const file of files) {
      const fullPath = resolve(cwd, file)
      try {
        const content = new TextDecoder().decode(readWholeFile(fullPath))
        const lines = content.split('\n')
        if (lines[lines.length - 1] === '') lines.pop()

        let lineNumber = 1
        for (const line of lines) {
          if (regex.test(line)) {
            const prefix = files.length > 1 ? `${file}:` : ''
            const lineNumPrefix = showLineNumbers ? `${lineNumber}:` : ''
            output += `${prefix}${lineNumPrefix}${line}\n`
          }
          lineNumber++
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        write(2, new TextEncoder().encode(`grep: ${file}: ${message}\n`))
        exitCode = 1
      }
    }
  }

  write(1, new TextEncoder().encode(output))
  return exitCode
}

try {
  exit(main())
} catch (error) {
  write(2, new TextEncoder().encode(`grep: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
