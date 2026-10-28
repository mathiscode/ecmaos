/** `truncate`: shrink or extend each FILE to a size, as GNU truncate does; extended bytes read as zeros. */

import { getopt, tryHelp } from './lib/getopt.mjs'
import { reasonOf, quotef } from './lib/errno.mjs'
import { parseSize } from './lib/size.mjs'

const { argv, exit, writeAll, open, close, stat, custom, O_WRONLY, O_CREAT } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`truncate: ${text}\n`))

const usage = `Usage: truncate OPTION... FILE...
Shrink or extend the size of each FILE to the specified size

A FILE argument that does not exist is created.

If a FILE is larger than the specified size, the extra data is lost.
If a FILE is shorter, it is extended and the sparse extended part (hole)
reads as zero bytes.

  -c, --no-create        do not create any files
  -o, --io-blocks        treat SIZE as number of IO blocks instead of bytes
  -r, --reference=RFILE  base size on RFILE
  -s, --size=SIZE        set or adjust the file size by SIZE bytes
      --help        display this help and exit
      --version     output version information and exit

SIZE may also be prefixed by one of the following modifying characters:
'+' extend by, '-' reduce by, '<' at most, '>' at least,
'/' round down to multiple of, '%' round up to multiple of.`

async function main() {
  const { options, operands, error } = getopt(argv.slice(1), { short: 'cor:s:', long: { 'no-create': 'c', 'io-blocks': 'o', reference: { key: 'r', arg: 'required' }, size: { key: 's', arg: 'required' }, help: 'help', version: 'version' } })
  if (error) { err(error); writeAll(2, encoder.encode(tryHelp('truncate') + '\n')); return 1 }
  let noCreate = false
  let blocks = false
  let reference
  let sizeText
  for (const [key, value] of options) {
    if (key === 'help') { out(usage + '\n'); return 0 }
    if (key === 'version') { out('truncate (ecmaOS coreutils) 1.0\n'); return 0 }
    if (key === 'c') noCreate = true
    else if (key === 'o') blocks = true
    else if (key === 'r') reference = value
    else if (key === 's') sizeText = value
  }
  if (sizeText === undefined && reference === undefined) { err('you must specify either --size or --reference'); writeAll(2, encoder.encode(tryHelp('truncate') + '\n')); return 1 }
  if (operands.length === 0) { err('missing file operand'); writeAll(2, encoder.encode(tryHelp('truncate') + '\n')); return 1 }

  let mode = ''
  let amount
  if (sizeText !== undefined) {
    const match = /^([-+<>/%]?)\s*(.*)$/.exec(sizeText)
    mode = match[1]
    amount = parseSize(match[2])
    if (amount === undefined) { err(`Invalid number: ${quotef(sizeText)}`); return 1 }
    if (blocks) amount *= 512
    if ((mode === '/' || mode === '%') && amount === 0) { err('division by zero'); return 1 }
  }
  let base
  if (reference !== undefined) {
    try { base = stat(reference).size } catch (e) { err(`cannot stat ${quotef(reference)}: ${reasonOf(e)}`); return 1 }
    if (sizeText === undefined) { mode = ''; amount = base }
  }

  let status = 0
  for (const file of operands) {
    let current
    try { current = stat(file).size } catch {
      if (noCreate) continue
      try { close(open(file, O_WRONLY | O_CREAT, 0o666)) } catch (e) { err(`cannot open ${quotef(file)} for writing: ${reasonOf(e)}`); status = 1; continue }
      current = 0
    }
    const from = reference !== undefined && sizeText !== undefined ? base : current
    let size
    switch (mode) {
      case '+': size = from + amount; break
      case '-': size = Math.max(0, from - amount); break
      case '<': size = Math.min(from, amount); break
      case '>': size = Math.max(from, amount); break
      case '/': size = Math.floor(from / amount) * amount; break
      case '%': size = Math.ceil(from / amount) * amount; break
      default: size = amount
    }
    if (size === current) continue
    try { await custom('truncate', file, size) } catch (e) { err(`failed to truncate ${quotef(file)} at ${size} bytes: ${reasonOf(e)}`); status = 1 }
  }
  return status
}

try {
  exit(await main())
} catch (error) {
  err(reasonOf(error))
  exit(1)
}
