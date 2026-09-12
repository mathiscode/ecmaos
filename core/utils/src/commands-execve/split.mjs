/**
 * Real `execve`'d `split` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/split.ts`) per `feat/1.0.0-execve-commands`. See `head.mjs`'s doc
 * comment for why there's no in-band interrupt handling and no `/dev`-path special case anymore.
 */

import { resolve, dirname, join } from './lib/path-utils.mjs'

const { argv, exit, write, read, getcwd, open, close, stat, O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC } = globalThis.ecmaosSyscalls

const usage = `Usage: split [OPTION]... [INPUT [PREFIX]]
Split INPUT into fixed-size pieces.

  -l, -lNUMBER        put NUMBER lines per output file
  -b, -bSIZE            put SIZE bytes per output file
  --help                 display this help and exit`

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

function writeWholeFile(fullPath, bytes) {
  const fd = open(fullPath, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
  try {
    globalThis.ecmaosSyscalls.write(fd, bytes)
  } finally {
    close(fd)
  }
}

function getSuffix(index) {
  const first = Math.floor(index / 26)
  const second = index % 26
  return String.fromCharCode(97 + first) + String.fromCharCode(97 + second)
}

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    write(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  let file = ''
  let lines
  let bytes
  let prefix = 'x'

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-l' || arg.startsWith('-l')) {
      if (arg === '-l' && i + 1 < args.length) lines = parseInt(args[++i], 10)
      else if (arg.length > 2) lines = parseInt(arg.slice(2), 10)
    } else if (arg === '-b' || arg.startsWith('-b')) {
      if (arg === '-b' && i + 1 < args.length) bytes = parseInt(args[++i], 10)
      else if (arg.length > 2) bytes = parseInt(arg.slice(2), 10)
    } else if (!arg.startsWith('-')) {
      if (!file) file = arg
      else if (prefix === 'x') prefix = arg
    }
  }

  if (!file) {
    write(2, new TextEncoder().encode('split: missing file operand\n'))
    return 1
  }
  if (!lines && !bytes) {
    write(2, new TextEncoder().encode('split: you must specify -l or -b\n'))
    return 1
  }

  const cwd = getcwd()
  const fullPath = resolve(cwd, file)

  try {
    const data = readWholeFile(fullPath)
    const dir = dirname(fullPath)
    let fileIndex = 0

    if (lines) {
      const content = new TextDecoder().decode(data)
      const allLines = content.split('\n')
      for (let i = 0; i < allLines.length; i += lines) {
        const chunk = allLines.slice(i, i + lines).join('\n')
        const outputPath = join(dir, `${prefix}${getSuffix(fileIndex)}`)
        writeWholeFile(outputPath, new TextEncoder().encode(chunk))
        fileIndex++
      }
    } else if (bytes) {
      for (let i = 0; i < data.length; i += bytes) {
        const chunk = data.slice(i, i + bytes)
        const outputPath = join(dir, `${prefix}${getSuffix(fileIndex)}`)
        writeWholeFile(outputPath, chunk)
        fileIndex++
      }
    }

    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    write(2, new TextEncoder().encode(`split: ${file}: ${message}\n`))
    return 1
  }
}

try {
  exit(main())
} catch (error) {
  write(2, new TextEncoder().encode(`split: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
