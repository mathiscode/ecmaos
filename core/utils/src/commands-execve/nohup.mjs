/**
 * Run a command that should keep its output when the terminal goes away: `nohup long-job &`.
 *
 * As on Linux, when standard input is a terminal the command reads nothing (it gets end of file), and when
 * standard output is a terminal its output is appended to `nohup.out` (or `~/nohup.out`) instead, with a
 * note on standard error. Standard error follows standard output when it was a terminal too. ecmaOS never
 * sends SIGHUP when a terminal closes, so there is no hangup for the command to ignore; this is what is left.
 */

import { findProgram, openDevNull, run } from './lib/run.mjs'
import { isTty } from './lib/tty.mjs'

const sys = globalThis.ecmaosSyscalls
const { argv, exit, writeAll, open, lseek, env, O_WRONLY, O_CREAT } = sys

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(text + '\n'))

const usage = `Usage: nohup COMMAND [ARG]...
Run COMMAND, with no input and with its output in nohup.out if it would have gone to a terminal.

  --help  display this help and exit`

function openLog() {
  for (const path of ['nohup.out', `${env.HOME ?? ''}/nohup.out`]) {
    if (path.startsWith('/nohup.out')) continue
    try {
      const fd = open(path, O_WRONLY | O_CREAT, 0o600)
      lseek(fd, 0, 2)
      return { fd, path }
    } catch { /* try the home directory */ }
  }
  return undefined
}

async function main() {
  const args = argv.slice(1)
  if (args[0] === '--help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
  if (args[0] === '--') args.shift()
  if (args.length === 0) { err('nohup: missing operand\nTry \'nohup --help\' for more information.'); return 125 }

  const fds = { 0: 0, 1: 1, 2: 2 }
  const inputTty = isTty(0)
  const outputTty = isTty(1)
  const errorTty = isTty(2)
  if (inputTty) fds[0] = openDevNull()
  let note = ''
  if (outputTty) {
    const log = openLog()
    if (!log) { err('nohup: cannot open nohup.out'); return 125 }
    fds[1] = log.fd
    if (errorTty) fds[2] = log.fd
    note = `appending output to '${log.path}'`
  } else if (errorTty) {
    note = 'redirecting stderr to stdout'
    fds[2] = 1
  }
  if (inputTty || note) err(`nohup: ${[inputTty ? 'ignoring input' : '', note].filter(Boolean).join(' and ')}`)

  const program = findProgram(args[0])
  if (!program) { err(`nohup: failed to run command '${args[0]}': No such file or directory`); return 127 }
  try { return (await run(program, args, { fds })).status } catch (error) {
    err(`nohup: failed to run command '${args[0]}': ${error?.message ?? error}`)
    return 126
  }
}

try {
  exit(await main())
} catch (error) {
  err(`nohup: ${error?.message ?? String(error)}`)
  exit(125)
}
