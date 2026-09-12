/**
 * Real `execve`'d `od` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/od.ts`) per `feat/1.0.0-execve-commands`. See `head.mjs`'s doc comment
 * for why there's no in-band interrupt handling and no `/dev`-path special case anymore.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, write, read, getcwd, open, close, O_RDONLY } = globalThis.ecmaosSyscalls

const usage = `Usage: od [OPTION]... [FILE]...
Dump files in octal and other formats.

  -A, --address-radix=RADIX  address format: d (decimal), o (octal), x (hex), n (none)
  -t, --format=TYPE          output format: o (octal), x (hex), d (decimal), u (unsigned), c (char), a (named char)
  -N, --read-bytes=BYTES     limit number of bytes to read
  -j, --skip-bytes=BYTES     skip bytes before reading
  --help                     display this help and exit`

function formatAddress(offset, radix) {
  switch (radix) {
    case 'd': return offset.toString(10).padStart(7, '0')
    case 'o': return offset.toString(8).padStart(7, '0')
    case 'x': return offset.toString(16).padStart(7, '0')
    case 'n': return ''
    default: return offset.toString(8).padStart(7, '0')
  }
}

function formatByte(byte, format) {
  switch (format) {
    case 'o': case 'o1': return byte.toString(8).padStart(3, '0')
    case 'x': case 'x1': return byte.toString(16).padStart(2, '0')
    case 'd': case 'd1': return byte.toString(10).padStart(3, '0')
    case 'u': case 'u1': return byte.toString(10).padStart(3, '0')
    case 'c':
      if (byte >= 32 && byte <= 126) return `'${String.fromCharCode(byte)}'`
      if (byte === 0) return '\\0'
      if (byte === 7) return '\\a'
      if (byte === 8) return '\\b'
      if (byte === 9) return '\\t'
      if (byte === 10) return '\\n'
      if (byte === 11) return '\\v'
      if (byte === 12) return '\\f'
      if (byte === 13) return '\\r'
      return `\\${byte.toString(8).padStart(3, '0')}`
    case 'a':
      return byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.'
    default:
      return byte.toString(8).padStart(3, '0')
  }
}

function formatLine(data, offset, addressRadix, format) {
  const address = formatAddress(offset, addressRadix)
  const bytes = []
  const ascii = []

  for (let i = 0; i < data.length; i++) {
    const byte = data[i]
    bytes.push(formatByte(byte, format))
    ascii.push(byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.')
  }

  let result = address ? `${address}: ` : ''
  result += bytes.join(' ')
  if (format !== 'c' && format !== 'a') result += '  ' + ascii.join('')

  return result
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
  const { stat } = globalThis.ecmaosSyscalls
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

  let addressRadix = 'o'
  let format = 'o1'
  let readBytes = null
  let skipBytes = 0
  const files = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-A' || arg === '--address-radix') {
      if (i + 1 < args.length) {
        const radix = args[++i]
        if (radix && ['d', 'o', 'x', 'n'].includes(radix)) addressRadix = radix
        else { write(2, new TextEncoder().encode(`od: invalid address radix: ${radix}\n`)); return 1 }
      }
    } else if (arg.startsWith('--address-radix=')) {
      const radix = arg.slice(16)
      if (['d', 'o', 'x', 'n'].includes(radix)) addressRadix = radix
      else { write(2, new TextEncoder().encode(`od: invalid address radix: ${radix}\n`)); return 1 }
    } else if (arg.startsWith('-A')) {
      const radix = arg.slice(2)
      if (['d', 'o', 'x', 'n'].includes(radix)) addressRadix = radix
      else { write(2, new TextEncoder().encode(`od: invalid address radix: ${radix}\n`)); return 1 }
    } else if (arg === '-t' || arg === '--format') {
      if (i + 1 < args.length) { const fmt = args[++i]; if (fmt) format = fmt }
    } else if (arg.startsWith('--format=')) {
      format = arg.slice(9)
    } else if (arg.startsWith('-t')) {
      format = arg.slice(2) || 'o1'
    } else if (arg === '-N' || arg === '--read-bytes') {
      if (i + 1 < args.length) {
        const parsed = parseInt(args[++i], 10)
        if (!isNaN(parsed) && parsed > 0) readBytes = parsed
        else { write(2, new TextEncoder().encode(`od: invalid byte count: ${args[i]}\n`)); return 1 }
      }
    } else if (arg.startsWith('--read-bytes=')) {
      const bytesStr = arg.slice(13)
      const parsed = parseInt(bytesStr, 10)
      if (!isNaN(parsed) && parsed > 0) readBytes = parsed
      else { write(2, new TextEncoder().encode(`od: invalid byte count: ${bytesStr}\n`)); return 1 }
    } else if (arg.startsWith('-N')) {
      const bytesStr = arg.slice(2)
      const parsed = parseInt(bytesStr, 10)
      if (!isNaN(parsed) && parsed > 0) readBytes = parsed
      else { write(2, new TextEncoder().encode(`od: invalid byte count: ${bytesStr}\n`)); return 1 }
    } else if (arg === '-j' || arg === '--skip-bytes') {
      if (i + 1 < args.length) {
        const parsed = parseInt(args[++i], 10)
        if (!isNaN(parsed) && parsed >= 0) skipBytes = parsed
        else { write(2, new TextEncoder().encode(`od: invalid skip count: ${args[i]}\n`)); return 1 }
      }
    } else if (arg.startsWith('--skip-bytes=')) {
      const bytesStr = arg.slice(13)
      const parsed = parseInt(bytesStr, 10)
      if (!isNaN(parsed) && parsed >= 0) skipBytes = parsed
      else { write(2, new TextEncoder().encode(`od: invalid skip count: ${bytesStr}\n`)); return 1 }
    } else if (arg.startsWith('-j')) {
      const bytesStr = arg.slice(2)
      const parsed = parseInt(bytesStr, 10)
      if (!isNaN(parsed) && parsed >= 0) skipBytes = parsed
      else { write(2, new TextEncoder().encode(`od: invalid skip count: ${bytesStr}\n`)); return 1 }
    } else if (!arg.startsWith('-')) {
      files.push(arg)
    } else {
      write(2, new TextEncoder().encode(`od: invalid option -- '${arg.slice(1)}'\n`))
      write(2, new TextEncoder().encode("Try 'od --help' for more information.\n"))
      return 1
    }
  }

  let data

  if (files.length === 0) {
    data = readAllStdin()
  } else {
    const file = files[0]
    const cwd = getcwd()
    const fullPath = resolve(cwd, file)
    try {
      data = readWholeFile(fullPath)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      write(2, new TextEncoder().encode(`od: ${file}: ${message}\n`))
      return 1
    }
  }

  if (skipBytes > 0) {
    if (skipBytes >= data.length) return 0
    data = data.slice(skipBytes)
  }

  if (readBytes !== null && readBytes < data.length) data = data.slice(0, readBytes)

  const bytesPerLine = 16
  let offset = 0
  let output = ''

  while (offset < data.length) {
    const lineData = data.slice(offset, offset + bytesPerLine)
    output += formatLine(lineData, offset + skipBytes, addressRadix, format) + '\n'
    offset += lineData.length
  }
  write(1, new TextEncoder().encode(output))

  return 0
}

try {
  exit(main())
} catch (error) {
  write(2, new TextEncoder().encode(`od: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
