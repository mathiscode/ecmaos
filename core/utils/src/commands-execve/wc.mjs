/**
 * Real `execve`'d `wc` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/wc.ts`) per `feat/1.0.0-execve-commands`. See `head.mjs`'s doc comment
 * for why there's no in-band interrupt handling and no `/dev`-path special case anymore.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, write, read, getcwd, open, close, stat, O_RDONLY } = globalThis.ecmaosSyscalls

const usage = `Usage: wc [OPTION]... [FILE]...
Print newline, word, and byte counts for each FILE.

  -c, --bytes     print the byte counts
  -l, --lines     print the newline counts
  -w, --words     print the word counts
  --help          display this help and exit`

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

function countText(content) {
  const lines = content.split('\n').length - (content.endsWith('\n') ? 0 : 1)
  const words = content.trim().split(/\s+/).filter(w => w.length > 0).length
  const bytes = new TextEncoder().encode(content).length
  return { lines, words, bytes }
}

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    write(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  const files = []
  let showBytes = false
  let showLines = false
  let showWords = false

  for (const arg of args) {
    if (arg === '-c' || arg === '--bytes') showBytes = true
    else if (arg === '-l' || arg === '--lines') showLines = true
    else if (arg === '-w' || arg === '--words') showWords = true
    else if (arg.startsWith('-') && arg !== '-') {
      const flags = arg.slice(1).split('')
      if (flags.includes('c')) showBytes = true
      if (flags.includes('l')) showLines = true
      if (flags.includes('w')) showWords = true
      const invalid = flags.find(f => !['c', 'l', 'w'].includes(f))
      if (invalid) {
        write(2, new TextEncoder().encode(`wc: invalid option -- '${invalid}'\n`))
        return 1
      }
    } else {
      files.push(arg)
    }
  }

  const showAll = !showBytes && !showLines && !showWords

  const formatCounts = (counts, label) => {
    let output = ''
    if (showAll || showLines) output += `${counts.lines} `
    if (showAll || showWords) output += `${counts.words} `
    if (showAll || showBytes) output += `${counts.bytes} `
    if (label !== undefined) output += label
    return output.trimEnd()
  }

  if (files.length === 0) {
    const content = readAllStdin()
    write(1, new TextEncoder().encode(formatCounts(countText(content)) + '\n'))
    return 0
  }

  const cwd = getcwd()
  let totalLines = 0
  let totalWords = 0
  let totalBytes = 0
  let hasError = false

  for (const file of files) {
    const fullPath = resolve(cwd, file)
    try {
      const content = readWholeFileText(fullPath)
      const counts = countText(content)
      totalLines += counts.lines
      totalWords += counts.words
      totalBytes += counts.bytes
      write(1, new TextEncoder().encode(formatCounts(counts, file) + '\n'))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      write(2, new TextEncoder().encode(`wc: ${file}: ${message}\n`))
      hasError = true
    }
  }

  if (files.length > 1) {
    write(1, new TextEncoder().encode(formatCounts({ lines: totalLines, words: totalWords, bytes: totalBytes }, 'total') + '\n'))
  }

  return hasError ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  write(2, new TextEncoder().encode(`wc: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
