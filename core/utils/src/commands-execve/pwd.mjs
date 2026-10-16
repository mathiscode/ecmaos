/**
 * Print the working directory, as the shell's `pwd` does: `-L` (the default) the logical name the shell keeps in `$PWD`
 * when it still names this directory, `-P` the physical one with every symlink resolved.
 */

import { getopt, tryHelp } from './lib/getopt.mjs'
import { canonicalize } from './lib/canon.mjs'

const sys = globalThis.ecmaosSyscalls
const { argv, exit, writeAll, getcwd, env } = sys

const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`pwd: ${text}\n`))

const usage = `Usage: pwd [OPTION]...
Print the full filename of the current working directory.

  -L, --logical   use PWD from environment, even if it contains symlinks
  -P, --physical  avoid all symlinks
      --help        display this help and exit
      --version     output version information and exit

If no option is specified, -L is assumed.
`

function main() {
  const { options, operands, error } = getopt(argv.slice(1), { short: 'LP', long: { logical: 'L', physical: 'P', help: 'help', version: 'version' } })
  if (error) { err(error); writeAll(2, encoder.encode(tryHelp('pwd') + '\n')); return 1 }
  const keys = options.map(([key]) => key)
  if (keys.includes('help')) { out(usage); return 0 }
  if (keys.includes('version')) { out('pwd (ecmaOS coreutils) 1.0\n'); return 0 }
  void operands
  const physicalWanted = keys.filter(key => key === 'L' || key === 'P').pop() === 'P'
  const cwd = getcwd()
  let physical = cwd
  try { physical = canonicalize(cwd, '/', sys, { mode: 'e' }) } catch { /* keep the name the process has */ }
  if (!physicalWanted) {
    const logical = env.PWD
    if (logical && logical.startsWith('/')) {
      try {
        if (canonicalize(logical, '/', sys, { mode: 'e' }) === physical) { out(logical + '\n'); return 0 }
      } catch { /* $PWD is stale: fall back to the physical name */ }
    }
  }
  out(physical + '\n')
  return 0
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
