/**
 * `lslocks`: list the file locks held, from `/proc/locks`. Each lock's file is found among its owner's open files, by
 * inode; one whose owner holds no descriptor for it any more shows no path. The locks are the kernel's record locks
 * (`fcntl`, `lockf` and `flock`), so every TYPE is POSIX.
 */

import { getopt, tryHelp } from './lib/getopt.mjs'
import { reasonOf } from './lib/errno.mjs'
import { openFiles, processes, readSmall } from './lib/procs.mjs'

const { argv, exit, writeAll, stat } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`lslocks: ${text}\n`))

const usage = `
Usage:
 lslocks [options]

List local system locks.

Options:
 -b, --bytes            print SIZE in bytes rather than in human readable format
 -J, --json             use JSON output format
 -i, --noinaccessible   ignore locks without read permissions
 -n, --noheadings       don't print headings
 -o, --output <list>    output columns
     --output-all       output all columns
 -p, --pid <pid>        display only locks held by this process
 -r, --raw              use the raw output format
 -u, --notruncate       don't truncate text in columns

 -h, --help             display this help
 -V, --version          display version

Available output columns:
     COMMAND  command of the process holding the lock
         PID  PID of the process holding the lock
        TYPE  kind of lock
        SIZE  size of the lock, use <number> if --bytes is given
       INODE  inode number
     MAJ:MIN  major:minor device number
        MODE  lock access mode
           M  mandatory state of the lock: 0 (none), 1 (set)
       START  relative byte offset of the lock
         END  ending offset of the lock
        PATH  path of the locked file
     BLOCKER  PID of the process blocking the lock`

const ALL = ['COMMAND', 'PID', 'TYPE', 'SIZE', 'INODE', 'MAJ:MIN', 'MODE', 'M', 'START', 'END', 'PATH', 'BLOCKER']
const DEFAULT = ['COMMAND', 'PID', 'TYPE', 'SIZE', 'MODE', 'M', 'START', 'END', 'PATH']
const RIGHT = new Set(['PID', 'SIZE', 'INODE', 'M', 'START', 'END', 'BLOCKER'])

function human(bytes) {
  const units = ['B', 'K', 'M', 'G', 'T', 'P']
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++ }
  return i === 0 ? `${value}B` : `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10}${units[i]}`
}

function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'bJino:p:ruhV',
    long: { bytes: 'b', json: 'J', noinaccessible: 'i', noheadings: 'n', output: { key: 'o', arg: 'required' }, 'output-all': 'all', pid: { key: 'p', arg: 'required' }, raw: 'r', notruncate: 'u', help: 'h', version: 'V' }
  })
  if (error) { err(error); writeAll(2, encoder.encode(tryHelp('lslocks') + '\n')); return 1 }
  if (operands.length) { err(`bad usage`); writeAll(2, encoder.encode(tryHelp('lslocks') + '\n')); return 1 }
  let columns = DEFAULT
  let bytes = false, json = false, headings = true, raw = false, only
  for (const [key, value] of options) {
    if (key === 'h') { out(usage + '\n'); return 0 }
    if (key === 'V') { out('lslocks from util-linux 2.40 (ecmaOS)\n'); return 0 }
    if (key === 'b') bytes = true
    else if (key === 'J') json = true
    else if (key === 'n') headings = false
    else if (key === 'r') raw = true
    else if (key === 'all') columns = ALL
    else if (key === 'o') {
      const list = (value.startsWith('+') ? [...DEFAULT, ...value.slice(1).split(',')] : value.split(',')).map(name => name.toUpperCase())
      const bad = list.find(name => !ALL.includes(name))
      if (bad) { err(`unknown column: ${bad}`); return 1 }
      columns = list
    } else if (key === 'p') {
      if (!/^\d+$/.test(value)) { err(`invalid PID argument: '${value}'`); return 1 }
      only = Number(value)
    }
  }

  const text = readSmall('/proc/locks')
  if (text === undefined) { err('cannot open /proc/locks'); return 1 }
  const procs = new Map(processes().map(p => [p.pid, p]))
  const rows = []
  for (const line of text.split('\n')) {
    const match = /^\d+:\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+([0-9a-f]+):([0-9a-f]+):(\d+)\s+(\d+)\s+(\d+|EOF)$/.exec(line.trim())
    if (!match) continue
    const [, type, , mode, pidText, major, minor, inode, start, end] = match
    const pid = Number(pidText)
    if (only !== undefined && pid !== only) continue
    const owner = procs.get(pid)
    let path = ''
    let size = 0
    for (const file of openFiles(pid)) {
      try {
        const info = stat(file.path)
        if (String(info.ino) === inode) { path = file.path; size = info.size; break }
      } catch { /* not a file */ }
    }
    rows.push({
      COMMAND: owner?.comm ?? '', PID: String(pid), TYPE: type, SIZE: bytes ? String(size) : human(size), INODE: inode,
      'MAJ:MIN': `${parseInt(major, 16)}:${parseInt(minor, 16)}`, MODE: mode, M: '0', START: start, END: end === 'EOF' ? '0' : end, PATH: path, BLOCKER: ''
    })
  }
  if (json) {
    out(JSON.stringify({ locks: rows.map(row => Object.fromEntries(columns.map(column => [column.toLowerCase(), /^(PID|INODE|START|END|M)$/.test(column) ? Number(row[column]) : row[column] || null]))) }, null, 3) + '\n')
    return 0
  }
  const table = [...(headings ? [Object.fromEntries(columns.map(column => [column, column]))] : []), ...rows]
  if (raw) { out(table.map(row => columns.map(column => row[column] || '').join(' ')).join('\n') + (table.length ? '\n' : '')); return 0 }
  const widths = columns.map(column => Math.max(...table.map(row => (row[column] ?? '').length)))
  out(table.map(row => columns.map((column, i) => {
    const cell = row[column] ?? ''
    return i === columns.length - 1 ? cell : RIGHT.has(column) ? cell.padStart(widths[i]) : cell.padEnd(widths[i])
  }).join(' ').trimEnd()).join('\n') + (table.length ? '\n' : ''))
  return 0
}

try {
  exit(main())
} catch (error) {
  err(reasonOf(error))
  exit(1)
}
