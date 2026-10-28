/**
 * `nice`: run a command with an adjusted niceness, or print the current one. Niceness is kept and inherited as on Linux
 * and shows in `/proc/<pid>/stat` and `ps`, but nothing here schedules by it: each process is a worker and the browser runs
 * them as it likes.
 */

import { findProgram, run } from './lib/run.mjs'

const { argv, exit, writeAll, custom } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`nice: ${text}\n`))

const usage = `Usage: nice [OPTION] [COMMAND [ARG]...]
Run COMMAND with an adjusted niceness, which affects process scheduling.
With no COMMAND, print the current niceness. Niceness values range from
-20 (most favorable to the process) to 19 (least favorable to the process).

  -n, --adjustment=N   add integer N to the niceness (default 10)
      --help           display this help and exit
      --version        output version information and exit

Here niceness is recorded and inherited but does not change how fast anything runs.`

async function main() {
  const args = argv.slice(1)
  let adjustment = 10
  let adjusted = false
  while (args.length) {
    const arg = args[0]
    if (arg === '--') { args.shift(); break }
    if (arg === '--help') { out(usage + '\n'); return 0 }
    if (arg === '--version') { out('nice (ecmaOS coreutils) 1.0\n'); return 0 }
    let value
    if (arg === '-n' || arg === '--adjustment') { args.shift(); value = args.shift(); if (value === undefined) { err(`option requires an argument -- 'n'`); return 125 } }
    else if (arg.startsWith('--adjustment=')) { args.shift(); value = arg.slice(13) }
    else if (arg.startsWith('-n') && arg.length > 2) { args.shift(); value = arg.slice(2) }
    else if (/^--?\d+$/.test(arg) && arg.startsWith('-')) { args.shift(); value = arg.startsWith('--') ? `-${arg.slice(2)}` : arg.slice(1) } // legacy -5 and --5
    else if (arg.startsWith('-') && arg.length > 1) { err(`unrecognized option '${arg}'`); return 125 }
    else break
    if (!/^[+-]?\d+$/.test(value)) { err(`invalid adjustment ‘${value}’`); return 125 }
    adjustment = Number(value)
    adjusted = true
  }

  const current = (await custom('proc_nice', 0, 0, 0)) - 20
  if (!args.length) {
    if (adjusted) { err('a command must be given with an adjustment'); return 125 }
    out(`${current}\n`)
    return 0
  }
  try { await custom('proc_nice', 1, 0, current + adjustment) } catch (e) {
    // as GNU nice does: say so, and run the command anyway
    err(`cannot set niceness: ${e?.message ?? e}`)
  }
  const program = findProgram(args[0])
  if (!program) { err(`'${args[0]}': No such file or directory`); return 127 }
  try { return (await run(program, args)).status } catch (e) {
    err(`'${args[0]}': ${e?.message ?? e}`)
    return 126
  }
}

try {
  exit(await main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(125)
}
