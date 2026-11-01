/**
 * Make named pipes (FIFOs), as GNU `mkfifo` does. A new FIFO gets 0666 less the umask; `-m MODE` sets it exactly (octal
 * or symbolic, relative to 0666 less the umask). Opening one for reading waits for a writer, and the other way round.
 */

import { resolve } from './lib/path-utils.mjs'
import { getopt, tryHelp } from './lib/getopt.mjs'
import { reasonOf } from './lib/errno.mjs'
import { compile } from './lib/mode.mjs'
import { chmodOwned } from './lib/owner-ops.mjs'

const sys = globalThis.ecmaosSyscalls
const { argv, exit, writeAll, getcwd } = sys

const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`mkfifo: ${text}\n`))
const hint = () => writeAll(2, encoder.encode(tryHelp('mkfifo') + '\n'))

const S_IFIFO = 0o010000

const usage = `Usage: mkfifo [OPTION]... NAME...
Create named pipes (FIFOs) with the given NAMEs.

Mandatory arguments to long options are mandatory for short options too.
  -m, --mode=MODE    set file permission bits to MODE, not a=rw - umask
  -Z                   set the SELinux security context to default type
      --context[=CTX]  like -Z, or if CTX is specified then set the SELinux
                         or SMACK security context to CTX
      --help        display this help and exit
      --version     output version information and exit
`

async function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'm:Z',
    long: { mode: { key: 'm', arg: 'required' }, context: { key: 'Z', arg: 'optional' }, help: 'h', version: 'V' }
  })
  if (error) { err(error); hint(); return 1 }
  const has = key => options.some(([k]) => k === key)
  if (has('h')) { out(usage); return 0 }
  if (has('V')) { out('mkfifo (ecmaOS coreutils) 1.0\n'); return 0 }
  if (operands.length === 0) { err('missing operand'); hint(); return 1 }

  let umask = 0o022
  try { const m = Number(await sys.custom('proc_umask', -1)); if (m >= 0) umask = m } catch { /* default */ }

  let mode
  const modeOption = options.filter(([k]) => k === 'm').pop()
  if (modeOption) {
    const compiled = compile(String(modeOption[1]), umask)
    if (!compiled) { err(`invalid mode ‘${modeOption[1]}’`); return 1 }
    mode = compiled(0o666 & ~umask, false) & 0o7777
  }

  const cwd = getcwd()
  let failed = false
  for (const operand of operands) {
    const path = resolve(cwd, operand)
    try {
      await sys.custom('mknod', path, S_IFIFO | (mode ?? (0o666 & ~umask)), 0)
    } catch (e) {
      err(`cannot create fifo '${operand}': ${reasonOf(e)}`)
      failed = true
      continue
    }
    // the mode asked for is exact, whatever the umask took out of it
    if (mode !== undefined && mode !== (0o666 & ~umask)) {
      try { await chmodOwned(sys, path, mode) } catch (c) {
        err(`cannot set permissions of '${operand}': ${reasonOf(c)}`)
        failed = true
      }
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
