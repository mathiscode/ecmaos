/**
 * `taskset`: run a command on chosen CPUs, or show which CPUs a process may use. Every process here is a worker the browser
 * places as it likes, so a program may use all of the CPUs and a mask is checked and not applied; `-p` shows that full set.
 */

import { findProgram, run } from './lib/run.mjs'

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`taskset: ${text}\n`))
const cpus = globalThis.navigator?.hardwareConcurrency || 1

const usage = `Usage: taskset [options] [mask | cpu-list] [pid|cmd [args...]]
Show or change the CPU affinity of a process.

Options:
 -c, --cpu-list            show and specify CPUs in list format
 -p, --pid                 operate on existing given pid
 -h, --help                display this help
 -V, --version             display version

A process here may use every CPU; a mask or list is checked and not applied.`

/** The CPUs a mask (hex) or a list (`0,2-3`) names, or undefined when it is neither */
function parse(text, list) {
  const chosen = new Set()
  if (list) {
    for (const part of text.split(',')) {
      const match = /^(\d+)(?:-(\d+)(?::(\d+))?)?$/.exec(part)
      if (!match) return undefined
      const [from, to, step] = [Number(match[1]), Number(match[2] ?? match[1]), Number(match[3] ?? 1)]
      if (to < from || step < 1) return undefined
      for (let cpu = from; cpu <= to; cpu += step) chosen.add(cpu)
    }
  } else {
    if (!/^(0x)?[0-9a-f]+$/i.test(text)) return undefined
    const bits = BigInt(text.startsWith('0x') ? text : `0x${text}`)
    for (let cpu = 0; cpu < 1024; cpu++) if ((bits >> BigInt(cpu)) & 1n) chosen.add(cpu)
  }
  return chosen
}

const mask = count => ((1n << BigInt(count)) - 1n).toString(16)
const range = count => count === 1 ? '0' : `0-${count - 1}`

async function main() {
  const args = argv.slice(1)
  let list = false
  let byPid = false
  while (args.length && args[0].startsWith('-') && args[0] !== '-') {
    const arg = args.shift()
    if (arg === '--') break
    if (arg === '-h' || arg === '--help') { out(usage + '\n'); return 0 }
    if (arg === '-V' || arg === '--version') { out('taskset (ecmaOS coreutils) 1.0\n'); return 0 }
    for (const letter of arg === '--cpu-list' ? ['c'] : arg === '--pid' ? ['p'] : arg.slice(1)) {
      if (letter === 'c') list = true
      else if (letter === 'p') byPid = true
      else { err(`invalid option -- '${letter}'\nTry 'taskset --help' for more information.`); return 1 }
    }
  }
  if (byPid) {
    const pid = args.pop()
    if (!pid || !/^\d+$/.test(pid)) { err('failed to parse pid'); return 1 }
    const given = args.shift()
    const set = (given && parse(given, list)) || undefined
    if (given && !set) { err(`failed to parse CPU ${list ? 'list' : 'mask'}: ${given}`); return 1 }
    out(`pid ${pid}'s current affinity ${list ? 'list' : 'mask'}: ${list ? range(cpus) : mask(cpus)}\n`)
    if (set) {
      if (![...set].some(cpu => cpu < cpus)) { err(`failed to set pid ${pid}'s affinity: Invalid argument`); return 1 }
      out(`pid ${pid}'s new affinity ${list ? 'list' : 'mask'}: ${list ? range(cpus) : mask(cpus)}\n`)
    }
    return 0
  }
  const given = args.shift()
  if (given === undefined) { out(usage + '\n'); return 1 }
  const set = parse(given, list)
  if (!set) { err(`failed to parse CPU ${list ? 'list' : 'mask'}: ${given}`); return 1 }
  if (![...set].some(cpu => cpu < cpus)) { err('failed to set pid 0\'s affinity: Invalid argument'); return 1 }
  if (!args.length) { err('no command given\nTry \'taskset --help\' for more information.'); return 1 }
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
