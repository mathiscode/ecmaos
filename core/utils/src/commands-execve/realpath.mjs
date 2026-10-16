/**
 * Print the resolved absolute file name, as GNU `realpath` does: every symlink is followed (`-s` leaves them),
 * `-e` needs every component to exist, `-m` none, and by default all but the last. `--relative-to` and
 * `--relative-base` print the path relative to a directory.
 */

import { relative } from './lib/path-utils.mjs'
import { getopt, tryHelp } from './lib/getopt.mjs'
import { reasonOf, quotef } from './lib/errno.mjs'
import { canonicalize } from './lib/canon.mjs'

const sys = globalThis.ecmaosSyscalls
const { argv, exit, writeAll, getcwd } = sys

const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`realpath: ${text}\n`))
const hint = () => writeAll(2, encoder.encode(tryHelp('realpath') + '\n'))

const usage = `Usage: realpath [OPTION]... FILE...
Print the resolved absolute file name;
all but the last component must exist

  -e, --canonicalize-existing  all components of the path must exist
  -m, --canonicalize-missing   no path components need exist or be a directory
  -L, --logical                resolve '..' components before symlinks
  -P, --physical               resolve symlinks as encountered (default)
  -q, --quiet                  suppress most error messages
      --relative-to=DIR        print the resolved path relative to DIR
      --relative-base=DIR      print absolute paths unless paths below DIR
  -s, --strip, --no-symlinks   don't expand symlinks
  -z, --zero                   end each output line with NUL, not newline
      --help                   display this help and exit`

function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'emLPqsz',
    long: {
      'canonicalize-existing': 'e', 'canonicalize-missing': 'm', logical: 'L', physical: 'P', quiet: 'q', strip: 's',
      'no-symlinks': 's', zero: 'z', 'relative-to': { key: 'to', arg: 'required' }, 'relative-base': { key: 'base', arg: 'required' }, help: 'help'
    }
  })
  if (error) { err(error); hint(); return 1 }
  let mode = 'f', logical = false, symlinks = true, quiet = false, terminator = '\n', relativeTo, relativeBase
  for (const [key, value] of options) {
    if (key === 'help') { out(usage + '\n'); return 0 }
    else if (key === 'e') mode = 'e'
    else if (key === 'm') mode = 'm'
    else if (key === 'L') logical = true
    else if (key === 'P') logical = false
    else if (key === 'q') quiet = true
    else if (key === 's') symlinks = false
    else if (key === 'z') terminator = '\0'
    else if (key === 'to') relativeTo = value
    else if (key === 'base') relativeBase = value
  }
  if (operands.length === 0) { err('missing operand'); hint(); return 1 }

  const cwd = getcwd()
  let failed = false
  const canon = (path, requested) => canonicalize(path, cwd, sys, { mode: requested, logical, symlinks })
  let toPath, basePath
  try {
    if (relativeTo !== undefined) toPath = canon(relativeTo, 'm')
    if (relativeBase !== undefined) basePath = canon(relativeBase, 'm')
  } catch (error) {
    err(`${quotef(relativeTo ?? relativeBase)}: ${reasonOf(error)}`)
    return 1
  }
  const under = (path, dir) => path === dir || path.startsWith(dir === '/' ? '/' : dir + '/')

  for (const operand of operands) {
    let path
    try {
      path = canon(operand, mode)
    } catch (error) {
      if (!quiet) err(`${quotef(operand)}: ${reasonOf(error)}`)
      failed = true
      continue
    }
    if (basePath !== undefined && !under(path, basePath)) { out(path + terminator); continue }
    if (basePath !== undefined && toPath === undefined) { out((relative(basePath, path) || '.') + terminator); continue }
    if (toPath !== undefined) {
      if (basePath !== undefined && !under(toPath, basePath)) { out(path + terminator); continue }
      out((relative(toPath, path) || '.') + terminator)
      continue
    }
    out(path + terminator)
  }
  return failed ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
