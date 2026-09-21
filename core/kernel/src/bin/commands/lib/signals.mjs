/**
 * A small, local copy of `@zenfs/linux`'s `Signal` enum (`signal.js`) -- standard Linux signal
 * numbers, stable since forever, not worth importing the whole package (a large barrel export
 * pulling in every driver) into a worker bundle just for one enum, the same reasoning
 * `path-utils.mjs`'s own doc comment gives for not importing real `path`.
 */
export const SignalNumbers = {
  HUP: 1, INT: 2, QUIT: 3, ILL: 4, TRAP: 5, ABRT: 6, BUS: 7, FPE: 8, KILL: 9,
  USR1: 10, SEGV: 11, USR2: 12, PIPE: 13, ALRM: 14, TERM: 15, STKFLT: 16,
  CHLD: 17, CONT: 18, STOP: 19, TSTP: 20, TTIN: 21, TTOU: 22, URG: 23,
  XCPU: 24, XFSZ: 25, VTALRM: 26, PROF: 27, WINCH: 28, IO: 29, PWR: 30, SYS: 31
}

const SignalNames = Object.fromEntries(Object.entries(SignalNumbers).map(([name, num]) => [num, name]))

export function signalName(num) {
  return SignalNames[num] ?? String(num)
}

/**
 * Parses a `kill`/`killall`-style signal argument: `-9`, `-KILL`, `-SIGKILL`, or a bare number/name
 * (no leading dash) -- returns `null` if `arg` isn't a signal spec at all (the caller should treat it
 * as a positional pid/name instead), or `undefined` if it looked like one but didn't resolve to a
 * real signal.
 */
export function parseSignalArg(arg) {
  if (!arg.startsWith('-') || arg === '-') return null
  const spec = arg.slice(1)
  if (/^\d+$/.test(spec)) return SignalNames[Number(spec)] !== undefined ? Number(spec) : undefined
  const name = spec.toUpperCase().replace(/^SIG/, '')
  return SignalNumbers[name]
}
