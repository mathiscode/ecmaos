/** `strings`: print the sequences of printable characters in files, with the options of GNU binutils' strings. */

import { readFdBytes, readFileBytes } from './lib/bytes.mjs'
import { getopt } from './lib/getopt.mjs'
import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, getcwd } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const out = bytes => writeAll(1, typeof bytes === 'string' ? encoder.encode(bytes) : bytes)
const err = text => writeAll(2, encoder.encode(`strings: ${text}\n`))

const usage = `Usage: strings [option(s)] [file(s)]
 Display printable strings in [file(s)] (stdin by default)
 The options are:
  -a - --all                Scan the entire file, not just the data section [default]
  -d --data                 Only scan the data sections in the file
  -f --print-file-name      Print the name of the file before each string
  -n --bytes=[number]       Locate & print any NUL-terminated sequence of at
  -<number>                   least [number] characters (default 4).
  -t --radix={o,d,x}        Print the location of the string in base 8, 10 or 16
  -w --include-all-whitespace Include all whitespace as valid string characters
  -o                        An alias for --radix=o
  -T --target=<BFDNAME>     Specify the binary file format
  -e --encoding={s,S,b,l,B,L} Select character size and endianness:
                            s = 7-bit, S = 8-bit, {b,l} = 16-bit, {B,L} = 32-bit
  -s --output-separator=<string> String used to separate strings in output.
  @<file>                   Read options from <file>
  -h --help                 Display this information
  -v -V --version           Print the program's version number`

const isPrintable = (byte, whitespace) => (byte >= 32 && byte < 127) || byte === 9 || (whitespace && (byte === 10 || byte === 11 || byte === 12 || byte === 13))

/** Splits the bytes into strings of at least `min` characters; each entry is `[offset, text]`. */
function extract(bytes, { min, encoding, whitespace }) {
  const found = []
  const width = encoding === 'b' || encoding === 'l' ? 2 : encoding === 'B' || encoding === 'L' ? 4 : 1
  const bigEndian = encoding === 'b' || encoding === 'B'
  const limit = encoding === 'S' ? 256 : 128
  let text = ''
  let start = 0
  const end = () => { if (text.length >= min) found.push([start, text]); text = '' }
  for (let i = 0; i + width <= bytes.length; i += width) {
    let value
    if (width === 1) value = bytes[i]
    else {
      value = 0
      for (let k = 0; k < width; k++) value = value * 256 + bytes[i + (bigEndian ? k : width - 1 - k)]
    }
    const printable = encoding === 'S' ? (value >= 32 && value < 256 && value !== 127) || value === 9 || (whitespace && value >= 10 && value <= 13) : value < limit && isPrintable(value, whitespace)
    if (printable) {
      if (text === '') start = i
      text += String.fromCharCode(value)
    } else end()
  }
  end()
  return found
}

function main() {
  // `-<number>` is the minimum length, as `-n <number>` is
  const args = argv.slice(1).map(arg => (/^-\d+$/.test(arg) ? `--bytes=${arg.slice(1)}` : arg))
  const { options, operands, error } = getopt(args, {
    short: 'adfn:t:wos:T:e:hvV',
    long: { all: 'a', data: 'd', 'print-file-name': 'f', bytes: { key: 'n', arg: 'required' }, radix: { key: 't', arg: 'required' }, 'include-all-whitespace': 'w', target: { key: 'T', arg: 'required' }, encoding: { key: 'e', arg: 'required' }, 'output-separator': { key: 's', arg: 'required' }, help: 'h', version: 'v' }
  })
  if (error) { err(error); writeAll(2, encoder.encode(usage + '\n')); return 1 }
  const o = { min: 4, radix: undefined, printName: false, separator: '\n', encoding: 's', whitespace: false }
  for (const [key, value] of options) {
    if (key === 'h') { out(usage + '\n'); return 0 }
    if (key === 'v' || key === 'V') { out('GNU strings (ecmaOS)\n'); return 0 }
    if (key === 'n') {
      if (!/^\d+$/.test(value) || Number(value) < 1) { err(`invalid minimum string length ${value}`); return 1 }
      o.min = Number(value)
    } else if (key === 't') {
      if (!['o', 'd', 'x'].includes(value)) { err(`invalid radix ${value}`); return 1 }
      o.radix = value
    } else if (key === 'o') o.radix = 'o'
    else if (key === 'f') o.printName = true
    else if (key === 'w') o.whitespace = true
    else if (key === 's') o.separator = value
    else if (key === 'e') {
      if (!['s', 'S', 'b', 'l', 'B', 'L'].includes(value)) { err('invalid encoding'); return 1 }
      o.encoding = value
    }
  }
  const files = operands.length ? operands : ['-']
  const cwd = getcwd()
  let status = 0
  for (const file of files) {
    if (file === '-' && operands.length > 0) { writeAll(2, encoder.encode(usage + '\n')); return 1 }
    let bytes
    try { bytes = file === '-' ? readFdBytes(0) : readFileBytes(resolve(cwd, file)) } catch (e) {
      err(`'${file}': ${e?.code === 'ENOENT' || /no such file/i.test(e?.message ?? '') ? 'No such file' : (e?.message ?? e)}`)
      status = 1
      continue
    }
    for (const [offset, text] of extract(bytes, o)) {
      let line = ''
      if (o.printName) line += `${file === '-' ? '{standard input}' : file}: `
      if (o.radix) line += offset.toString(o.radix === 'o' ? 8 : o.radix === 'd' ? 10 : 16).padStart(7) + ' '
      out(line + text + o.separator)
    }
  }
  return status
}

try {
  exit(main())
} catch (e) {
  err(e?.message ?? String(e))
  exit(1)
}
