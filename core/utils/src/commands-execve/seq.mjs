/**
 * Print a sequence of numbers, as GNU `seq` does: `seq LAST`, `seq FIRST LAST`, `seq FIRST INCREMENT LAST`. The numbers have as
 * many decimals as FIRST and INCREMENT, `-w` pads them with zeros to a common width, `-f` formats them with a printf float
 * format, and `-s` sets the separator.
 */

import { formatPrintf } from '../lib/printf-format.ts'

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`seq: ${text}\n`))

const usage = `Usage: seq [OPTION]... LAST
  or:  seq [OPTION]... FIRST LAST
  or:  seq [OPTION]... FIRST INCREMENT LAST
Print numbers from FIRST to LAST, in steps of INCREMENT.

  -f, --format=FORMAT      use printf style floating-point FORMAT
  -s, --separator=STRING   use STRING to separate numbers (default: \\n)
  -w, --equal-width        equalize width by padding with leading zeroes
  --help                   display this help and exit

If FIRST or INCREMENT is omitted, it defaults to 1. That is, an omitted INCREMENT defaults to 1 even when LAST is smaller than FIRST.`

const isNumber = text => /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(text) || /^0[xX][0-9a-fA-F]+$/.test(text)
const decimals = text => {
  if (/^0[xX]/.test(text) || /[eE]/.test(text)) return 0
  const dot = text.indexOf('.')
  return dot < 0 ? 0 : text.length - dot - 1
}

function main() {
  const args = argv.slice(1)
  let separator = '\n'
  let format
  let equalWidth = false
  const numbers = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (arg === '--') { numbers.push(...args.slice(i + 1)); break }
    // A negative number is an operand, not an option
    if (isNumber(arg)) { numbers.push(arg); continue }
    if (arg === '--equal-width') { equalWidth = true; continue }
    const long = /^--(separator|format)(?:=(.*))?$/.exec(arg)
    if (long) {
      const value = long[2] !== undefined ? long[2] : args[++i]
      if (value === undefined) { err(`option '--${long[1]}' requires an argument`); return 1 }
      if (long[1] === 'separator') separator = value
      else format = value
      continue
    }
    if (arg.startsWith('--') || !arg.startsWith('-') || arg === '-') {
      if (arg.startsWith('--')) { err(`unrecognized option '${arg}'`); err("Try 'seq --help' for more information."); return 1 }
      numbers.push(arg)
      continue
    }
    for (let c = 1; c < arg.length; c++) {
      const flag = arg[c]
      if (flag === 'w') equalWidth = true
      else if (flag === 's' || flag === 'f') {
        const value = c + 1 < arg.length ? arg.slice(c + 1) : args[++i]
        if (value === undefined) { err(`option requires an argument -- '${flag}'`); err("Try 'seq --help' for more information."); return 1 }
        if (flag === 's') separator = value
        else format = value
        break
      } else { err(`invalid option -- '${flag}'`); err("Try 'seq --help' for more information."); return 1 }
    }
  }

  if (numbers.length === 0) { err('missing operand'); err("Try 'seq --help' for more information."); return 1 }
  if (numbers.length > 3) { err(`extra operand '${numbers[3]}'`); err("Try 'seq --help' for more information."); return 1 }
  for (const text of numbers) {
    if (!isNumber(text)) { err(`invalid floating point argument: '${text}'`); err("Try 'seq --help' for more information."); return 1 }
  }

  const [firstText, stepText, lastText] = numbers.length === 1 ? ['1', '1', numbers[0]] : numbers.length === 2 ? [numbers[0], '1', numbers[1]] : numbers
  const first = Number(firstText)
  const step = Number(stepText)
  const last = Number(lastText)
  if (step === 0) { err(`invalid Zero increment value: '${stepText}'`); err("Try 'seq --help' for more information."); return 1 }

  const places = Math.max(decimals(firstText), decimals(stepText))
  const show = value => {
    if (format !== undefined) return formatPrintf(format, [String(value)])
    return Number.isInteger(value) && places === 0 ? String(value) : value.toFixed(places)
  }

  // Counted, not accumulated, so a fractional step does not drift
  const count = step > 0 ? Math.floor((last - first) / step + 1e-9) + 1 : Math.floor((first - last) / -step + 1e-9) + 1
  if (!(count > 0)) return 0

  let width = 0
  if (equalWidth && format === undefined) width = Math.max(show(first).length, show(first + (count - 1) * step).length)

  let out = ''
  for (let n = 0; n < count; n++) {
    let text = show(first + n * step)
    if (width && text.length < width) text = text.startsWith('-') ? '-' + text.slice(1).padStart(width - 1, '0') : text.padStart(width, '0')
    out += (n ? separator : '') + text
    if (out.length > 65536) { writeAll(1, encoder.encode(out)); out = '' }
  }
  writeAll(1, encoder.encode(out + '\n'))
  return 0
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
