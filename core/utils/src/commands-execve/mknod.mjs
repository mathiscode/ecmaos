/**
 * Make special files, as GNU `mknod` does, for the kinds that need no driver: `p` makes a named pipe. `b`, `c` and `u`
 * name device nodes, which are made by the kernel's drivers here and not by a command, so they are refused. `-m MODE`
 * sets the permission bits exactly.
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
const err = text => writeAll(2, encoder.encode(`mknod: ${text}\n`))
const hint = () => writeAll(2, encoder.encode(tryHelp('mknod') + '\n'))

const S_IFIFO = 0o010000
const S_IFCHR = 0o020000
const S_IFBLK = 0o060000

const usage = `Usage: mknod [OPTION]... NAME TYPE [MAJOR MINOR]
Create the special file NAME of the given TYPE.

Mandatory arguments to long options are mandatory for short options too.
  -m, --mode=MODE    set file permission bits to MODE, not a=rw - umask
  -Z                   set the SELinux security context to default type
      --context[=CTX]  like -Z, or if CTX is specified then set the SELinux
                         or SMACK security context to CTX
      --help        display this help and exit
      --version     output version information and exit

Both MAJOR and MINOR must be specified when TYPE is b, c, or u, and they
must be omitted when TYPE is p.  If MAJOR or MINOR begins with 0x or 0X,
it is interpreted as hexadecimal; otherwise, if it begins with 0, as octal;
otherwise, as decimal.  TYPE may be:

  b      create a block (buffered) special file
  c, u   create a character (unbuffered) special file
  p      create a FIFO
`

async function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'm:Z',
    long: { mode: { key: 'm', arg: 'required' }, context: { key: 'Z', arg: 'optional' }, help: 'h', version: 'V' }
  })
  if (error) { err(error); hint(); return 1 }
  const has = key => options.some(([k]) => k === key)
  if (has('h')) { out(usage); return 0 }
  if (has('V')) { out('mknod (ecmaOS coreutils) 1.0\n'); return 0 }
  if (operands.length === 0) { err('missing operand'); hint(); return 1 }
  if (operands.length === 1) { err(`missing operand after ‘${operands[0]}’`); hint(); return 1 }

  const [name, type, ...numbers] = operands
  if (!/^[bcup]$/.test(type)) { err(`invalid device type ‘${type}’`); hint(); return 1 }
  if (type === 'p') {
    if (numbers.length) { err("Fifos do not have major and minor device numbers"); hint(); return 1 }
  } else if (numbers.length < 2) {
    err(numbers.length ? `missing operand after ‘${numbers[0]}’` : 'Special files require major and minor device numbers')
    hint()
    return 1
  } else if (numbers.length > 2) {
    err(`extra operand ‘${numbers[2]}’`)
    hint()
    return 1
  }

  let umask = 0o022
  try { const m = Number(await sys.custom('proc_umask', -1)); if (m >= 0) umask = m } catch { /* default */ }
  let mode
  const modeOption = options.filter(([k]) => k === 'm').pop()
  if (modeOption) {
    const compiled = compile(String(modeOption[1]), umask)
    if (!compiled) { err(`invalid mode ‘${modeOption[1]}’`); return 1 }
    mode = compiled(0o666 & ~umask, false) & 0o7777
  }

  const kind = type === 'p' ? S_IFIFO : type === 'b' ? S_IFBLK : S_IFCHR
  const path = resolve(getcwd(), name)
  try {
    await sys.custom('mknod', path, kind | (mode ?? (0o666 & ~umask)), 0)
  } catch (e) {
    err(`${name}: ${reasonOf(e)}`)
    return 1
  }
  if (mode !== undefined && mode !== (0o666 & ~umask)) {
    try { await chmodOwned(sys, path, mode) } catch (c) {
      err(`cannot set permissions of '${name}': ${reasonOf(c)}`)
      return 1
    }
  }
  return 0
}

try {
  exit(await main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
