/** Send a signal to every process matching NAME. */

import { SignalNumbers, parseSignalArg } from './lib/signals.mjs'
import { readBackAndDelete, scratchPath } from './lib/scratch.mjs'

const syscalls = globalThis.ecmaosSyscalls
const { argv, exit, write, custom } = syscalls

const usage = `Usage: killall [-s SIGNAL | -SIGNAL] NAME...
Send a signal to every process matching NAME (SIGTERM by default).

  -s, --signal SIGNAL  signal to send, by name (TERM) or number (15)
  -SIGNAL               shorthand, e.g. -9 or -KILL
  --help                display this help and exit`

function writeStderr(text) { write(2, new TextEncoder().encode(text + '\n')) }

async function listProcesses() {
  const path = scratchPath('killall')
  await custom('ps_list', path)
  const raw = await readBackAndDelete(syscalls, path)
  return JSON.parse(raw)
}

async function main() {
  const args = argv.slice(1)

  if (args.includes('--help') || args.includes('-h')) {
    writeStderr(usage)
    return 0
  }

  let signal = SignalNumbers.TERM
  const names = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-s' || arg === '--signal') {
      const spec = args[++i]
      const resolved = spec && (/^\d+$/.test(spec) ? Number(spec) : SignalNumbers[spec.toUpperCase().replace(/^SIG/, '')])
      if (resolved === undefined) {
        writeStderr(`killall: unknown signal: ${spec}`)
        return 1
      }
      signal = resolved
      continue
    }

    const asSignal = parseSignalArg(arg)
    if (asSignal !== null) {
      if (asSignal === undefined) {
        writeStderr(`killall: unknown signal: ${arg}`)
        return 1
      }
      signal = asSignal
      continue
    }

    names.push(arg)
  }

  if (names.length === 0) {
    writeStderr('killall: missing process name')
    writeStderr(usage)
    return 1
  }

  const processes = await listProcesses()
  let hasError = false

  for (const name of names) {
    const matches = processes.filter(p => p.command === name)
    if (matches.length === 0) {
      hasError = true
      writeStderr(`killall: ${name}: no process found`)
      continue
    }

    for (const match of matches) {
      try {
        await custom('proc_kill', match.pid, signal)
      } catch (error) {
        hasError = true
        writeStderr(`killall: (${match.pid}) - ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  return hasError ? 1 : 0
}

try {
  exit(await main())
} catch (error) {
  write(2, new TextEncoder().encode(`killall: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
