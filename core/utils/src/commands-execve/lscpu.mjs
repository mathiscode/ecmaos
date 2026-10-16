/** Describe the processor as far as a browser tells: the core count and what the page can see of the platform. */

import { readTextFile } from './lib/fs-text.mjs'

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(text + '\n'))

const usage = `Usage: lscpu
Show the processor information the browser reports.

  --help  display this help and exit

A browser does not say the processor's model, speed or caches, so those lines are left out rather than guessed.`

function main() {
  if (argv.includes('--help') || argv.includes('-h')) { globalThis.ecmaosSyscalls.writeAll(1, new TextEncoder().encode(usage + '\n')); return 0 }
  if (argv.length > 1) { err(`lscpu: unknown option '${argv[1]}'`); return 1 }

  let stanzas = []
  try {
    stanzas = readTextFile('/proc/cpuinfo').split('\n\n').filter(Boolean)
  } catch { /* no cpuinfo */ }
  const first = {}
  for (const line of (stanzas[0] ?? '').split('\n')) {
    const at = line.indexOf(':')
    if (at > 0) first[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }

  const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1
  const rows = [
    ['Byte Order:', littleEndian ? 'Little Endian' : 'Big Endian'],
    ['CPU(s):', String(stanzas.length || 1)],
    ['Vendor ID:', first.vendor_id],
    ['Model name:', first['model name']]
  ].filter(([, value]) => value)
  const width = Math.max(...rows.map(([key]) => key.length)) + 1
  writeAll(1, encoder.encode(rows.map(([key, value]) => `${key.padEnd(width)} ${value}`).join('\n') + '\n'))
  return 0
}

try {
  exit(main())
} catch (error) {
  err(`lscpu: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
