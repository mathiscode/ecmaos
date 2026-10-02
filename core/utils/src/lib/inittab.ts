/**
 * `/etc/inittab`, in BusyBox's format: one entry per line, `id:runlevels:action:command`.
 *
 * - `id` is a label (BusyBox uses it for the tty to open); it may be empty, and need not be unique.
 * - `runlevels` is accepted and ignored: ecmaOS has a single mode of operation.
 * - `action` is one of {@link INIT_ACTIONS}.
 * - `command` is everything after the third colon, so it may itself contain colons. It is split into
 *   words with `splitCommand`: quotes group, and there is no shell syntax. Anything that needs pipes or
 *   redirections belongs in a script that the entry runs.
 *
 * A line that cannot be used is reported in `errors` and skipped; it never stops the rest of the
 * file from being read.
 *
 * No Node built-ins, so the same file runs in the `/sbin/init` worker and in the kernel's tests.
 */

export const INIT_ACTIONS = ['sysinit', 'wait', 'once', 'respawn', 'shutdown'] as const
export type InitAction = typeof INIT_ACTIONS[number]

export interface InitEntry {
  id: string
  runlevels: string
  action: InitAction
  command: string
  argv: string[]
  /** The 1-based line it came from, for diagnostics. */
  line: number
}

export interface InittabError {
  line: number
  text: string
  reason: string
}

export interface Inittab {
  entries: InitEntry[]
  errors: InittabError[]
}

/** What a filesystem without an `/etc/inittab` gets. */
/** A login prompt on each of the eight terminals, added to the default file when the kernel does not log a user in itself. */
export const DEFAULT_GETTY_ENTRIES = Array.from({ length: 8 }, (_, n) => `tty${n}::respawn:/sbin/getty tty${n}\n`).join('')

/** The one-terminal version of {@link DEFAULT_GETTY_ENTRIES} an earlier build wrote; still an untouched default. */
export const FIRST_TERMINAL_GETTY_ENTRY = 'tty0::respawn:/sbin/getty tty0\n'

/** The terminals an inittab runs a `getty` on: entries whose id is `ttyN`, that respawn `/sbin/getty`. */
export function gettyTerminals(text: string): Set<number> {
  const terminals = new Set<number>()
  for (const entry of parseInittab(text).entries) {
    const match = /^tty(\d+)$/.exec(entry.id)
    if (match && entry.action === 'respawn' && entry.argv[0]?.endsWith('/getty')) terminals.add(Number(match[1]))
  }
  return terminals
}

export const DEFAULT_INITTAB = [
  '# /etc/inittab: what init runs, one entry per line as id:runlevels:action:command.',
  '#',
  '#   sysinit   run once, in order, and wait for it, before anything else',
  '#   wait      run once after the sysinit entries, and wait for it',
  '#   once      start once and do not wait',
  '#   respawn   start, and start again whenever it exits',
  '#   shutdown  run, in order, when the system goes down (reboot, halt and poweroff signal init)',
  '#',
  '# The id and runlevels fields may be empty. `kill -HUP 1` makes init read this file again.',
  '::sysinit:/boot/init',
  '::respawn:/bin/crond',
  ''
].join('\n')

/** Actions BusyBox has that ecmaOS does not, with the reason, so a copied inittab says why a line was skipped. */
const UNSUPPORTED: Record<string, string> = {
  ctrlaltdel: 'there is no key chord to bind it to in a browser; use the reboot command',
  askfirst: 'init does not start login sessions',
  respawnask: 'init does not start login sessions',
  restart: 'init cannot re-execute itself; reboot instead'
}

/**
 * Splits a command into words. Single and double quotes group (and are removed); a backslash outside
 * quotes escapes the next character; inside double quotes it escapes only `"` and `\`.
 * @throws when a quote is left open or a backslash ends the string
 */
export function splitCommand(command: string): string[] {
  const words: string[] = []
  let word = ''
  let inWord = false
  let quote: '"' | "'" | undefined
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!
    if (quote === "'") {
      if (char === "'") quote = undefined
      else word += char
    } else if (quote === '"') {
      if (char === '"') quote = undefined
      else if (char === '\\' && (command[i + 1] === '"' || command[i + 1] === '\\')) word += command[++i]
      else word += char
    } else if (char === "'" || char === '"') {
      quote = char
      inWord = true
    } else if (char === '\\') {
      if (i + 1 >= command.length) throw new Error('a backslash ends the command')
      word += command[++i]
      inWord = true
    } else if (/\s/.test(char)) {
      if (inWord) { words.push(word); word = ''; inWord = false }
    } else {
      word += char
      inWord = true
    }
  }
  if (quote) throw new Error(`unterminated ${quote} quote`)
  if (inWord) words.push(word)
  return words
}

export function parseInittab(text: string): Inittab {
  const entries: InitEntry[] = []
  const errors: InittabError[] = []
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index]!
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const number = index + 1
    const fail = (reason: string) => errors.push({ line: number, text: raw, reason })

    const first = line.indexOf(':')
    const second = first < 0 ? -1 : line.indexOf(':', first + 1)
    const third = second < 0 ? -1 : line.indexOf(':', second + 1)
    if (third < 0) { fail('expected id:runlevels:action:command'); continue }

    const id = line.slice(0, first).trim()
    const runlevels = line.slice(first + 1, second).trim()
    const action = line.slice(second + 1, third).trim()
    const command = line.slice(third + 1).trim()

    if (UNSUPPORTED[action]) { fail(`the ${action} action is not supported: ${UNSUPPORTED[action]}`); continue }
    if (!(INIT_ACTIONS as readonly string[]).includes(action)) { fail(`unknown action "${action}"`); continue }
    if (!command) { fail('missing command'); continue }

    let argv: string[]
    try { argv = splitCommand(command) } catch (error) { fail(error instanceof Error ? error.message : String(error)); continue }
    if (!argv.length) { fail('missing command'); continue }

    entries.push({ id, runlevels, action: action as InitAction, command, argv, line: number })
  }
  return { entries, errors }
}

/** What identifies an entry across a re-read of the file: the same line of text is the same service. */
export function entryKey(entry: Pick<InitEntry, 'id' | 'action' | 'command'>): string {
  return `${entry.action}:${entry.id}:${entry.command}`
}

export interface BackoffOptions {
  /** The delay before the first restart of a service that keeps dying. */
  initialMs: number
  /** The longest delay between restarts. */
  maxMs: number
  /** A run at least this long counts as healthy and clears the history. */
  resetAfterMs: number
}

export const DEFAULT_BACKOFF: BackoffOptions = { initialMs: 1000, maxMs: 60_000, resetAfterMs: 30_000 }

/**
 * How long to wait before restarting a respawn entry, so one that dies at once cannot spin.
 *
 * A run that lasted `resetAfterMs` or more restarts immediately and starts the history over. A shorter
 * one waits `initialMs`, then twice that for the next short run, and so on up to `maxMs`.
 * Pure over the times it is given, so it is tested with no clock.
 */
export class RespawnTracker {
  private readonly started = new Map<string, number>()
  private readonly failures = new Map<string, number>()

  constructor(private readonly options: BackoffOptions = DEFAULT_BACKOFF) {}

  start(key: string, at: number): void {
    this.started.set(key, at)
  }

  /** Records that the service stopped at `at` and returns how long to wait before starting it again. */
  exit(key: string, at: number): number {
    const began = this.started.get(key) ?? at
    this.started.delete(key)
    if (at - began >= this.options.resetAfterMs) {
      this.failures.delete(key)
      return 0
    }
    const failures = this.failures.get(key) ?? 0
    this.failures.set(key, failures + 1)
    return Math.min(this.options.maxMs, this.options.initialMs * 2 ** failures)
  }

  forget(key: string): void {
    this.started.delete(key)
    this.failures.delete(key)
  }
}
