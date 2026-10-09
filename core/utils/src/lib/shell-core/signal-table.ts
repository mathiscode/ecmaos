/**
 * The Linux signal names and numbers a shell's `trap` and `kill` know, one table for both shells. KILL and STOP are in it
 * because bash accepts naming them, but they can be neither caught nor ignored, so nothing is registered for them.
 */
export const SIGNAL_NUMBERS: Readonly<Record<string, number>> = {
  HUP: 1, INT: 2, QUIT: 3, ILL: 4, TRAP: 5, ABRT: 6, BUS: 7, FPE: 8, KILL: 9,
  USR1: 10, SEGV: 11, USR2: 12, PIPE: 13, ALRM: 14, TERM: 15, STKFLT: 16,
  CHLD: 17, CONT: 18, STOP: 19, TSTP: 20, TTIN: 21, TTOU: 22, URG: 23,
  XCPU: 24, XFSZ: 25, VTALRM: 26, PROF: 27, WINCH: 28, IO: 29, PWR: 30, SYS: 31
}

/** Signals no program can catch or ignore */
export const UNCATCHABLE_SIGNALS: ReadonlySet<string> = new Set(['KILL', 'STOP'])

const NAMES_BY_NUMBER: Readonly<Record<number, string>> = Object.fromEntries(Object.entries(SIGNAL_NUMBERS).map(([name, number]) => [number, name]))

/** The name for a signal number (`28` is `WINCH`), or `undefined` */
export function signalNameOf(number: number): string | undefined { return NAMES_BY_NUMBER[number] }

/** Every name, in number order */
export function signalNameList(): string[] { return Object.keys(SIGNAL_NUMBERS) }

/** The name behind `INT`, `SIGINT`, `int` or `2`, or `undefined` when it is none of them */
export function normalizeSignal(spec: string): string | undefined {
  if (/^\d+$/.test(spec)) return signalNameOf(Number(spec))
  const name = spec.replace(/^SIG/i, '').toUpperCase()
  return name in SIGNAL_NUMBERS ? name : undefined
}
