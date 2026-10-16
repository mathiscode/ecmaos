/**
 * Print the value of a symbolic link, or with `-f`, `-e` or `-m` the canonical file name, as GNU `readlink` does.
 * A file that is not a symlink, or cannot be resolved, prints nothing and fails quietly unless `-v`.
 */

import { getopt, tryHelp } from './lib/getopt.mjs'
import { reasonOf, quotef } from './lib/errno.mjs'
import { canonicalize } from './lib/canon.mjs'

const sys = globalThis.ecmaosSyscalls
const { argv, exit, writeAll, getcwd, readlink } = sys

const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`readlink: ${text}\n`))
const hint = () => writeAll(2, encoder.encode(tryHelp('readlink') + '\n'))

const usage = `Usage: readlink [OPTION]... FILE...
Print value of a symbolic link or canonical file name

  -f, --canonicalize            canonicalize by following every symlink in every component of the given name recursively; all but the last component must exist
  -e, --canonicalize-existing   canonicalize by following every symlink in every component of the given name recursively, all components must exist
  -m, --canonicalize-missing    canonicalize by following every symlink in every component of the given name recursively, without requirements on components existence
  -n, --no-newline              do not output the trailing delimiter
  -q, --quiet
  -s, --silent                  suppress most error messages (on by default)
  -v, --verbose                 report error messages
  -z, --zero                    end each output line with NUL, not newline
      --help                    display this help and exit`

function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'femnqsvz',
    long: {
      canonicalize: 'f', 'canonicalize-existing': 'e', 'canonicalize-missing': 'm', 'no-newline': 'n', quiet: 'q', silent: 's', verbose: 'v', zero: 'z', help: 'help'
    }
  })
  if (error) { err(error); hint(); return 1 }
  let mode, verbose = false, newline = true, terminator = '\n'
  for (const [key] of options) {
    if (key === 'help') { out(usage + '\n'); return 0 }
    else if (key === 'f') mode = 'f'
    else if (key === 'e') mode = 'e'
    else if (key === 'm') mode = 'm'
    else if (key === 'v') verbose = true
    else if (key === 'q' || key === 's') verbose = false
    else if (key === 'n') newline = false
    else if (key === 'z') terminator = '\0'
  }
  if (operands.length === 0) { err('missing operand'); hint(); return 1 }
  // -n is ignored with several operands, as GNU does
  if (operands.length > 1) newline = true

  const cwd = getcwd()
  let failed = false
  for (const operand of operands) {
    try {
      const text = mode ? canonicalize(operand, cwd, sys, { mode }) : readlink(operand.startsWith('/') ? operand : `${cwd.replace(/\/$/, '')}/${operand}`)
      out(text + (newline ? terminator : ''))
    } catch (error) {
      if (verbose) err(`${quotef(operand)}: ${reasonOf(error)}`)
      failed = true
    }
  }
  return failed ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
