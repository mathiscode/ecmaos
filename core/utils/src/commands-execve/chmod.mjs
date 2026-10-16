/**
 * Change file modes, as GNU `chmod` does: an octal or symbolic MODE (a symbolic clause without a class obeys the
 * umask), `--reference=RFILE`, and `-R` through a tree without following symlinks. A mode that begins with `-`
 * (`chmod -w file`) is a mode, not an option. `-c` and `-v` report each change, `-f` silences errors.
 */

import { resolve } from './lib/path-utils.mjs'
import { reasonOf, is } from './lib/errno.mjs'
import { chmodOwned } from './lib/owner-ops.mjs'
import { compile, describe } from './lib/mode.mjs'

const sys = globalThis.ecmaosSyscalls
const { argv, exit, writeAll, getcwd, stat, lstat, readdir } = sys

const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const errLine = text => writeAll(2, encoder.encode(`chmod: ${text}\n`))
const hint = () => writeAll(2, encoder.encode("Try 'chmod --help' for more information.\n"))

const S_IFMT = 0xf000
const S_IFDIR = 0x4000
const S_IFLNK = 0xa000

const usage = `Usage: chmod [OPTION]... MODE[,MODE]... FILE...
  or:  chmod [OPTION]... OCTAL-MODE FILE...
  or:  chmod [OPTION]... --reference=RFILE FILE...
Change the mode of each FILE to MODE.
With --reference, change the mode of each FILE to that of RFILE.

  -c, --changes          like verbose but report only when a change is made
  -f, --silent, --quiet  suppress most error messages
  -v, --verbose          output a diagnostic for every file processed
      --no-preserve-root  do not treat '/' specially (the default)
      --preserve-root    fail to operate recursively on '/'
      --reference=RFILE  use RFILE's mode instead of MODE values
  -R, --recursive        change files and directories recursively
      --help        display this help and exit
      --version     output version information and exit

Each MODE is of the form '[ugoa]*([-+=]([rwxXst]*|[ugo]))+|[-+=][0-7]+'.
`

const LONG = {
  changes: 'c', silent: 'f', quiet: 'f', verbose: 'v', recursive: 'R', help: 'h', version: 'V',
  'no-preserve-root': 'n', 'preserve-root': 'p', reference: 'r'
}

/** The curly quotes GNU's `quote()` uses in a UTF-8 locale */
const quote = text => `‘${text}’`

function parseArgs(args) {
  const flags = new Set()
  const operands = []
  let reference
  let i = 0
  for (; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { i++; break }
    if (!arg.startsWith('-') || arg === '-') break
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      const given = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
      const names = Object.keys(LONG).filter(name => name === given || name.startsWith(given))
      const exact = names.find(name => name === given)
      const distinct = new Set(names.map(name => LONG[name]))
      if (!exact && names.length === 0) return { error: `unrecognized option '${arg.split('=')[0]}'` }
      if (!exact && distinct.size > 1) return { error: `option '--${given}' is ambiguous; possibilities:${names.map(n => ` '--${n}'`).join('')}` }
      const name = exact ?? names[0]
      const key = LONG[name]
      if (key === 'r') {
        if (eq !== -1) reference = arg.slice(eq + 1)
        else if (i + 1 < args.length) reference = args[++i]
        else return { error: `option '--${name}' requires an argument` }
      } else if (eq !== -1) return { error: `option '--${name}' doesn't allow an argument` }
      else flags.add(key)
      continue
    }
    // a cluster of option letters, or a mode such as -w or -x
    let isMode = false
    for (const letter of arg.slice(1)) {
      if ('Rcfv'.includes(letter)) flags.add(letter)
      else { isMode = true; break }
    }
    if (isMode) break
  }
  operands.push(...args.slice(i))
  return { flags, operands, reference }
}

async function main() {
  const { flags, operands, reference, error } = parseArgs(argv.slice(1))
  if (error) { errLine(error); hint(); return 1 }
  if (flags.has('h')) { out(usage); return 0 }
  if (flags.has('V')) { out('chmod (ecmaOS coreutils) 1.0\n'); return 0 }

  const quiet = flags.has('f')
  const verbose = flags.has('v')
  const changes = flags.has('c')
  const recursive = flags.has('R')
  const cwd = getcwd()
  const names = [...operands]
  let compiled
  let modeText
  let fixed

  if (reference !== undefined) {
    if (names.length === 0) { errLine(`missing operand after ${quote(reference)}`); hint(); return 1 }
    try { fixed = stat(resolve(cwd, reference)).mode & 0o7777 } catch (e) {
      errLine(`failed to get attributes of ${quote(reference)}: ${reasonOf(e)}`)
      return 1
    }
  } else {
    if (names.length === 0) { errLine('missing operand'); hint(); return 1 }
    modeText = names.shift()
    if (names.length === 0) { errLine(`missing operand after ${quote(modeText)}`); hint(); return 1 }
    let umask = 0o022
    try { const m = Number(await sys.custom('proc_umask', -1)); if (m >= 0) umask = m } catch { /* default */ }
    compiled = compile(modeText, umask)
    if (!compiled) { errLine(`invalid mode: ${quote(modeText)}`); hint(); return 1 }
  }

  if (recursive && flags.has('p') && names.some(name => /^\/+$/.test(name))) {
    errLine("it is dangerous to operate recursively on '/'")
    errLine('use --no-preserve-root to override this failsafe')
    return 1
  }

  let failed = false
  const fail = text => { if (!quiet) errLine(text); failed = true }

  const apply = async (display, path, stats) => {
    const isDir = (stats.mode & S_IFMT) === S_IFDIR
    const old = stats.mode & 0o7777
    const next = fixed ?? compiled(old, isDir)
    try {
      await chmodOwned(sys, path, next)
    } catch (e) {
      fail(`changing permissions of '${display}': ${reasonOf(e)}`)
      return
    }
    if (next !== old) {
      if (verbose || changes) out(`mode of '${display}' changed from ${describe(old)} to ${describe(next)}\n`)
    } else if (verbose) out(`mode of '${display}' retained as ${describe(old)}\n`)
  }

  const walk = async (display, path) => {
    let names
    try { names = readdir(path) } catch (e) { fail(`cannot read directory '${display}': ${reasonOf(e)}`); return }
    names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    for (const name of names) {
      const childDisplay = display.endsWith('/') ? display + name : `${display}/${name}`
      const childPath = `${path}/${name}`
      let stats
      try { stats = lstat(childPath) } catch (e) { fail(`cannot access '${childDisplay}': ${reasonOf(e)}`); continue }
      // a symlink met while descending is left alone
      if ((stats.mode & S_IFMT) === S_IFLNK) continue
      await apply(childDisplay, childPath, stats)
      if ((stats.mode & S_IFMT) === S_IFDIR) await walk(childDisplay, childPath)
    }
  }

  for (const name of names) {
    const path = resolve(cwd, name)
    let stats
    try { stats = stat(path) } catch (e) {
      if (is(e, 'ENOENT')) {
        let dangling = false
        try { dangling = (lstat(path).mode & S_IFMT) === S_IFLNK } catch { /* absent */ }
        fail(dangling ? `cannot operate on dangling symlink '${name}'` : `cannot access '${name}': ${reasonOf(e)}`)
      } else fail(`cannot access '${name}': ${reasonOf(e)}`)
      continue
    }
    await apply(name, path, stats)
    if (recursive && (stats.mode & S_IFMT) === S_IFDIR) await walk(name, path)
  }
  return failed ? 1 : 0
}

try {
  exit(await main())
} catch (error) {
  errLine(error instanceof Error ? error.message : String(error))
  exit(1)
}
