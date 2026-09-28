/** Concatenate files and print them to stdout. `^C` kills the process outright, like a real `cat`. */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, read, getcwd, open, close, stat, isDirectory, O_RDONLY } = globalThis.ecmaosSyscalls

const usage = `Usage: cat [OPTION]... [FILE]...
Concatenate files and print on the standard output.

  --help  display this help and exit`

/**
 * Loops until a real EOF (`n <= 0`), never on a short read -- a pipe can legitimately return fewer
 * bytes than asked for mid-stream, not just at EOF. Breaking early on `n < chunkSize` would silently
 * truncate stdin read from a pipe.
 */
function readAllStdin() {
  const chunkSize = 65536
  const chunks = []
  while (true) {
    const buffer = new Uint8Array(chunkSize)
    const n = read(0, buffer, -1)
    if (n <= 0) break
    chunks.push(buffer.subarray(0, n))
  }
  return chunks
}

function catFile(fullPath) {
  if (isDirectory(fullPath)) {
    writeAll(2, new TextEncoder().encode(`cat: ${fullPath}: Is a directory\n`))
    return false
  }

  const size = stat(fullPath).size
  const fd = open(fullPath, O_RDONLY)
  const chunkSize = 65536
  try {
    let bytesRead = 0
    while (bytesRead < size) {
      const buffer = new Uint8Array(Math.min(chunkSize, size - bytesRead))
      const n = read(fd, buffer, -1)
      if (n <= 0) break
      writeAll(1, buffer.subarray(0, n))
      bytesRead += n
    }
  } finally {
    close(fd)
  }
  return true
}

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    writeAll(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  const files = args.filter(arg => !arg.startsWith('-'))

  if (files.length === 0) {
    for (const chunk of readAllStdin()) writeAll(1, chunk)
    return 0
  }

  const cwd = getcwd()
  let hasError = false

  for (const file of files) {
    const fullPath = resolve(cwd, file)
    try {
      if (!catFile(fullPath)) hasError = true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const reason = message.includes('ENOENT') ? 'No such file or directory'
        : message.includes('EACCES') ? 'Permission denied'
        : message
      writeAll(2, new TextEncoder().encode(`cat: ${file}: ${reason}\n`))
      hasError = true
    }
  }

  return hasError ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`cat: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
