/**
 * Backup files, as `cp`, `mv` and `ln` make them with `-b`, `--backup[=CONTROL]` and `-S SUFFIX`: `none` makes no
 * backup, `numbered` names them `FILE.~1~`, `FILE.~2~`, `simple` appends the suffix (`~` unless `-S` or
 * `SIMPLE_BACKUP_SUFFIX` says otherwise), and `existing` is numbered when a numbered backup is already there and
 * simple otherwise. `-b` without a type follows `VERSION_CONTROL`, and `existing` when that is unset.
 */

import { dirname, basename, join } from './path-utils.mjs'

const NAMES = [
  ['none', 'none'], ['off', 'none'],
  ['numbered', 'numbered'], ['t', 'numbered'],
  ['existing', 'existing'], ['nil', 'existing'],
  ['simple', 'simple'], ['never', 'simple']
]

/** The long and short options a command adds for backups, for its getopt table. */
export const backupOptions = {
  short: 'bS:',
  long: { backup: { key: 'backup', arg: 'optional' }, suffix: { key: 'S', arg: 'required' } }
}

/** The usage lines for the three options */
export const backupUsage = `  -b                           like --backup but does not accept an argument
      --backup[=CONTROL]       make a backup of each existing destination file
  -S, --suffix=SUFFIX          override the usual backup suffix`

/**
 * Reads the backup options out of a parsed list (the `[key, value]` pairs from getopt): returns
 * `{ control, suffix }` (`control` is `'none'` when no backup was asked for) or `{ error }`.
 */
export function backupSettings(options, env = globalThis.ecmaosSyscalls?.env ?? {}) {
  let requested = false
  let control
  let suffix = env.SIMPLE_BACKUP_SUFFIX || '~'
  for (const [key, value] of options) {
    if (key === 'b') requested = true
    else if (key === 'backup') { requested = true; if (typeof value === 'string') control = value }
    else if (key === 'S') { requested = true; suffix = value }
  }
  if (!requested) return { control: 'none', suffix }
  const text = control ?? env.VERSION_CONTROL ?? ''
  if (text === '') return { control: 'existing', suffix }
  const matches = NAMES.filter(([name]) => name.startsWith(text))
  const exact = NAMES.find(([name]) => name === text)
  const kinds = new Set((exact ? [exact] : matches).map(([, kind]) => kind))
  if (kinds.size !== 1) {
    const why = kinds.size === 0 ? 'invalid' : 'ambiguous'
    return {
      error: `${why} argument '${text}' for 'backup type'\nValid arguments are:\n  - 'none', 'off'\n  - 'numbered', 't'\n  - 'existing', 'nil'\n  - 'simple', 'never'`
    }
  }
  return { control: [...kinds][0], suffix }
}

/** The name a backup of `path` takes, given a way to list the directory it is in. */
export function backupName(path, { control, suffix }, list) {
  if (control === 'none') return undefined
  const dir = dirname(path)
  const name = basename(path)
  let highest = 0
  let numbered = false
  if (control === 'numbered' || control === 'existing') {
    let names = []
    try { names = list(dir) } catch { /* an unreadable directory has no numbered backups we can see */ }
    for (const entry of names) {
      if (!entry.startsWith(name + '.~') || !entry.endsWith('~')) continue
      const digits = entry.slice(name.length + 2, -1)
      if (/^[0-9]+$/.test(digits)) { numbered = true; highest = Math.max(highest, Number(digits)) }
    }
  }
  if (control === 'numbered' || (control === 'existing' && numbered)) return join(dir, `${name}.~${highest + 1}~`)
  return path + suffix
}
