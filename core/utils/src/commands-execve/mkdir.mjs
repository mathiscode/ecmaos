/**
 * Make directories, as GNU `mkdir` does. A new directory gets 0777 less the umask; `-m MODE` sets it exactly (octal
 * or symbolic, relative to 0777 less the umask). `-p` creates missing parents (each with the owner able to write and
 * search), accepts a directory that exists already, and `-v` names each directory created.
 */

import { resolve } from './lib/path-utils.mjs'
import { getopt, tryHelp } from './lib/getopt.mjs'
import { reasonOf } from './lib/errno.mjs'
import { compile } from './lib/mode.mjs'
import { chmodOwned } from './lib/owner-ops.mjs'

const sys = globalThis.ecmaosSyscalls
const { argv, exit, writeAll, mkdir, getcwd, stat } = sys

const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`mkdir: ${text}\n`))
const hint = () => writeAll(2, encoder.encode(tryHelp('mkdir') + '\n'))

const S_IFMT = 0xf000
const S_IFDIR = 0x4000

const usage = `Usage: mkdir [OPTION]... DIRECTORY...
Create the DIRECTORY(ies), if they do not already exist.

Mandatory arguments to long options are mandatory for short options too.
  -m, --mode=MODE   set file mode (as in chmod), not a=rwx - umask
  -p, --parents     no error if existing, make parent directories as needed,
                      with their file modes unaffected by any -m option.
  -v, --verbose     print a message for each created directory
  -Z                   set SELinux security context of each created directory
                         to the default type
      --context[=CTX]  like -Z, or if CTX is specified then set the SELinux
                         or SMACK security context to CTX
      --help        display this help and exit
      --version     output version information and exit
`

const isDirectory = path => {
  try { return (stat(path).mode & S_IFMT) === S_IFDIR } catch { return false }
}
const exists = path => {
  try { stat(path); return true } catch { return false }
}

async function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'm:pvZ',
    long: { mode: { key: 'm', arg: 'required' }, parents: 'p', verbose: 'v', context: { key: 'Z', arg: 'optional' }, help: 'h', version: 'V' }
  })
  if (error) { err(error); hint(); return 1 }
  const has = key => options.some(([k]) => k === key)
  if (has('h')) { out(usage); return 0 }
  if (has('V')) { out('mkdir (ecmaOS coreutils) 1.0\n'); return 0 }
  if (operands.length === 0) { err('missing operand'); hint(); return 1 }

  let umask = 0o022
  try { const m = Number(await sys.custom('proc_umask', -1)); if (m >= 0) umask = m } catch { /* default */ }
  const base = 0o777 & ~umask

  let mode
  const modeOption = options.filter(([k]) => k === 'm').pop()
  if (modeOption) {
    const compiled = compile(String(modeOption[1]), umask)
    if (!compiled) { err(`invalid mode ‘${modeOption[1]}’`); return 1 }
    mode = compiled(0o777 & ~umask, true) & 0o7777
  }

  const parents = has('p')
  const verbose = has('v')
  const cwd = getcwd()
  let failed = false
  const fail = (name, e) => { err(`cannot create directory '${name}': ${reasonOf(e)}`); failed = true }

  const make = async (display, path, own) => {
    try {
      mkdir(path, own)
    } catch (e) {
      return e
    }
    if (verbose) out(`mkdir: created directory '${display}'\n`)
    return undefined
  }

  for (const operand of operands) {
    const path = resolve(cwd, operand)
    if (parents) {
      // every missing ancestor first, each with write and search for its owner
      const trimmed = operand.replace(/\/+$/, '') || '/'
      const pieces = trimmed.split('/')
      let prefix = ''
      let stop = false
      for (let i = 0; i < pieces.length - 1 && !stop; i++) {
        prefix = i === 0 ? pieces[0] : prefix === '/' ? `/${pieces[i]}` : `${prefix}/${pieces[i]}`
        if (prefix === '') { prefix = '/'; continue }
        const shown = prefix === '/' ? '/' : prefix
        const walked = resolve(cwd, shown)
        if (exists(walked)) {
          if (!isDirectory(walked)) { fail(shown, Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' })); stop = true }
          continue
        }
        const e = await make(shown, walked, (base | 0o300) & 0o777)
        if (e) { fail(shown, e); stop = true }
      }
      if (stop) continue
      if (isDirectory(path)) continue
    }
    const e = await make(operand, path, base)
    if (e) { fail(operand, e); continue }
    if (mode !== undefined && mode !== base) {
      try { await chmodOwned(sys, path, mode) } catch (c) {
        err(`cannot set permissions of directory '${operand}': ${reasonOf(c)}`)
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
