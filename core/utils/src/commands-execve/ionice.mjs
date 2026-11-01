/**
 * `ionice`: run a command with an I/O scheduling class, or show a process's. Nothing here schedules I/O (the file systems
 * are the browser's storage), so a class is checked and kept out of the way: a command runs as it is, and `-p` says
 * `none: prio 0`, the class of a process that never set one.
 */

import { findProgram, run } from './lib/run.mjs'

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`ionice: ${text}\n`))

const usage = `Usage:
 ionice [options] -p <pid>...
 ionice [options] <command>

Show or change the I/O-scheduling class and priority of a process.

Options:
 -c, --class <class>    name or number of scheduling class,
                          0: none, 1: realtime, 2: best-effort, 3: idle
 -n, --classdata <num>  priority (0..7) in the specified scheduling class,
                          only for the realtime and best-effort classes
 -p, --pid <pid>...     act on these already running processes
 -t, --ignore           ignore failures
 -h, --help             display this help
 -V, --version          display version

I/O is not scheduled here, so a class and priority are checked and not applied.`

const classes = { none: 0, realtime: 1, 'best-effort': 2, idle: 3 }

async function main() {
  const args = argv.slice(1)
  let klass
  let data
  let pids = false
  while (args.length && args[0].startsWith('-') && args[0] !== '-') {
    const arg = args.shift()
    if (arg === '--') break
    if (arg === '-h' || arg === '--help') { out(usage + '\n'); return 0 }
    if (arg === '-V' || arg === '--version') { out('ionice (ecmaOS coreutils) 1.0\n'); return 0 }
    const long = /^--(class|classdata)(?:=(.*))?$/.exec(arg)
    const short = /^-([cn])(.*)$/.exec(arg)
    if (long || short) {
      const name = long ? (long[1] === 'class' ? 'c' : 'n') : short[1]
      const value = (long ? long[2] : short[2]) || args.shift()
      if (name === 'c') klass = value in classes ? classes[value] : /^\d$/.test(value) ? Number(value) : NaN
      else data = /^\d+$/.test(value ?? '') ? Number(value) : NaN
    } else if (arg === '-p' || arg === '--pid') pids = true
    else if (arg === '-t' || arg === '--ignore') { /* failures are not reported anyway */ }
    else { err(`invalid option -- '${arg.replace(/^-+/, '')}'\nTry 'ionice --help' for more information.`); return 1 }
  }
  if (Number.isNaN(klass) || klass > 3) { err('unknown scheduling class'); return 1 }
  if (Number.isNaN(data) || data > 7) { err('invalid argument: priority out of range'); return 1 }
  if (pids) {
    if (!args.length || args.some(pid => !/^\d+$/.test(pid))) { err('bad usage\nTry \'ionice --help\' for more information.'); return 1 }
    if (klass === undefined && data === undefined) for (const pid of args) out(args.length > 1 ? `${pid}: none: prio 0\n` : 'none: prio 0\n')
    return 0
  }
  if (!args.length) { out('none: prio 0\n'); return 0 }
  const program = findProgram(args[0])
  if (!program) { err(`failed to execute ${args[0]}: No such file or directory`); return 127 }
  try { return (await run(program, args)).status } catch (error) {
    err(`failed to execute ${args[0]}: ${error?.message ?? error}`)
    return 126
  }
}

try {
  exit(await main())
} catch (error) {
  err(error?.message ?? String(error))
  exit(1)
}
