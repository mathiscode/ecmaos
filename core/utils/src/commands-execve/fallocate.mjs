/**
 * `fallocate`: give a file space, or change a range of it. Files here are not sparse, so allocating a range writes it
 * out: the default mode extends a file shorter than OFFSET+LENGTH with zeros (unless `-n`), `-z` writes zeros over the
 * range, `-p` does the same while keeping the size (a punched hole reads as zeros), `-c` removes the range and moves the
 * rest down, `-i` inserts zeros, and `-d`, which finds runs of zeros to free, has nothing to free and leaves the file as it is.
 */

import { getopt, tryHelp } from './lib/getopt.mjs'
import { reasonOf, quotef } from './lib/errno.mjs'
import { readFileBytes } from './lib/bytes.mjs'
import { parseSize } from './lib/size.mjs'

const { argv, exit, writeAll, open, close, stat, custom, O_WRONLY, O_CREAT } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`fallocate: ${text}\n`))

const usage = `
Usage:
 fallocate [options] <filename>

Preallocate space to, or deallocate space from a file.

Options:
 -c, --collapse-range remove a range from the file
 -d, --dig-holes      detect zeroes and replace with holes
 -i, --insert-range   insert a hole at range, shifting existing data
 -l, --length <num>   length for range operations, in bytes
 -n, --keep-size      maintain the apparent size of the file
 -o, --offset <num>   offset for range operations, in bytes
 -p, --punch-hole     replace a range with a hole (implies -n)
 -z, --zero-range     zero and ensure allocation of a range
 -x, --posix          use posix_fallocate(3) instead of fallocate(2)
 -v, --verbose        verbose mode

 -h, --help           display this help
 -V, --version        display version`

async function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'cdil:no:pzxvhV',
    long: { 'collapse-range': 'c', 'dig-holes': 'd', 'insert-range': 'i', length: { key: 'l', arg: 'required' }, 'keep-size': 'n', offset: { key: 'o', arg: 'required' }, 'punch-hole': 'p', 'zero-range': 'z', posix: 'x', verbose: 'v', help: 'h', version: 'V' }
  })
  if (error) { err(error); writeAll(2, encoder.encode(tryHelp('fallocate') + '\n')); return 1 }
  let mode = 'allocate', length, offset = 0, keep = false, verbose = false
  for (const [key, value] of options) {
    if (key === 'h') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (key === 'V') { writeAll(1, encoder.encode('fallocate from util-linux 2.40 (ecmaOS)\n')); return 0 }
    if (key === 'c') mode = 'collapse'
    else if (key === 'd') mode = 'dig'
    else if (key === 'i') mode = 'insert'
    else if (key === 'p') { mode = 'punch'; keep = true }
    else if (key === 'z') mode = 'zero'
    else if (key === 'n') keep = true
    else if (key === 'v') verbose = true
    else if (key === 'l' || key === 'o') {
      const n = parseSize(value.replace(/^(\d+)([KMGTPE])iB$/i, '$1$2'))
      if (n === undefined) { err(`invalid ${key === 'l' ? 'length' : 'offset'} value specified`); return 1 }
      if (key === 'l') length = n
      else offset = n
    }
  }
  if (operands.length !== 1) { err(operands.length ? 'unexpected number of arguments' : 'no filename specified'); writeAll(2, encoder.encode(tryHelp('fallocate') + '\n')); return 1 }
  const file = operands[0]
  if (mode !== 'dig' && length === undefined) { err('no length argument specified'); return 1 }
  if (length !== undefined && length <= 0) { err('invalid length value specified'); return 1 }

  let size
  try { size = stat(file).size } catch {
    if (mode !== 'allocate' && mode !== 'zero') { err(`cannot open ${file}: No such file or directory`); return 1 }
    try { close(open(file, O_WRONLY | O_CREAT, 0o644)) } catch (e) { err(`cannot open ${file}: ${reasonOf(e)}`); return 1 }
    size = 0
  }
  if (mode === 'dig') {
    if (verbose) writeAll(1, encoder.encode(`${file}: 0 B (0 bytes) converted to sparse holes.\n`))
    return 0
  }
  const end = offset + length
  if ((mode === 'collapse' || mode === 'insert') && offset > size) { err(`fallocate failed: Invalid argument`); return 1 }

  if (mode === 'allocate') {
    if (!keep && end > size) await custom('truncate', file, end)
  } else {
    let bytes
    try { bytes = readFileBytes(file) } catch (e) { err(`${quotef(file)}: ${reasonOf(e)}`); return 1 }
    let result
    if (mode === 'zero' || mode === 'punch') {
      const total = keep ? size : Math.max(size, end)
      result = new Uint8Array(total)
      result.set(bytes.subarray(0, total))
      result.fill(0, Math.min(offset, total), Math.min(end, total))
    } else if (mode === 'collapse') {
      result = new Uint8Array(Math.max(0, size - Math.min(length, size - offset)))
      result.set(bytes.subarray(0, offset))
      result.set(bytes.subarray(Math.min(end, size)), offset)
    } else {
      result = new Uint8Array(size + length)
      result.set(bytes.subarray(0, offset))
      result.set(bytes.subarray(offset), end)
    }
    const fd = open(file, O_WRONLY)
    try { writeAll(fd, result, 0) } finally { close(fd) }
    if (result.length < size) await custom('truncate', file, result.length)
  }
  if (verbose) writeAll(1, encoder.encode(`${file}: ${length} bytes ${mode === 'punch' ? 'hole created' : mode === 'collapse' ? 'removed' : mode === 'insert' ? 'inserted' : mode === 'zero' ? 'zeroed' : 'allocated'}.\n`))
  return 0
}

try {
  exit(await main())
} catch (error) {
  err(reasonOf(error))
  exit(1)
}
