/**
 * Send a signal to processes, as bash's `kill` does: `kill [-s SIGSPEC | -n SIGNUM | -SIGSPEC] PID...` (a negative
 * PID names a process group), and `kill -l [SIGSPEC | EXIT-STATUS]...` to list or translate signals. A signal is a name
 * with or without `SIG`, or a number; the default is TERM.
 */

import { allSignalNames, signalNumberOf, SignalNumbers } from './lib/signals.mjs'

const { argv, exit, write, custom } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const out = text => write(1, encoder.encode(text))
const err = text => write(2, encoder.encode(`kill: ${text}\n`))

const usage = `kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]
`

const nameOfNumber = number => {
  if (number === 0) return 'EXIT'
  const found = allSignalNames().find(([n]) => n === number)
  return found ? found[1] : undefined
}

function list(operands) {
  if (operands.length === 0) {
    const rows = []
    const all = allSignalNames()
    for (let i = 0; i < all.length; i += 5) {
      rows.push(all.slice(i, i + 5).map(([n, name]) => `${String(n).padStart(2)}) SIG${name}`).join('\t'))
    }
    out(rows.join('\n') + '\n')
    return 0
  }
  let status = 0
  for (const operand of operands) {
    if (/^\d+$/.test(operand)) {
      let number = Number(operand)
      if (number > 128) number -= 128
      const name = nameOfNumber(number)
      if (name === undefined || Number(operand) > 192) { err(`${operand}: invalid signal specification`); status = 1; continue }
      out(name + '\n')
    } else {
      const number = signalNumberOf(operand)
      if (number === undefined) { err(`${operand}: invalid signal specification`); status = 1; continue }
      out(number + '\n')
    }
  }
  return status
}

async function main() {
  const args = argv.slice(1)
  if (args.includes('--help')) { out(usage); return 0 }
  let signal = SignalNumbers.TERM
  let i = 0
  const badSignal = spec => { err(`${spec}: invalid signal specification`); return 1 }

  // Options come first and only once: after the signal, a negative number is a process group
  let optionSeen = false
  for (; i < args.length && !optionSeen; i++) {
    const arg = args[i]
    if (arg === '--') { i++; break }
    if (arg === '-l' || arg === '-L' || arg === '--list') return list(args.slice(i + 1))
    if (arg === '-s' || arg === '-n' || /^-[sn]./.test(arg) && signalNumberOf(arg.slice(1)) === undefined) {
      const spec = arg.length > 2 ? arg.slice(2) : args[++i]
      if (spec === undefined) { err(`${arg}: option requires an argument`); out(usage); return 2 }
      const number = /^\d+$/.test(spec) ? Number(spec) : arg[1] === 'n' ? undefined : signalNumberOf(spec)
      if (number === undefined || (number !== 0 && nameOfNumber(number) === undefined)) return badSignal(spec)
      signal = number
      optionSeen = true
      continue
    }
    if (arg.startsWith('-') && arg.length > 1) {
      const spec = arg.slice(1)
      const number = /^\d+$/.test(spec) ? Number(spec) : signalNumberOf(spec)
      if (number === undefined || (number !== 0 && nameOfNumber(number) === undefined)) return badSignal(spec)
      signal = number
      optionSeen = true
      continue
    }
    break
  }

  const targets = args.slice(i)
  if (targets.length === 0) { out(usage); return 2 }

  let failed = false
  for (const target of targets) {
    if (!/^-?\d+$/.test(target)) { err(target.startsWith('%') ? `${target}: no such job` : `${target}: arguments must be process or job IDs`); failed = true; continue }
    const pid = Number(target)
    try {
      if (pid < 0) await custom('proc_killpg', -pid, signal)
      else await custom('proc_kill', pid, signal)
    } catch (error) {
      failed = true
      const text = error instanceof Error ? error.message : String(error)
      const reason = /ESRCH/.test(text) ? 'No such process' : /EPERM|permission/i.test(text) ? 'Operation not permitted' : text
      err(`(${pid}) - ${reason}`)
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
