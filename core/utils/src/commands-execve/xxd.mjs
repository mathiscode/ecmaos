/**
 * Real `execve`'d `xxd` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/xxd.ts`) per `feat/1.0.0-execve-commands`. See `head.mjs`'s doc comment
 * for why there's no in-band interrupt handling anymore. `ctx.process?.stdinIsTTY`'s check (refuse
 * to read from an interactive terminal with no piped input) has no real analogue for a worker-hosted
 * process reading fd 0 directly -- `read(0, ...)` on a real TTY-backed fd would simply block/return
 * per the tty's own semantics, so this keeps only the "stdin produced zero bytes" usage-error case.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, write, read, getcwd, open, close, stat, isDirectory, O_RDONLY } = globalThis.ecmaosSyscalls

const usage = `Usage: xxd [FILE]
Display file contents or stdin in hexadecimal format.

  FILE    the file to display (if omitted, reads from stdin)
  --help  display this help and exit`

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

function formatDump(data) {
  const bytesPerLine = 16
  let output = ''

  for (let offset = 0; offset < data.length; offset += bytesPerLine) {
    const lineBytes = data.slice(offset, offset + bytesPerLine)
    const offsetHex = offset.toString(16).padStart(8, '0')

    const hexGroups = []
    const asciiChars = []

    for (let i = 0; i < bytesPerLine; i++) {
      if (i < lineBytes.length) {
        const byte = lineBytes[i]
        const hex = byte.toString(16).padStart(2, '0')
        if (i % 2 === 0) hexGroups.push(hex)
        else hexGroups[hexGroups.length - 1] += hex
        asciiChars.push(byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.')
      } else {
        if (i % 2 === 0) hexGroups.push('  ')
        else hexGroups[hexGroups.length - 1] += '  '
        asciiChars.push(' ')
      }
    }

    const hexString = hexGroups.join(' ').padEnd(47, ' ')
    output += `${offsetHex}: ${hexString}  ${asciiChars.join('')}\n`
  }

  return output
}

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    write(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  const filePath = args.length > 0 && !args[0].startsWith('-') ? args[0] : undefined
  let data

  const usageError = () => {
    write(2, new TextEncoder().encode('Usage: xxd <file>\n'))
    write(2, new TextEncoder().encode('   or: <command> | xxd\n'))
    return 1
  }

  try {
    if (!filePath) {
      data = readAllStdin()
      if (data.length === 0) return usageError()
    } else {
      const cwd = getcwd()
      const fullPath = resolve(cwd, filePath)
      if (isDirectory(fullPath)) {
        write(2, new TextEncoder().encode(`xxd: ${filePath}: Is a directory\n`))
        return 1
      }
      data = readWholeFile(fullPath)
    }

    write(1, new TextEncoder().encode(formatDump(data)))
    return 0
  } catch (error) {
    const errorPath = filePath || 'stdin'
    const message = error instanceof Error ? error.message : String(error)
    const reason = message.includes('ENOENT') ? 'No such file or directory' : message
    write(2, new TextEncoder().encode(`xxd: ${errorPath}: ${reason}\n`))
    return 1
  }
}

try {
  exit(main())
} catch (error) {
  write(2, new TextEncoder().encode(`xxd: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
