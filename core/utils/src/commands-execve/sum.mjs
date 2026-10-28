/** `sum`: print the BSD (`-r`, the default) or System V (`-s`) checksum of each file and its size in blocks. */

import { reasonOf } from './lib/errno.mjs'
import { readFdBytes, readFileBytes } from './lib/bytes.mjs'

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`sum: ${text}\n`))

const usage = `Usage: sum [OPTION]... [FILE]...
Print or check BSD (16-bit) checksums.

With no FILE, or when FILE is -, read standard input.

  -r              use BSD sum algorithm (the default), use 1K blocks
  -s, --sysv      use System V sum algorithm, use 512 bytes blocks
      --help        display this help and exit
      --version     output version information and exit`

function bsd(bytes) {
  let sum = 0
  for (const byte of bytes) sum = (((sum >> 1) + ((sum & 1) << 15)) + byte) & 0xffff
  return { sum, blocks: Math.ceil(bytes.length / 1024) }
}

function sysv(bytes) {
  let total = 0
  for (const byte of bytes) total = (total + byte) >>> 0
  const r = (total & 0xffff) + ((total >>> 16) & 0xffff)
  return { sum: (r & 0xffff) + (r >>> 16), blocks: Math.ceil(bytes.length / 512) }
}

function main() {
  let algorithm = 'bsd'
  const files = []
  for (const arg of argv.slice(1)) {
    if (arg === '--help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (arg === '--version') { writeAll(1, encoder.encode('sum (ecmaOS coreutils) 1.0\n')); return 0 }
    if (arg === '-r') algorithm = 'bsd'
    else if (arg === '-s' || arg === '--sysv') algorithm = 'sysv'
    else if (arg.startsWith('-') && arg !== '-') { err(`invalid option -- '${arg.replace(/^-+/, '')}'`); writeAll(2, encoder.encode("Try 'sum --help' for more information.\n")); return 1 }
    else files.push(arg)
  }
  if (files.length === 0) files.push('-')
  let status = 0
  for (const file of files) {
    let bytes
    try { bytes = file === '-' ? readFdBytes(0) : readFileBytes(file) } catch (e) { err(`${file}: ${reasonOf(e)}`); status = 1; continue }
    const { sum, blocks } = algorithm === 'bsd' ? bsd(bytes) : sysv(bytes)
    const name = files.length > 1 || file !== '-' ? ` ${file}` : ''
    writeAll(1, encoder.encode(algorithm === 'bsd' ? `${String(sum).padStart(5, '0')} ${String(blocks).padStart(5)}${name}\n` : `${sum} ${blocks}${name}\n`))
  }
  return status
}

try {
  exit(main())
} catch (error) {
  err(reasonOf(error))
  exit(1)
}
