/**
 * Pause for a time, as GNU `sleep` does: each NUMBER is a decimal (`1.5`, `.5`, `1e-3`), a hexadecimal (`0x1`) or
 * `inf`, optionally followed by `s`, `m`, `h` or `d`, and the NUMBERs add up. A signal ends the process, as it does a
 * real `sleep`.
 */

import { getopt, tryHelp } from './lib/getopt.mjs'

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`sleep: ${text}\n`))
const hint = () => writeAll(2, encoder.encode(tryHelp('sleep') + '\n'))

const usage = `Usage: sleep NUMBER[SUFFIX]...
  or:  sleep OPTION
Pause for NUMBER seconds.  SUFFIX may be 's' for seconds (the default),
'm' for minutes, 'h' for hours or 'd' for days.  NUMBER need not be an
integer.  Given two or more arguments, pause for the amount of time
specified by the sum of their values.

      --help        display this help and exit
      --version     output version information and exit
`

/** Seconds named by `text` (no suffix), or `undefined` */
function parseNumber(text) {
  if (/^[+]?(inf|infinity)$/i.test(text)) return Infinity
  if (/^[+]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return Number(text)
  const hex = /^[+]?0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?(?:[pP]([+-]?\d+))?$/.exec(text)
  if (hex && (hex[1] || hex[2])) {
    let value = hex[1] ? parseInt(hex[1], 16) : 0
    if (hex[2]) value += parseInt(hex[2], 16) / 16 ** hex[2].length
    return value * 2 ** Number(hex[3] ?? 0)
  }
  return undefined
}

function parseInterval(text) {
  const whole = parseNumber(text)
  if (whole !== undefined) return whole
  const unit = { s: 1, m: 60, h: 3600, d: 86400 }[text.slice(-1)]
  if (unit === undefined || text.length < 2) return undefined
  const value = parseNumber(text.slice(0, -1))
  return value === undefined ? undefined : value * unit
}

async function main() {
  const { options, operands, error } = getopt(argv.slice(1), { short: '', long: { help: 'help', version: 'version' } })
  if (error) { err(error); hint(); return 1 }
  if (options.some(([key]) => key === 'help')) { out(usage); return 0 }
  if (options.some(([key]) => key === 'version')) { out('sleep (ecmaOS coreutils) 1.0\n'); return 0 }
  if (operands.length === 0) { err('missing operand'); hint(); return 1 }

  let seconds = 0
  let bad = false
  for (const operand of operands) {
    const value = parseInterval(operand)
    if (value === undefined) { err(`invalid time interval ‘${operand}’`); bad = true; continue }
    seconds += value
  }
  if (bad) { hint(); return 1 }

  let remaining = seconds * 1000
  while (remaining > 0) {
    const step = Math.min(remaining, 2 ** 30)
    await new Promise(resolve => setTimeout(resolve, step))
    remaining -= step
  }
  return 0
}

try {
  exit(await main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
