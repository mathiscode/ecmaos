/** List or find mounted filesystems, read from `/proc/mounts`, as util-linux `findmnt` does for the columns a browser machine has. */

import { getopt } from './lib/getopt.mjs'
import { canonical, mountFor, readMounts } from './lib/mounts.mjs'

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`findmnt: ${text}\n`))

const usage = `Usage:
 findmnt [options]
 findmnt [options] <device> | <mountpoint>
 findmnt [options] [--source <device>] [--target <path> | --mountpoint <dir>]

Find a (mounted) filesystem.

 -A, --all              print all filesystems (the default; there is no built-in filter)
 -f, --first-only       print the first found filesystem only
 -i, --invert           invert the sense of matching
 -J, --json             use JSON output format
 -l, --list             use list format output (the default)
 -M, --mountpoint <dir> the mountpoint directory
 -n, --noheadings       don't print column headings
 -O, --options <list>   limit the set of filesystems by mount options
 -o, --output <list>    the output columns to be shown (TARGET, SOURCE, FSTYPE, OPTIONS)
 -P, --pairs            use key="value" output format
 -r, --raw              use raw output format
 -S, --source <string>  the device to mount (can be in the form of a name or a path)
 -T, --target <path>    the path to the filesystem to use (the mount that holds it)
 -t, --types <list>     limit the set of filesystems by FS types
 -h, --help             display this help
 -V, --version          display version

The table is /proc/mounts. A mount's source is its filesystem type, since none is a device.`

const COLUMNS = ['TARGET', 'SOURCE', 'FSTYPE', 'OPTIONS']
const field = (mount, column) => ({ TARGET: mount.target, SOURCE: mount.source, FSTYPE: mount.fstype, OPTIONS: mount.options })[column]

/** `-t a,b` matches a type in the list; a `no` prefix on the first item negates the whole list, as in mount(8) */
function typeFilter(list) {
  const negate = list.startsWith('no')
  const names = (negate ? list.slice(2) : list).split(',').map(name => (name.startsWith('no') && negate ? name.slice(2) : name))
  return mount => names.includes(mount.fstype) !== negate
}

function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'AfiJlM:nO:o:PrS:T:t:hV',
    long: { all: 'A', 'first-only': 'f', invert: 'i', json: 'J', list: 'l', mountpoint: { key: 'M', arg: 'required' }, noheadings: 'n', options: { key: 'O', arg: 'required' },
      output: { key: 'o', arg: 'required' }, pairs: 'P', raw: 'r', source: { key: 'S', arg: 'required' }, target: { key: 'T', arg: 'required' }, types: { key: 't', arg: 'required' }, help: 'h', version: 'V' }
  })
  if (error) { err(error); return 1 }
  const o = { columns: COLUMNS, format: 'list', filters: [] }
  let invert = false
  let first = false
  let heading = true
  for (const [key, value] of options) {
    if (key === 'h') { out(usage + '\n'); return 0 }
    if (key === 'V') { out('findmnt (ecmaOS coreutils) 1.0\n'); return 0 }
    if (key === 'i') invert = true
    else if (key === 'f') first = true
    else if (key === 'n') heading = false
    else if (key === 'J') o.format = 'json'
    else if (key === 'P') o.format = 'pairs'
    else if (key === 'r') o.format = 'raw'
    else if (key === 'l') o.format = 'list'
    else if (key === 'o') {
      const names = value.toUpperCase().split(',').filter(Boolean)
      const unknown = names.find(name => !COLUMNS.includes(name))
      if (unknown) { err(`unknown column: ${unknown}`); return 1 }
      o.columns = names
    } else if (key === 't') o.filters.push(typeFilter(value))
    else if (key === 'O') o.filters.push(mount => value.split(',').every(opt => mount.options.split(',').includes(opt)))
    else if (key === 'S') o.filters.push(mount => mount.source === value)
    else if (key === 'M') { const dir = canonical(value); o.filters.push(mount => mount.target === dir) }
  }
  const target = options.filter(([key]) => key === 'T').pop()?.[1]
  if (operands.length > 2) { err('too many arguments'); return 1 }
  // a lone operand is a source or a mount point; two are a source and a mount point
  if (operands.length === 1) o.filters.push(mount => mount.target === canonical(operands[0]) || mount.source === operands[0])
  else if (operands.length === 2) o.filters.push(mount => mount.source === operands[0] && mount.target === canonical(operands[1]))

  let mounts
  try { mounts = readMounts() } catch (e) { err(`cannot read /proc/mounts: ${e?.message ?? e}`); return 1 }
  if (target !== undefined) {
    let held
    try { held = mountFor(mounts, canonical(target)) } catch { held = undefined }
    mounts = held ? [held] : []
  }
  let rows = mounts.filter(mount => o.filters.every(filter => filter(mount)) !== invert)
  if (first) rows = rows.slice(0, 1)
  if (!rows.length) return 1

  if (o.format === 'json') {
    out(JSON.stringify({ filesystems: rows.map(mount => Object.fromEntries(o.columns.map(column => [column.toLowerCase(), field(mount, column)]))) }, null, 3) + '\n')
  } else if (o.format === 'pairs') {
    for (const mount of rows) out(o.columns.map(column => `${column}="${field(mount, column)}"`).join(' ') + '\n')
  } else if (o.format === 'raw') {
    if (heading) out(o.columns.join(' ') + '\n')
    for (const mount of rows) out(o.columns.map(column => field(mount, column).replace(/ /g, '\\x20')).join(' ') + '\n')
  } else {
    const table = rows.map(mount => o.columns.map(column => field(mount, column)))
    const widths = o.columns.map((column, i) => Math.max(heading ? column.length : 0, ...table.map(row => row[i].length)))
    const line = cells => cells.map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i]))).join(' ') + '\n'
    if (heading) out(line(o.columns))
    for (const row of table) out(line(row))
  }
  return 0
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
