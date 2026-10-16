/** A local copy of `@zenfs/linux`'s `Signal` numbers, to keep the package out of the worker bundle. */
export const SignalNumbers = {
  HUP: 1, INT: 2, QUIT: 3, ILL: 4, TRAP: 5, ABRT: 6, BUS: 7, FPE: 8, KILL: 9,
  USR1: 10, SEGV: 11, USR2: 12, PIPE: 13, ALRM: 14, TERM: 15, STKFLT: 16,
  CHLD: 17, CONT: 18, STOP: 19, TSTP: 20, TTIN: 21, TTOU: 22, URG: 23,
  XCPU: 24, XFSZ: 25, VTALRM: 26, PROF: 27, WINCH: 28, IO: 29, PWR: 30, SYS: 31
}

const SignalNames = Object.fromEntries(Object.entries(SignalNumbers).map(([name, num]) => [num, name]))

/** The real-time signals, 34 to 64, named as bash lists them: `RTMIN`, `RTMIN+1` ... `RTMAX-1`, `RTMAX` */
export const RealtimeNames = {}
for (let n = 34; n <= 64; n++) {
  RealtimeNames[n] = n === 34 ? 'RTMIN' : n === 64 ? 'RTMAX' : n <= 49 ? `RTMIN+${n - 34}` : `RTMAX-${64 - n}`
}

/** Every name `kill -l` shows, by number */
export function allSignalNames() {
  const names = { ...SignalNames, ...RealtimeNames }
  return Object.entries(names).map(([num, name]) => [Number(num), name]).sort((a, b) => a[0] - b[0])
}

/** The number for a name such as `TERM`, `SIGTERM` or `RTMIN+3`, or `undefined` */
export function signalNumberOf(name) {
  const bare = String(name).toUpperCase().replace(/^SIG/, '')
  if (bare === 'EXIT') return 0
  if (bare in SignalNumbers) return SignalNumbers[bare]
  const found = Object.entries(RealtimeNames).find(([, label]) => label === bare)
  return found ? Number(found[0]) : undefined
}

export function signalName(num) {
  return SignalNames[num] ?? String(num)
}

/**
 * Parses a `kill`-style signal argument (`-9`, `-KILL`, `-SIGKILL`, or a bare number or name). Returns `null` if
 * `arg` is not a signal spec, `undefined` if it looked like one but names no signal.
 */
export function parseSignalArg(arg) {
  if (!arg.startsWith('-') || arg === '-') return null
  const spec = arg.slice(1)
  // signal 0 is not a signal: it asks whether the process exists and may be signalled
  if (/^\d+$/.test(spec)) return Number(spec) === 0 || SignalNames[Number(spec)] !== undefined || RealtimeNames[Number(spec)] !== undefined ? Number(spec) : undefined
  return signalNumberOf(spec)
}
