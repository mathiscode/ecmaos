/** Display a file in hexadecimal: `hexdump -C file`. */

import { readFdBytes, readFileBytes } from './lib/bytes.mjs'
import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, getcwd } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`hexdump: ${text}\n`))

const usage = `Usage: hexdump [OPTION]... [FILE]...
Display the content of FILEs (standard input by default) in hexadecimal.

  -C, --canonical        hex bytes beside their printable characters
  -n, --length=N         read only N bytes
  -s, --skip=N           skip N bytes at the start
  -v, --no-squeezing     show every line, not a * for each run of repeats
  --help                 display this help and exit

Without -C the bytes are shown as 16-bit words, in the byte order of this machine (little endian).`

const hex = (n, width) => n.toString(16).padStart(width, '0')

function main() {
  const args = argv.slice(1)
  let canonical = false
  let length
  let skip = 0
  let squeeze = true
  const files = []
  const number = (name, text) => { const value = Number(text); if (!Number.isInteger(value) || value < 0) throw new Error(`invalid ${name} '${text}'`); return value }
  try {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (arg === '--help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
      if (arg === '-C' || arg === '--canonical') canonical = true
      else if (arg === '-v' || arg === '--no-squeezing') squeeze = false
      else if (arg === '-n' || arg === '--length') length = number('length', args[++i])
      else if (arg.startsWith('--length=')) length = number('length', arg.slice(9))
      else if (/^-n\d+$/.test(arg)) length = number('length', arg.slice(2))
      else if (arg === '-s' || arg === '--skip') skip = number('offset', args[++i])
      else if (arg.startsWith('--skip=')) skip = number('offset', arg.slice(7))
      else if (/^-s\d+$/.test(arg)) skip = number('offset', arg.slice(2))
      else if (arg === '-' || !arg.startsWith('-')) files.push(arg)
      else { err(`invalid option -- '${arg.replace(/^-+/, '')}'`); return 1 }
    }
  } catch (error) { err(error.message); return 1 }

  const cwd = getcwd()
  const chunks = []
  let status = 0
  for (const file of files.length ? files : ['-']) {
    try { chunks.push(file === '-' ? readFdBytes(0) : readFileBytes(resolve(cwd, file))) } catch (error) { err(`${file}: ${error?.message ?? error}`); status = 1 }
  }
  let bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let at = 0
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length }
  bytes = bytes.subarray(skip, length === undefined ? undefined : skip + length)
  if (bytes.length === 0) return status

  const lines = []
  let previous
  let squeezing = false
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const row = bytes.subarray(offset, offset + 16)
    const key = Array.from(row).join(',')
    if (squeeze && previous === key && row.length === 16) {
      if (!squeezing) { lines.push('*'); squeezing = true }
      continue
    }
    squeezing = false
    previous = key
    const at = skip + offset
    if (canonical) {
      const left = Array.from(row.subarray(0, 8), b => hex(b, 2)).join(' ')
      const right = Array.from(row.subarray(8), b => hex(b, 2)).join(' ')
      const text = Array.from(row, b => b >= 32 && b < 127 ? String.fromCharCode(b) : '.').join('')
      lines.push(`${hex(at, 8)}  ${left.padEnd(23)}  ${right.padEnd(23)}  |${text}|`)
    } else {
      const words = []
      for (let i = 0; i < row.length; i += 2) words.push(hex(row.length - i >= 2 ? row[i] | (row[i + 1] << 8) : row[i], 4))
      lines.push(`${hex(at, 7)} ${words.join(' ')}`)
    }
  }
  const end = skip + bytes.length
  lines.push(canonical ? hex(end, 8) : hex(end, 7))
  writeAll(1, encoder.encode(lines.join('\n') + '\n'))
  return status
}

try {
  exit(main())
} catch (error) {
  err(error?.message ?? String(error))
  exit(1)
}
