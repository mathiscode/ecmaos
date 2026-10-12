/**
 * `/etc/shadow`: one module owns the file's format, as `shadow(5)` describes it.
 *
 *   name:hash:lastchg:min:max:warn:inactive:expire:reserved
 *
 * `hash` is `$id$params$salt$hash`; a `!` in front of it locks the account, `*` means no password can log in, and
 * an empty field means no password at all. `lastchg` and `expire` are days since 1970-01-01. Every other field is
 * optional and empty when unset. Fields past the ninth, and `#` comments, are kept when a file is rewritten.
 */

export interface ShadowEntry {
  name: string
  hash: string
  /** Day of the last password change, or `undefined` for none (an empty field) */
  lastChange?: number
  /** Fewest days between changes */
  min?: number
  /** Most days a password is valid */
  max?: number
  /** Days of warning before it expires */
  warn?: number
  /** Days after expiry until the account is disabled */
  inactive?: number
  /** Day the account expires */
  expire?: number
  /** The reserved field, and anything after it, as written */
  rest: string[]
}

/** A line of the file: an entry, or text kept as it is (a comment) */
export type ShadowLine = { entry: ShadowEntry } | { text: string }

export interface ShadowFile { lines: ShadowLine[] }

/** What `useradd` writes: no minimum age, a password that never expires, a week of warning */
export const DEFAULT_AGING = { min: 0, max: 99999, warn: 7 } as const

const number = (field: string | undefined): number | undefined => {
  if (field === undefined || !/^-?\d+$/.test(field.trim())) return undefined
  return Number(field)
}
const show = (value: number | undefined): string => value === undefined ? '' : String(value)

/** Days since 1970-01-01 (UTC) */
export function daysSinceEpoch(now: number = Date.now()): number {
  return Math.floor(now / 86_400_000)
}

export function parseShadowLine(line: string): ShadowEntry | undefined {
  const fields = line.split(':')
  if (fields.length < 2 || !fields[0]) return undefined
  return {
    name: fields[0],
    hash: fields[1] ?? '',
    lastChange: number(fields[2]),
    min: number(fields[3]),
    max: number(fields[4]),
    warn: number(fields[5]),
    inactive: number(fields[6]),
    expire: number(fields[7]),
    rest: fields.slice(8)
  }
}

export function serializeShadowEntry(entry: ShadowEntry): string {
  return [
    entry.name, entry.hash, show(entry.lastChange), show(entry.min), show(entry.max), show(entry.warn),
    show(entry.inactive), show(entry.expire), ...(entry.rest.length ? entry.rest : [''])
  ].join(':')
}

/** Reads a file. Blank lines are dropped; a comment or a line that is not an entry is kept as text. */
export function parseShadow(text: string): ShadowFile {
  const lines: ShadowLine[] = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.trim() === '') continue
    const entry = line.startsWith('#') ? undefined : parseShadowLine(line)
    lines.push(entry ? { entry } : { text: line })
  }
  return { lines }
}

/** Writes a file: one line each, and a newline at the end (an empty file stays empty) */
export function serializeShadow(file: ShadowFile): string {
  if (file.lines.length === 0) return ''
  return file.lines.map(line => 'entry' in line ? serializeShadowEntry(line.entry) : line.text).join('\n') + '\n'
}

export function entries(file: ShadowFile): ShadowEntry[] {
  return file.lines.flatMap(line => 'entry' in line ? [line.entry] : [])
}

/** The entry for exactly this name (never a prefix match) */
export function findEntry(file: ShadowFile, name: string): ShadowEntry | undefined {
  return entries(file).find(entry => entry.name === name)
}

/** Replaces the entry of the same name, or adds it at the end */
export function setEntry(file: ShadowFile, entry: ShadowEntry): void {
  const index = file.lines.findIndex(line => 'entry' in line && line.entry.name === entry.name)
  if (index === -1) file.lines.push({ entry })
  else file.lines[index] = { entry }
}

/** Takes out the entry for this name; whether there was one */
export function removeEntry(file: ShadowFile, name: string): boolean {
  const before = file.lines.length
  file.lines = file.lines.filter(line => !('entry' in line && line.entry.name === name))
  return file.lines.length !== before
}

/** Gives an entry another name, in the same place and keeping every other field; whether it was there */
export function renameEntry(file: ShadowFile, from: string, to: string): boolean {
  const entry = findEntry(file, from)
  if (!entry) return false
  entry.name = to
  return true
}

// - states of the hash field -------------------------------------------------------------------------

/** A `!` in front: `passwd -l` */
export const isLocked = (hash: string): boolean => hash.startsWith('!')

/** `*` (or `!*`): the account has no password anyone can type */
export const isPasswordDisabled = (hash: string): boolean => hash.replace(/^!/, '') === '*'

/** An empty hash (or just `!`): no password at all */
export const hasNoPassword = (hash: string): boolean => hash.replace(/^!/, '') === ''

export const lockHash = (hash: string): string => isLocked(hash) ? hash : `!${hash}`
export const unlockHash = (hash: string): string => hash.replace(/^!/, '')

/**
 * Whether the account may log in on `today` (days since the epoch), and if not, why. This is the aging
 * `chage` sets: an account past its `expire` day, or whose password is past `max` plus `inactive` days, is closed.
 */
export function loginBlock(entry: Pick<ShadowEntry, 'lastChange' | 'max' | 'inactive' | 'expire'>, today: number): 'account expired' | 'password expired' | undefined {
  if (entry.expire !== undefined && entry.expire >= 0 && today >= entry.expire) return 'account expired'
  if (entry.lastChange !== undefined && entry.lastChange > 0 && entry.max !== undefined && entry.max >= 0 && entry.max < 99999 && entry.inactive !== undefined && entry.inactive >= 0) {
    if (today > entry.lastChange + entry.max + entry.inactive) return 'password expired'
  }
  return undefined
}
