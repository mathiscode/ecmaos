/**
 * Real `execve`'d `join` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/join.ts`) per `feat/1.0.0-execve-commands`. See `head.mjs`'s doc comment
 * for why there's no in-band interrupt handling and no `/dev`-path special case anymore.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, write, read, getcwd, open, close, stat, O_RDONLY } = globalThis.ecmaosSyscalls

const usage = `Usage: join [OPTION]... FILE1 FILE2
Join lines of two files on a common field.

  -1 FIELD    join on this FIELD of file 1
  -2 FIELD    join on this FIELD of file 2
  -t CHAR     use CHAR as input and output field separator
  --help      display this help and exit`

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
    write(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  const files = []
  let field1 = 1
  let field2 = 1
  let delimiter = ' '

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-1' && i + 1 < args.length) {
      field1 = parseInt(args[++i], 10) || 1
    } else if (arg === '-2' && i + 1 < args.length) {
      field2 = parseInt(args[++i], 10) || 1
    } else if (arg.startsWith('-t')) {
      delimiter = arg.slice(2) || ' '
    } else if (arg === '-t' && i + 1 < args.length) {
      delimiter = args[++i]
    } else if (!arg.startsWith('-')) {
      if (files.length < 2) files.push(arg)
    }
  }

  if (files.length !== 2) {
    write(2, new TextEncoder().encode('join: exactly two files must be specified\n'))
    return 1
  }

  const [file1, file2] = files
  const cwd = getcwd()

  try {
    const lines1 = readFileLines(resolve(cwd, file1))
    const lines2 = readFileLines(resolve(cwd, file2))

    const map1 = new Map()
    for (const line of lines1) {
      const parts = line.split(delimiter)
      const key = parts[field1 - 1] || ''
      if (!map1.has(key)) map1.set(key, [])
      map1.get(key).push(line)
    }

    let output = ''
    for (const line of lines2) {
      const parts = line.split(delimiter)
      const key = parts[field2 - 1] || ''
      const matches = map1.get(key)
      if (matches) {
        for (const match of matches) {
          const matchParts = match.split(delimiter)
          output += [...matchParts, ...parts.slice(field2)].join(delimiter) + '\n'
        }
      }
    }
    write(1, new TextEncoder().encode(output))

    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    write(2, new TextEncoder().encode(`join: ${message}\n`))
    return 1
  }
}

try {
  exit(main())
} catch (error) {
  write(2, new TextEncoder().encode(`join: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
