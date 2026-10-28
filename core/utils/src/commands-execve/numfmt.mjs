/**
 * `numfmt`: convert numbers to and from human-readable sizes, as GNU numfmt does: `--to` and `--from` scale by 1000
 * (`si`) or 1024 (`iec`, `iec-i`), a scaled number under ten keeps one decimal, rounding is away from zero unless
 * `--round` says otherwise, and `--format`, `--padding`, `--suffix`, `--field`, `-d` and `--header` shape the output.
 * In the C locale `--grouping` changes nothing.
 */

import { getopt, tryHelp } from './lib/getopt.mjs'
import { reasonOf } from './lib/errno.mjs'
import { readFdText } from './lib/fs-text.mjs'

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`numfmt: ${text}\n`))

const usage = `Usage: numfmt [OPTION]... [NUMBER]...
Reformat NUMBER(s), or the numbers from standard input if none are specified.

      --debug          print warnings about invalid input
  -d, --delimiter=X    use X instead of whitespace for field delimiter
      --field=FIELDS   replace the numbers in these input fields (default=1)
      --format=FORMAT  use printf style floating-point FORMAT
      --from=UNIT      auto-scale input numbers to UNITs; default is 'none'
      --from-unit=N    specify the input unit size (instead of the default 1)
      --grouping       use locale-defined grouping of digits
      --header[=N]     print (without converting) the first N header lines
      --invalid=MODE   failure mode for invalid numbers: abort, fail, warn, ignore
      --padding=N      pad the output to N characters
      --round=METHOD   up, down, from-zero (default), towards-zero, nearest
      --suffix=SUFFIX  add SUFFIX to output numbers, and accept optional SUFFIX in input numbers
      --to=UNIT        auto-scale output numbers to UNITs
      --to-unit=N      the output unit size (instead of the default 1)
  -z, --zero-terminated    line delimiter is NUL, not newline
      --help        display this help and exit
      --version     output version information and exit

UNIT options:
  none       no auto-scaling is done; suffixes will trigger an error
  auto       accept optional single/two letter suffix: 1K = 1000, 1Ki = 1024
  si         accept optional single letter suffix: 1K = 1000
  iec        accept optional single letter suffix: 1K = 1024
  iec-i      accept optional two-letter suffix: 1Ki = 1024`

const LETTERS = ['', 'K', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y', 'R', 'Q']
const UNITS = ['none', 'auto', 'si', 'iec', 'iec-i']

class Invalid extends Error {}

/** A number as written, with its suffix taken by `from`, and how many decimals it was written with */
function parse(text, from, suffix) {
  let body = text.trim()
  if (suffix && body.endsWith(suffix)) body = body.slice(0, -suffix.length)
  const match = /^([-+]?(?:\d+\.?\d*|\.\d+))([A-Za-z]*)$/.exec(body)
  if (!match) throw new Invalid(/^[-+]?(\d|\.\d)/.test(body) ? `invalid suffix in input: ‘${text}’` : `invalid number: ‘${text}’`)
  const value = Number(match[1])
  const unit = match[2]
  if (!unit) return { value, decimals: (match[1].split('.')[1] ?? '').length }
  const letter = unit[0].toUpperCase()
  const power = LETTERS.indexOf(letter)
  const iec = unit.length === 2 && unit[1] === 'i'
  if (power <= 0 || unit.length > 2 || (unit.length === 2 && !iec)) throw new Invalid(`invalid suffix in input: ‘${text}’`)
  if (from === 'none') throw new Invalid(`rejecting suffix in input: ‘${text}’ (consider using --from)`)
  if (from === 'iec-i' && !iec) throw new Invalid(`missing 'i' suffix in input: ‘${text}’ (e.g. Ki/Mi/Gi)`)
  if ((from === 'si' || from === 'iec') && iec) throw new Invalid(`invalid suffix in input: ‘${text}’`)
  const base = from === 'si' || (from === 'auto' && !iec) ? 1000 : 1024
  return { value: value * base ** power, decimals: 0 }
}

function rounder(method) {
  return {
    up: Math.ceil,
    down: Math.floor,
    'from-zero': x => (x < 0 ? -Math.ceil(-x) : Math.ceil(x)),
    'towards-zero': Math.trunc,
    nearest: x => (x < 0 ? -Math.round(-x) : Math.round(x))
  }[method]
}

/** `%[flags][width][.precision]f` with text around it, as --format takes it */
function parseFormat(text) {
  const match = /^([^%]*)%([-0']*)(\d*)(?:\.(\d+))?f(.*)$/.exec(text)
  if (!match || match[5].includes('%')) return undefined
  return { prefix: match[1], left: match[2].includes('-'), zero: match[2].includes('0'), width: Number(match[3] || 0), precision: match[4] === undefined ? undefined : Number(match[4]), suffix: match[5] }
}

function format(value, decimals, o) {
  const round = rounder(o.round)
  let text
  if (o.to === 'none') {
    // as many decimals as the number was written with, rounded as --round says
    const digits = o.format?.precision ?? decimals
    const scaled = value / o.toUnit
    text = (round(scaled * 10 ** digits) / 10 ** digits).toFixed(digits)
  } else {
    const base = o.to === 'si' ? 1000 : 1024
    let x = value / o.toUnit
    let power = 0
    while (Math.abs(x) >= base && power < LETTERS.length - 1) { x /= base; power++ }
    let digits = o.format?.precision ?? (power > 0 && Math.abs(x) < 10 ? 1 : 0)
    let rounded = round(x * 10 ** digits) / 10 ** digits
    // 9.99k rounds to 10.0k, which is written 10k
    if (o.format?.precision === undefined && digits === 1 && Math.abs(rounded) >= 10) { digits = 0; rounded = round(x) }
    if (Math.abs(rounded) >= base && power < LETTERS.length - 1) {
      // 999.9k rounds to 1000k, which is 1.0M
      x = rounded / base
      power++
      digits = o.format?.precision ?? (Math.abs(x) < 10 ? 1 : 0)
      rounded = round(x * 10 ** digits) / 10 ** digits
    }
    const letter = power === 0 ? '' : o.to === 'si' ? (power === 1 ? 'k' : LETTERS[power]) : LETTERS[power] + (o.to === 'iec-i' ? 'i' : '')
    text = rounded.toFixed(digits) + letter
  }
  text += o.suffix
  const width = o.format?.width ?? 0
  if (o.format) {
    if (text.length < width) text = o.format.left ? text.padEnd(width) : o.format.zero && !/[a-zA-Z]/.test(text) ? (text.startsWith('-') ? '-' + text.slice(1).padStart(width - 1, '0') : text.padStart(width, '0')) : text.padStart(width)
    text = o.format.prefix + text + o.format.suffix
  }
  if (o.padding) text = o.padding < 0 ? text.padEnd(-o.padding) : text.padStart(o.padding)
  return text
}

/** `1`, `1,3`, `2-4`, `3-`, `-2`, `-`: whether a field number is chosen */
function fieldSet(text) {
  if (text === '-') return () => true
  const ranges = text.split(',').map(part => {
    const match = /^(\d*)-(\d*)$/.exec(part)
    if (match) return [match[1] ? Number(match[1]) : 1, match[2] ? Number(match[2]) : Infinity]
    if (/^\d+$/.test(part) && Number(part) > 0) return [Number(part), Number(part)]
    return undefined
  })
  if (ranges.some(range => !range)) return undefined
  return n => ranges.some(([a, b]) => n >= a && n <= b)
}

function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'd:z',
    long: {
      debug: 'debug', delimiter: { key: 'd', arg: 'required' }, field: { key: 'field', arg: 'required' }, format: { key: 'format', arg: 'required' },
      from: { key: 'from', arg: 'required' }, 'from-unit': { key: 'from-unit', arg: 'required' }, grouping: 'grouping', header: { key: 'header', arg: 'optional' },
      invalid: { key: 'invalid', arg: 'required' }, padding: { key: 'padding', arg: 'required' }, round: { key: 'round', arg: 'required' },
      suffix: { key: 'suffix', arg: 'required' }, to: { key: 'to', arg: 'required' }, 'to-unit': { key: 'to-unit', arg: 'required' }, 'zero-terminated': 'z', help: 'help', version: 'version'
    }
  })
  if (error) { err(error); writeAll(2, encoder.encode(tryHelp('numfmt') + '\n')); return 1 }
  const o = { from: 'none', to: 'none', fromUnit: 1, toUnit: 1, round: 'from-zero', suffix: '', padding: 0, format: undefined, fields: n => n === 1, delimiter: undefined, header: 0, invalid: 'abort', zero: false }
  const unitSize = (name, value) => {
    const n = /^\d+$/.test(value) ? Number(value) : (() => { try { return parse(value, 'auto', '').value } catch { return NaN } })()
    if (!(n > 0)) throw new Invalid(`invalid unit size: ‘${value}’`)
    return n
  }
  try {
    for (const [key, value] of options) {
      if (key === 'help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
      if (key === 'version') { writeAll(1, encoder.encode('numfmt (ecmaOS coreutils) 1.0\n')); return 0 }
      if (key === 'from' || key === 'to') {
        if (!UNITS.includes(value) || (key === 'to' && value === 'auto')) throw new Invalid(`invalid argument ‘${value}’ for ‘--${key}’`)
        o[key] = value
      } else if (key === 'from-unit') o.fromUnit = unitSize(key, value)
      else if (key === 'to-unit') o.toUnit = unitSize(key, value)
      else if (key === 'round') {
        if (!rounder(value)) throw new Invalid(`invalid argument ‘${value}’ for ‘--round’`)
        o.round = value
      } else if (key === 'suffix') o.suffix = value
      else if (key === 'padding') {
        if (!/^-?\d+$/.test(value) || Number(value) === 0) throw new Invalid(`invalid padding value ‘${value}’`)
        o.padding = Number(value)
      } else if (key === 'format') {
        o.format = parseFormat(value)
        if (!o.format) throw new Invalid(`invalid format ‘${value}’, directive must be %[0]['][-][N][.][N]f`)
      } else if (key === 'field') {
        o.fields = fieldSet(value)
        if (!o.fields) throw new Invalid(`invalid field value ‘${value}’`)
      } else if (key === 'd') {
        if ([...value].length !== 1) throw new Invalid('the delimiter must be a single character')
        o.delimiter = value
      } else if (key === 'header') {
        o.header = value === true ? 1 : Number(value)
        if (!Number.isInteger(o.header) || o.header < 1) throw new Invalid(`invalid header value ‘${value}’`)
      } else if (key === 'invalid') {
        if (!['abort', 'fail', 'warn', 'ignore'].includes(value)) throw new Invalid(`invalid argument ‘${value}’ for ‘--invalid’`)
        o.invalid = value
      } else if (key === 'z') o.zero = true
    }
  } catch (e) {
    err(e.message)
    return 1
  }

  let failed = false
  const convert = text => {
    try {
      const { value, decimals } = parse(text, o.from, o.suffix)
      return format(value * o.fromUnit, o.fromUnit === 1 ? decimals : 0, o)
    } catch (e) {
      if (!(e instanceof Invalid)) throw e
      if (o.invalid === 'abort') { err(e.message); throw e }
      if (o.invalid !== 'ignore') err(e.message)
      if (o.invalid === 'fail' || o.invalid === 'warn') failed = o.invalid === 'fail' || failed
      return text
    }
  }
  /** A line with the chosen fields converted, the rest as they were */
  const line = text => {
    if (o.delimiter !== undefined) return text.split(o.delimiter).map((field, i) => (o.fields(i + 1) ? convert(field) : field)).join(o.delimiter)
    let n = 0
    // fields are runs of non-blanks, and the blanks between them are kept
    return text.replace(/(\s*)(\S+)/g, (_, space, field) => { n++; return space + (o.fields(n) ? convert(field) : field) })
  }

  const terminator = o.zero ? '\0' : '\n'
  try {
    if (operands.length) {
      writeAll(1, encoder.encode(operands.map(convert).join(terminator) + terminator))
    } else {
      const text = readFdText(0)
      const lines = text.split(terminator)
      if (lines[lines.length - 1] === '') lines.pop()
      writeAll(1, encoder.encode(lines.map((text, i) => (i < o.header ? text : line(text))).join(terminator) + (lines.length ? terminator : '')))
    }
  } catch (e) {
    if (e instanceof Invalid) return 2
    throw e
  }
  return failed ? 2 : 0
}

try {
  exit(main())
} catch (error) {
  err(reasonOf(error))
  exit(1)
}
