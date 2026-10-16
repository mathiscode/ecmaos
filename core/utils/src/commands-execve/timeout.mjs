/**
 * Runs a command and stops it if still running after a time: `timeout 5 curl ...`. DURATION takes `s` (default), `m`,
 * `h` or `d` and may be fractional; 0 is no limit. On expiry the command gets SIGTERM (or `-s`), and with `-k`
 * SIGKILL after a further delay. Status: 124 on timeout (the command's own with `--preserve-status`), 125 if
 * `timeout` failed, 126 if the command cannot run, 127 if not found, else the command's.
 */

import { findProgram, statusOf, waitFor } from './lib/run.mjs'
import { tryHelp } from './lib/getopt.mjs'
import { reasonOf } from './lib/errno.mjs'

const sys = globalThis.ecmaosSyscalls
const { argv, exit, writeAll, spawn, getcwd, env, custom } = sys

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`timeout: ${text}\n`))

const SIGNALS = { HUP: 1, INT: 2, QUIT: 3, KILL: 9, USR1: 10, USR2: 12, ALRM: 14, TERM: 15, CONT: 18, STOP: 19 }

const usage = `Usage: timeout [OPTION]... DURATION COMMAND [ARG]...
Start COMMAND, and kill it if still running after DURATION.

  -s, --signal=SIGNAL     the signal to send on timeout, by name or number (default TERM)
  -k, --kill-after=TIME   also send KILL if the command is still running TIME after the first signal
  -v, --verbose           diagnose to stderr any signal sent upon timeout
  -f, --foreground        accepted, for compatibility
  --preserve-status       exit with the command's status even when it timed out
  --help                  display this help and exit

DURATION and TIME are numbers with an optional suffix: s (seconds, the default), m, h or d.`

const signalLabel = number => Object.entries(SIGNALS).find(([, value]) => value === number)?.[0] ?? String(number)

function duration(text) {
  const match = /^(\d+(?:\.\d+)?|\.\d+)([smhd]?)$/.exec(text ?? '')
  if (!match) return undefined
  return Number(match[1]) * { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[match[2]] * 1000
}

function signalNumber(text) {
  if (/^\d+$/.test(text)) return Number(text)
  return SIGNALS[text.toUpperCase().replace(/^SIG/, '')]
}

async function main() {
  const args = argv.slice(1)
  let signal = SIGNALS.TERM
  let killAfter
  let preserve = false
  let verbose = false
  let i = 0
  for (; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (arg === '--') { i++; break }
    if (!arg.startsWith('-') || arg === '-') break
    let m
    if (arg === '--preserve-status') preserve = true
    else if (arg === '--foreground' || arg === '-f') continue
    else if (arg === '--verbose' || arg === '-v') verbose = true
    else if ((m = /^--signal(?:=(.*))?$/.exec(arg)) || arg === '-s' || arg.startsWith('-s')) {
      const text = m ? (m[1] ?? args[++i]) : (arg.length > 2 ? arg.slice(2) : args[++i])
      signal = signalNumber(text ?? '')
      if (signal === undefined) { err(`${text}: invalid signal`); return 125 }
    } else if ((m = /^--kill-after(?:=(.*))?$/.exec(arg)) || arg === '-k' || arg.startsWith('-k')) {
      const text = m ? (m[1] ?? args[++i]) : (arg.length > 2 ? arg.slice(2) : args[++i])
      killAfter = duration(text)
      if (killAfter === undefined) { err(`invalid time interval ‘${text}’`); return 125 }
    } else { err(`invalid option -- '${arg.replace(/^-+/, '')}'`); return 125 }
  }
  const limit = duration(args[i])
  const hint = () => writeAll(2, encoder.encode(tryHelp('timeout') + '\n'))
  if (args[i] === undefined) { hint(); return 125 }
  if (limit === undefined) { err(`invalid time interval ‘${args[i]}’`); return 125 }
  const command = args.slice(i + 1)
  if (command.length === 0) { hint(); return 125 }

  const program = findProgram(command[0])
  if (!program) { err(`failed to run command ‘${command[0]}’: No such file or directory`); return 127 }
  let pid
  try { pid = await spawn(program, command, { cwd: getcwd(), env }) } catch (error) { err(`failed to run command ‘${command[0]}’: ${reasonOf(error)}`); return 126 }

  let timedOut = false
  let timers = []
  const exited = waitFor(pid).then(done => { for (const timer of timers) clearTimeout(timer); return done })
  if (limit > 0) {
    timers.push(setTimeout(async () => {
      timedOut = true
      if (verbose) err(`sending signal ${signalLabel(signal)} to command ‘${command[0].split('/').pop()}’`)
      try { await custom('proc_kill', pid, signal) } catch { /* it just ended */ }
      if (killAfter !== undefined && killAfter > 0) {
        timers.push(setTimeout(async () => { try { await custom('proc_kill', pid, SIGNALS.KILL) } catch { /* gone */ } }, killAfter))
      }
    }, limit))
  }
  const done = await exited
  // KILL cannot be caught, and without --foreground it is sent to the whole group, `timeout` included
  if (timedOut && !preserve) return signal === SIGNALS.KILL ? 137 : 124
  return statusOf(done)
}

try {
  exit(await main())
} catch (error) {
  err(error?.message ?? String(error))
  exit(125)
}
