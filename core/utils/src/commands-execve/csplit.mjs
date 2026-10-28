/**
 * `csplit`: split a file into pieces at line numbers (`N`) and at lines matching a regular expression (`/RE/[OFFSET]`
 * starts a piece, `%RE%[OFFSET]` skips to it), each pattern repeatable with `{N}` or `{*}`, as GNU csplit does. The
 * size of each piece is printed as it is written. When a pattern cannot be met, what is left is written as a piece and
 * the pieces are removed unless `-k`.
 */

import { getopt, tryHelp } from './lib/getopt.mjs'
import { reasonOf, quotef } from './lib/errno.mjs'
import { readFdBytes, readFileBytes } from './lib/bytes.mjs'
import { translate } from './lib/regex-posix.mjs'

const { argv, exit, writeAll, open, close, unlink, O_WRONLY, O_CREAT, O_TRUNC } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`csplit: ${text}\n`))

const usage = `Usage: csplit [OPTION]... FILE PATTERN...
Output pieces of FILE separated by PATTERN(s) to files 'xx00', 'xx01', ...,
and output byte counts of each piece to standard output.

Read standard input if FILE is -

  -b, --suffix-format=FORMAT  use sprintf FORMAT instead of %02d
  -f, --prefix=PREFIX        use PREFIX instead of 'xx'
  -k, --keep-files           do not remove output files on errors
      --suppress-matched     suppress the lines matching PATTERN
  -n, --digits=DIGITS        use specified number of digits instead of 2
  -s, --quiet, --silent      do not print counts of output file sizes
  -z, --elide-empty-files    suppress empty output files
      --help        display this help and exit
      --version     output version information and exit

Each PATTERN may be:
  INTEGER            copy up to but not including specified line number
  /REGEXP/[OFFSET]   copy up to but not including a matching line
  %REGEXP%[OFFSET]   skip to, but not including a matching line
  {INTEGER}          repeat the previous pattern specified number of times
  {*}                repeat the previous pattern as many times as possible

A line OFFSET is an integer optionally preceded by '+' or '-'`

class Failure extends Error {}

/** `%02d`-style: one conversion of d, i, u, o, x or X, with flags and a width */
function suffixFormatter(format) {
  const match = /^([^%]*(?:%%[^%]*)*)%([-0' +#]*)(\d*)([diuoxX])(.*)$/.exec(format)
  if (!match || match[5].replace(/%%/g, '').includes('%')) return undefined
  const [, before, flags, width, conversion, after] = match
  return n => {
    let digits = conversion === 'o' ? n.toString(8) : conversion === 'x' ? n.toString(16) : conversion === 'X' ? n.toString(16).toUpperCase() : String(n)
    const size = Number(width || 0)
    digits = flags.includes('-') ? digits.padEnd(size) : digits.padStart(size, flags.includes('0') ? '0' : ' ')
    return before.replace(/%%/g, '%') + digits + after.replace(/%%/g, '%')
  }
}

/** The patterns, each `{ kind, regex?, offset, line?, repeat, text }` */
function parsePatterns(args) {
  const patterns = []
  for (const arg of args) {
    const repeat = /^\{(\d+|\*)\}$/.exec(arg)
    if (repeat) {
      const last = patterns[patterns.length - 1]
      if (!last) throw new Failure(`‘${arg}’: invalid pattern`)
      last.repeat = repeat[1] === '*' ? Infinity : Number(repeat[1])
      continue
    }
    const regex = /^([/%])(.*)\1([-+]?\d+)?$/s.exec(arg)
    if (regex) {
      let compiled
      try { compiled = new RegExp(translate(regex[2], false, false, true).source, 'u') } catch (e) { throw new Failure(`${quotef(arg)}: invalid regular expression: ${reasonOf(e)}`) }
      patterns.push({ kind: regex[1] === '/' ? 'split' : 'skip', regex: compiled, offset: Number(regex[3] ?? 0), repeat: 0, text: arg })
      continue
    }
    if (/^\d+$/.test(arg)) {
      if (Number(arg) === 0) throw new Failure(`‘${arg}’: line number must be greater than zero`)
      const previous = [...patterns].reverse().find(pattern => pattern.kind === 'line')
      if (previous && Number(arg) < previous.line) throw new Failure(`line number ‘${arg}’ is smaller than preceding line number, ${previous.line}`)
      patterns.push({ kind: 'line', line: Number(arg), repeat: 0, text: arg })
      continue
    }
    throw new Failure(`‘${arg}’: invalid pattern`)
  }
  return patterns
}

function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'b:f:kn:sz',
    long: { 'suffix-format': { key: 'b', arg: 'required' }, prefix: { key: 'f', arg: 'required' }, 'keep-files': 'k', 'suppress-matched': 'suppress', digits: { key: 'n', arg: 'required' }, quiet: 's', silent: 's', 'elide-empty-files': 'z', help: 'help', version: 'version' }
  })
  if (error) { err(error); writeAll(2, encoder.encode(tryHelp('csplit') + '\n')); return 1 }
  let prefix = 'xx'
  let digits = 2
  let suffixFormat
  let keep = false
  let suppress = false
  let quiet = false
  let elide = false
  for (const [key, value] of options) {
    if (key === 'help') { out(usage + '\n'); return 0 }
    if (key === 'version') { out('csplit (ecmaOS coreutils) 1.0\n'); return 0 }
    if (key === 'b') suffixFormat = value
    else if (key === 'f') prefix = value
    else if (key === 'k') keep = true
    else if (key === 'n') {
      if (!/^\d+$/.test(value)) { err(`invalid number: ${quotef(value)}`); return 1 }
      digits = Number(value)
    } else if (key === 's') quiet = true
    else if (key === 'z') elide = true
    else if (key === 'suppress') suppress = true
  }
  if (operands.length === 0) { err('missing operand'); writeAll(2, encoder.encode(tryHelp('csplit') + '\n')); return 1 }
  if (operands.length === 1) { err(`missing operand after ${quotef(operands[0])}`); writeAll(2, encoder.encode(tryHelp('csplit') + '\n')); return 1 }
  const name = suffixFormat !== undefined ? suffixFormatter(suffixFormat) : n => String(n).padStart(digits, '0')
  if (!name) { err(`invalid conversion specifier in suffix: ${quotef(suffixFormat)}`); return 1 }

  let patterns
  try { patterns = parsePatterns(operands.slice(1)) } catch (e) { err(e.message); return 1 }
  let bytes
  const file = operands[0]
  try { bytes = file === '-' ? readFdBytes(0) : readFileBytes(file) } catch (e) { err(`cannot open ${quotef(file)} for reading: ${reasonOf(e)}`); return 1 }
  const text = new TextDecoder().decode(bytes)
  const lines = text.split(/(?<=\n)/)
  if (lines[lines.length - 1] === '') lines.pop()

  const made = []
  let count = 0
  /** Writes lines [from, to) as the next piece */
  const piece = (from, to) => {
    const chunk = lines.slice(from, to).join('')
    if (elide && chunk === '') return
    const path = prefix + name(count++)
    const fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o666)
    try { writeAll(fd, encoder.encode(chunk)) } finally { close(fd) }
    made.push(path)
    if (!quiet) out(`${encoder.encode(chunk).length}\n`)
  }

  let cursor = 0
  let searchFrom = 0
  try {
    for (const pattern of patterns) {
      for (let round = 0; round <= pattern.repeat; round++) {
        const afterSuppress = () => (suppress ? 1 : 0)
        if (pattern.kind === 'line') {
          const target = pattern.line * (round + 1) - 1
          if (target > lines.length - 1) {
            if (pattern.repeat === Infinity && round > 0 && cursor >= lines.length) return 0
            piece(cursor, lines.length)
            cursor = lines.length
            throw new Failure(`‘${pattern.text}’: line number out of range${round > 0 ? ` on repetition ${round}` : ''}`)
          }
          piece(cursor, target)
          cursor = target + afterSuppress()
          searchFrom = cursor
          continue
        }
        let found = -1
        for (let i = searchFrom; i < lines.length; i++) if (pattern.regex.test(lines[i].replace(/\n$/, ''))) { found = i; break }
        if (found === -1) {
          if (pattern.repeat === Infinity && round > 0) break
          if (pattern.kind === 'split') piece(cursor, lines.length)
          cursor = lines.length
          throw new Failure(`‘${pattern.text}’: match not found${round > 0 ? ` on repetition ${round}` : ''}`)
        }
        const at = found + pattern.offset
        if (at < cursor || at > lines.length) throw new Failure(`‘${pattern.text}’: line number out of range`)
        if (pattern.kind === 'split') piece(cursor, at)
        cursor = at + (suppress && pattern.offset === 0 ? 1 : 0)
        searchFrom = found + 1
      }
    }
    piece(cursor, lines.length)
  } catch (e) {
    if (!(e instanceof Failure)) throw e
    err(e.message)
    if (!keep) for (const path of made) { try { unlink(path) } catch { /* gone */ } }
    return 1
  }
  return 0
}

try {
  exit(main())
} catch (error) {
  err(reasonOf(error))
  exit(1)
}
