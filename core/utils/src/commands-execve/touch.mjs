/**
 * Change file timestamps, as GNU `touch` does: create a file that does not exist (unless `-c`), and set its access
 * and/or modification time to now, to `-d STRING`, to `-t STAMP` or to those of `-r FILE`. `-a` and `-m` limit which
 * time is changed.
 */

import { resolve } from './lib/path-utils.mjs'
import { utimesOwned, lutimesOwned } from './lib/owner-ops.mjs'
import { getopt, tryHelp } from './lib/getopt.mjs'
import { reasonOf } from './lib/errno.mjs'
import { parseDate, parseTouchStamp } from './lib/datespec.mjs'

const sys = globalThis.ecmaosSyscalls
const { argv, exit, writeAll, getcwd, open, close, stat, lstat, O_WRONLY, O_CREAT } = sys

const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`touch: ${text}\n`))
const hint = () => writeAll(2, encoder.encode(tryHelp('touch') + '\n'))

const usage = `Usage: touch [OPTION]... FILE...
Update the access and modification times of each FILE to the current time.

A FILE argument that does not exist is created empty, unless -c is supplied.

  -a                     change only the access time
  -c, --no-create        do not create any files
  -d, --date=STRING      parse STRING and use it instead of current time
  -f                     (ignored)
  -h, --no-dereference   affect each symbolic link instead of any referenced file
  -m                     change only the modification time
  -r, --reference=FILE   use this file's times instead of current time
  -t STAMP               use [[CC]YY]MMDDhhmm[.ss] instead of current time
      --time=WORD        change the specified time: WORD is access, atime, or use, or modify or mtime
      --help             display this help and exit`

async function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'acd:fhmr:t:',
    long: {
      'no-create': 'c', date: { key: 'd', arg: 'required' }, 'no-dereference': 'h', reference: { key: 'r', arg: 'required' },
      time: { key: 'time', arg: 'required' }, help: 'help'
    }
  })
  
  if (error) { err(error); hint(); return 1 }

  let accessOnly = false, modifyOnly = false, noCreate = false, noDereference = false
  let source
  let date, stamp, reference
  for (const [key, value] of options) {
    if (key === 'help') { out(usage + '\n'); return 0 }
    else if (key === 'a') accessOnly = true
    else if (key === 'm') modifyOnly = true
    else if (key === 'c') noCreate = true
    else if (key === 'h') noDereference = true
    else if (key === 'd') date = value
    else if (key === 't') stamp = value
    else if (key === 'r') reference = value
    else if (key === 'time') {
      if (/^(access|atime|use)$/.test(value)) accessOnly = true
      else if (/^(modify|mtime)$/.test(value)) modifyOnly = true
      else { err(`invalid argument '${value}' for '--time'`); hint(); return 1 }
    }
  }
  if (operands.length === 0) { err('missing file operand'); hint(); return 1 }
  if ([date, stamp, reference].filter(v => v !== undefined).length > 1) { err('cannot specify times from more than one source'); hint(); return 1 }

  const cwd = getcwd()
  const now = Date.now()
  let atimeMs = now
  let mtimeMs = now
  if (date !== undefined) {
    const time = parseDate(date, now)
    if (Number.isNaN(time)) { err(`invalid date format '${date}'`); return 1 }
    atimeMs = mtimeMs = time
    source = 'given'
  } else if (stamp !== undefined) {
    const time = parseTouchStamp(stamp, now)
    if (Number.isNaN(time)) { err(`invalid date format '${stamp}'`); return 1 }
    atimeMs = mtimeMs = time
    source = 'given'
  } else if (reference !== undefined) {
    try {
      const stats = stat(resolve(cwd, reference))
      atimeMs = stats.atimeMs
      mtimeMs = stats.mtimeMs
    } catch (error) {
      err(`failed to get attributes of '${reference}': ${reasonOf(error)}`)
      return 1
    }
    source = 'given'
  }
  const both = !accessOnly && !modifyOnly || (accessOnly && modifyOnly)

  let failed = false
  for (const operand of operands) {
    // "-" means standard output, which has no name to touch
    if (operand === '-') continue
    const path = resolve(cwd, operand)
    let existing = null
    let onLink = false
    // `-h` on a symlink stamps the link itself, whether or not its target exists
    if (noDereference) {
      try { const link = lstat(path); if ((link.mode & 0xf000) === 0xa000) { existing = link; onLink = true } } catch { /* not there */ }
    }
    if (!existing) try { existing = stat(path) } catch { /* created below */ }
    // a dangling symlink has no file to stamp: -c skips it, and without -c opening it creates the file it names
    if (!existing) {
      if (noCreate) continue
      try {
        close(open(path, O_WRONLY | O_CREAT, 0o666))
      } catch (error) {
        err(`cannot touch '${operand}': ${reasonOf(error)}`)
        failed = true
        continue
      }
      // A new file is stamped now; only a requested time or a single-time option changes that
      if (source === undefined && both) continue
      try { existing = stat(path) } catch { existing = { atimeMs: now, mtimeMs: now } }
    }
    const atime = both || accessOnly ? atimeMs : existing.atimeMs
    const mtime = both || modifyOnly ? mtimeMs : existing.mtimeMs
    try {
      await (onLink ? lutimesOwned : utimesOwned)(sys, path, atime / 1000, mtime / 1000)
    } catch (error) {
      err(`setting times of '${operand}': ${reasonOf(error)}`)
      failed = true
    }
  }
  return failed ? 1 : 0
}

try {
  exit(await main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
