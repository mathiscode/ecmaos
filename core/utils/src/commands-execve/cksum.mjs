/**
 * Real `execve`'d `cksum` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/cksum.ts`) per `feat/1.0.0-execve-commands`. See `head.mjs`'s doc comment
 * for why there's no in-band interrupt handling and no `/dev`-path special case anymore. The CRC-32
 * algorithm itself (not real POSIX cksum's actual CRC variant) is unchanged from the original --
 * this is a migration, not a correctness fix.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, write, read, getcwd, open, close, stat, O_RDONLY } = globalThis.ecmaosSyscalls

const usage = `Usage: cksum [FILE]...
Print CRC checksum and byte count for each FILE.

If no FILE is specified, or if FILE is -, read standard input.

  --help  display this help and exit`

function calculateCRC32(data) {
  let crc = 0xffffffff
  const polynomial = 0xedb88320

  for (let i = 0; i < data.length; i++) {
    const byte = data[i]
    crc ^= byte
    for (let j = 0; j < 8; j++) {
      if (crc & 1) crc = (crc >>> 1) ^ polynomial
      else crc = crc >>> 1
    }
  }

  return (crc ^ 0xffffffff) >>> 0
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

  const files = []
  for (const arg of args) {
    if (!arg.startsWith('-')) {
      files.push(arg)
    } else {
      write(2, new TextEncoder().encode(`cksum: invalid option -- '${arg.slice(1)}'\n`))
      write(2, new TextEncoder().encode("Try 'cksum --help' for more information.\n"))
      return 1
    }
  }

  if (files.length === 0) {
    const data = readAllStdin()
    const crc = calculateCRC32(data)
    write(1, new TextEncoder().encode(`${crc} ${data.length}\n`))
    return 0
  }

  const cwd = getcwd()
  let hasError = false

  for (const file of files) {
    const fullPath = resolve(cwd, file)
    try {
      const bytes = readWholeFile(fullPath)
      const crc = calculateCRC32(bytes)
      write(1, new TextEncoder().encode(`${crc} ${bytes.length} ${file}\n`))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      write(2, new TextEncoder().encode(`cksum: ${file}: ${message}\n`))
      hasError = true
    }
  }

  return hasError ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  write(2, new TextEncoder().encode(`cksum: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
