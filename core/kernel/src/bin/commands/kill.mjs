/**
 * Real `execve`'d `kill` -- new for this session's M1/M4 pass (no legacy in-process version existed;
 * there was nothing real to signal before real `execve`'d processes existed). Reaches
 * `@zenfs/linux`'s own real `kill(pid, signal)` (`process.js`) through the `proc_kill` custom syscall
 * (`#lib/main-thread-syscalls.ts`), which lets a thrown `ESRCH` (no such process) survive back to
 * this program as a real, correctly-named error -- see that syscall's own doc comment.
 */

import { SignalNumbers, parseSignalArg } from './lib/signals.mjs'

const { argv, exit, write, custom } = globalThis.ecmaosSyscalls

const usage = `Usage: kill [-s SIGNAL | -SIGNAL] PID...
       kill -l
Send a signal to a process (SIGTERM by default).

  -s, --signal SIGNAL  signal to send, by name (TERM) or number (15)
  -SIGNAL               shorthand, e.g. -9 or -KILL
  -l, --list            list known signal names
  --help                display this help and exit`

function writeStderr(text) { write(2, new TextEncoder().encode(text + '\n')) }
function writeStdout(text) { write(1, new TextEncoder().encode(text + '\n')) }

async function main() {
  const args = argv.slice(1)

  if (args.includes('--help') || args.includes('-h')) {
    writeStderr(usage)
    return 0
  }

  if (args[0] === '-l' || args[0] === '--list') {
    writeStdout(Object.keys(SignalNumbers).join(' '))
    return 0
  }

  let signal = SignalNumbers.TERM
  const pids = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-s' || arg === '--signal') {
      const spec = args[++i]
      const resolved = spec && (/^\d+$/.test(spec) ? Number(spec) : SignalNumbers[spec.toUpperCase().replace(/^SIG/, '')])
      if (resolved === undefined) {
        writeStderr(`kill: unknown signal: ${spec}`)
        return 1
      }
      signal = resolved
      continue
    }

    const asSignal = parseSignalArg(arg)
    if (asSignal !== null) {
      if (asSignal === undefined) {
        writeStderr(`kill: unknown signal: ${arg}`)
        return 1
      }
      signal = asSignal
      continue
    }

    if (!/^\d+$/.test(arg)) {
      writeStderr(`kill: invalid pid: ${arg}`)
      return 1
    }
    pids.push(Number(arg))
  }

  if (pids.length === 0) {
    writeStderr('kill: missing pid')
    writeStderr(usage)
    return 1
  }

  let hasError = false
  for (const pid of pids) {
    try {
      await custom('proc_kill', pid, signal)
    } catch (error) {
      hasError = true
      writeStderr(`kill: (${pid}) - ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return hasError ? 1 : 0
}

try {
  exit(await main())
} catch (error) {
  write(2, new TextEncoder().encode(`kill: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
