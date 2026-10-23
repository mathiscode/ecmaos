/** Print the kernel's log, read from `/var/log/kernel.log.1` (what the log held before it last grew past its limit) and `/var/log/kernel.log`. */

import { readTextFile } from './lib/fs-text.mjs'

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(text + '\n'))

const usage = `Usage: dmesg [-l LEVEL[,LEVEL]...] [-n COUNT]
Print the kernel log, oldest first.

  -l, --level=LIST  only these levels: silly, trace, debug, info, warn, error, fatal
  -n, --last=COUNT  only the last COUNT lines
  --help            display this help and exit

The log is /var/log/kernel.log, after /var/log/kernel.log.1 when the log has been
rotated; each line is a time, a level in brackets and the message.`

function main() {
  const args = argv.slice(1)
  let levels
  let last
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const value = () => arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++i]
    if (arg === '--help' || arg === '-h') { globalThis.ecmaosSyscalls.writeAll(1, new TextEncoder().encode(usage + '\n')); return 0 }
    else if (arg === '-l' || arg.startsWith('--level')) levels = new Set(String(value()).toLowerCase().split(','))
    else if (arg === '-n' || arg.startsWith('--last')) last = Number(value())
    else { err(`dmesg: unknown option '${arg}'`); err("Try 'dmesg --help' for more information."); return 1 }
  }
  if (last !== undefined && !(last >= 0)) { err('dmesg: the count must be a number'); return 1 }

  let text
  try {
    text = readTextFile('/var/log/kernel.log')
  } catch {
    err('dmesg: cannot read /var/log/kernel.log')
    return 1
  }
  // the older half, there once the log has grown past its limit
  try { text = readTextFile('/var/log/kernel.log.1') + text } catch { /* not rotated yet */ }

  let lines = text.split('\n').filter(line => line.trim() !== '')
  if (levels) lines = lines.filter(line => levels.has((/\[(\w+)\]/.exec(line)?.[1] ?? '').toLowerCase()))
  if (last !== undefined) lines = last === 0 ? [] : lines.slice(-last)
  if (lines.length) writeAll(1, encoder.encode(lines.join('\n') + '\n'))
  return 0
}

try {
  exit(main())
} catch (error) {
  err(`dmesg: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
