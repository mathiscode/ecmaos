/**
 * Real `execve`'d `shuf` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/shuf.ts`) per `feat/1.0.0-execve-commands`. `Math.random()` is available
 * everywhere including workers. See `head.mjs`'s doc comment for why there's no in-band interrupt
 * handling and no `/dev`-path special case anymore.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, write, read, getcwd, open, close, stat, O_RDONLY } = globalThis.ecmaosSyscalls

const usage = `Usage: shuf [OPTION]... [FILE]
Write a random permutation of the input lines to standard output.

  -n, --head-count=COUNT    output at most COUNT lines
  -e, --echo                treat each ARG as an input line
  -i, --input-range=LO-HI   treat each number LO through HI as an input line
  --help                    display this help and exit`

function shuffleArray(array) {
  const shuffled = [...array]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
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

  let headCount = null
  let echo = false
  let inputRange
  const files = []
  const echoArgs = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-n' || arg === '--head-count') {
      if (i + 1 < args.length) {
        const parsed = parseInt(args[++i], 10)
        if (!isNaN(parsed) && parsed > 0) headCount = parsed
        else { write(2, new TextEncoder().encode(`shuf: invalid line count: ${args[i]}\n`)); return 1 }
      }
    } else if (arg.startsWith('--head-count=')) {
      const countStr = arg.slice(13)
      const parsed = parseInt(countStr, 10)
      if (!isNaN(parsed) && parsed > 0) headCount = parsed
      else { write(2, new TextEncoder().encode(`shuf: invalid line count: ${countStr}\n`)); return 1 }
    } else if (arg.startsWith('-n')) {
      const countStr = arg.slice(2)
      if (countStr) {
        const parsed = parseInt(countStr, 10)
        if (!isNaN(parsed) && parsed > 0) headCount = parsed
        else { write(2, new TextEncoder().encode(`shuf: invalid line count: ${countStr}\n`)); return 1 }
      }
    } else if (arg === '-e' || arg === '--echo') {
      echo = true
    } else if (arg === '-i' || arg === '--input-range') {
      if (i + 1 < args.length) inputRange = args[++i]
    } else if (arg.startsWith('--input-range=')) {
      inputRange = arg.slice(15)
    } else if (arg.startsWith('-i')) {
      inputRange = arg.slice(2)
    } else if (!arg.startsWith('-')) {
      if (echo) echoArgs.push(arg)
      else files.push(arg)
    } else {
      write(2, new TextEncoder().encode(`shuf: invalid option -- '${arg.slice(1)}'\n`))
      write(2, new TextEncoder().encode("Try 'shuf --help' for more information.\n"))
      return 1
    }
  }

  let lines = []

  if (inputRange) {
    const [loStr, hiStr] = inputRange.split('-')
    const lo = parseInt(loStr ?? '0', 10)
    const hi = parseInt(hiStr ?? '0', 10)
    if (isNaN(lo) || isNaN(hi) || lo > hi) {
      write(2, new TextEncoder().encode(`shuf: invalid input range: ${inputRange}\n`))
      return 1
    }
    for (let i = lo; i <= hi; i++) lines.push(i.toString())
  } else if (echo && echoArgs.length > 0) {
    lines = echoArgs
  } else if (files.length === 0) {
    lines = splitLines(readAllStdin())
  } else {
    const cwd = getcwd()
    for (const file of files) {
      try {
        lines.push(...splitLines(readWholeFileText(resolve(cwd, file))))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        write(2, new TextEncoder().encode(`shuf: ${file}: ${message}\n`))
      }
    }
  }

  const shuffled = shuffleArray(lines)
  const output = headCount !== null ? shuffled.slice(0, headCount) : shuffled

  let text = ''
  for (const line of output) text += line + '\n'
  write(1, new TextEncoder().encode(text))

  return 0
}

try {
  exit(main())
} catch (error) {
  write(2, new TextEncoder().encode(`shuf: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
