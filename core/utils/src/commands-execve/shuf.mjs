/** `shuf`: a random permutation of lines, of the arguments (`-e`) or of a range of numbers (`-i`), as GNU shuf writes it. */

import { readFdBytes, readFileBytes, writeFdBytes, writeFileBytes } from './lib/bytes.mjs'
import { getopt } from './lib/getopt.mjs'
import { reasonOf } from './lib/errno.mjs'
import { resolve } from './lib/path-utils.mjs'

const { argv, exit, getcwd } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeFdBytes(2, encoder.encode(`shuf: ${text}\n`))

const usage = `Usage: shuf [OPTION]... [FILE]
  or:  shuf -e [OPTION]... [ARG]...
  or:  shuf -i LO-HI [OPTION]...
Write a random permutation of the input lines to standard output.

With no FILE, or when FILE is -, read standard input.

Mandatory arguments to long options are mandatory for short options too.
  -e, --echo                treat each ARG as an input line
  -i, --input-range=LO-HI   treat each number LO through HI as an input line
  -n, --head-count=COUNT    output at most COUNT lines
  -o, --output=FILE         write result to FILE instead of standard output
      --random-source=FILE  get random bytes from FILE
  -r, --repeat              output lines can be repeated
  -z, --zero-terminated     line delimiter is NUL, not newline
      --help        display this help and exit
      --version     output version information and exit`

/** A source of random numbers below `limit`: the system's, or the bytes of `--random-source` */
function randomBelow(limit, source) {
  if (limit <= 1) return 0
  if (!source) return Math.floor(Math.random() * limit)
  // enough bytes for the limit, taken from the file; the bias of a plain modulo is the real shuf's trouble too
  let value = 0
  const needed = Math.ceil(Math.log2(limit) / 8) + 1
  for (let i = 0; i < needed; i++) value = value * 256 + (source.next() ?? 0)
  return value % limit
}

function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'ei:n:o:rz',
    long: { echo: 'e', 'input-range': { key: 'i', arg: 'required' }, 'head-count': { key: 'n', arg: 'required' }, output: { key: 'o', arg: 'required' }, 'random-source': { key: 'source', arg: 'required' }, repeat: 'r', 'zero-terminated': 'z', help: 'help', version: 'version' }
  })
  if (error) { err(error); err("Try 'shuf --help' for more information."); return 1 }
  const o = { echo: false, range: undefined, count: Infinity, output: undefined, repeat: false, zero: false, source: undefined }
  for (const [key, value] of options) {
    if (key === 'help') { writeFdBytes(1, encoder.encode(usage + '\n')); return 0 }
    if (key === 'version') { writeFdBytes(1, encoder.encode('shuf (ecmaOS coreutils)\n')); return 0 }
    if (key === 'e') o.echo = true
    else if (key === 'i') {
      if (o.range) { err('multiple -i options specified'); return 1 }
      const match = /^(\d+)-(\d+)$/.exec(value)
      if (!match) { err(`invalid input range: ‘${value}’`); return 1 }
      if (Number(match[1]) > Number(match[2]) + 1) { err(`invalid input range: ‘${value}’`); return 1 }
      o.range = [Number(match[1]), Number(match[2])]
    } else if (key === 'n') {
      if (!/^\d+$/.test(value)) { err(`invalid line count: ‘${value}’`); return 1 }
      o.count = Math.min(o.count, Number(value))
    } else if (key === 'o') o.output = value
    else if (key === 'r') o.repeat = true
    else if (key === 'z') o.zero = true
    else if (key === 'source') {
      let bytes
      try { bytes = readFileBytes(resolve(getcwd(), value)) } catch (e) { err(`${value}: ${reasonOf(e)}`); return 1 }
      let at = 0
      o.source = { next: () => (at < bytes.length ? bytes[at++] : undefined) }
    }
  }
  if (o.echo && o.range) { err('cannot combine -e and -i options'); return 1 }
  let items
  const delimiter = o.zero ? '\0' : '\n'
  if (o.echo) items = operands
  else if (o.range) {
    if (operands.length) { err(`extra operand ‘${operands[0]}’`); err("Try 'shuf --help' for more information."); return 1 }
    items = []
    for (let n = o.range[0]; n <= o.range[1]; n++) items.push(String(n))
  } else {
    if (operands.length > 1) { err(`extra operand ‘${operands[1]}’`); err("Try 'shuf --help' for more information."); return 1 }
    let bytes
    try { bytes = operands[0] === undefined || operands[0] === '-' ? readFdBytes(0) : readFileBytes(resolve(getcwd(), operands[0])) } catch (e) { err(`${operands[0]}: ${reasonOf(e)}`); return 1 }
    const text = new TextDecoder().decode(bytes)
    items = text === '' ? [] : text.split(delimiter)
    if (items.length && items[items.length - 1] === '') items.pop()
  }
  const lines = []
  if (o.repeat) {
    if (items.length === 0 && o.count !== 0) { err('no lines to repeat'); return 1 }
    for (let i = 0; i < o.count && (o.count !== Infinity); i++) lines.push(items[randomBelow(items.length, o.source)])
    if (o.count === Infinity) {
      // without -n, repeat for ever: the reader ends the output
      for (;;) {
        const chunk = []
        for (let i = 0; i < 4096; i++) chunk.push(items[randomBelow(items.length, o.source)])
        try { writeFdBytes(1, encoder.encode(chunk.join(delimiter) + delimiter)) } catch { return 0 }
      }
    }
  } else {
    const shuffled = [...items]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = randomBelow(i + 1, o.source)
      ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }
    lines.push(...shuffled.slice(0, o.count))
  }
  const text = lines.length ? lines.join(delimiter) + delimiter : ''
  if (o.output !== undefined) {
    try { writeFileBytes(resolve(getcwd(), o.output), encoder.encode(text)) } catch (e) { err(`${o.output}: ${reasonOf(e)}`); return 1 }
  } else writeFdBytes(1, encoder.encode(text))
  return 0
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
