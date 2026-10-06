/** Password aging: `chage -l alice`, `chage -M 90 -W 14 alice`, `chage -E 2027-01-01 alice`. */

import { getopt, integer } from './lib/getopt.mjs'
import { finish, manage, say, start } from './lib/accounts.mjs'

const usage = `Usage: chage [OPTION]... LOGIN
Change or show when a password and an account expire.

  -l, --list                show the aging information
  -d, --lastday LAST_DAY    the day the password was last changed
  -m, --mindays MIN_DAYS    fewest days between password changes
  -M, --maxdays MAX_DAYS    most days a password stays valid
  -W, --warndays WARN_DAYS  days of warning before it expires
  -I, --inactive INACTIVE   days after it expires before the account is disabled
  -E, --expiredate EXPIRE   the day the account expires
  --help                    display this help and exit

A day is YYYY-MM-DD or a number of days since 1970-01-01, and -1 clears a field. A password that has gone past its
maximum age plus the inactive days closes the account at login, and so does an account past its expire date. Only
root may run it.`

const DAY = 86_400_000

/** A day as `YYYY-MM-DD` or a day number; `-1` means unset (`null`); `undefined` when it is not a day */
function day(text) {
  if (/^-1$/.test(text)) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const time = Date.parse(`${text}T00:00:00Z`)
    return Number.isNaN(time) ? undefined : Math.floor(time / DAY)
  }
  const n = integer(text)
  return n === undefined || n < 0 ? undefined : n
}

/** A count of days; `-1` means unset */
function count(text) {
  if (text === '-1') return null
  const n = integer(text)
  return n === undefined || n < 0 ? undefined : n
}

const date = value => value === undefined ? 'never' : new Date(value * DAY).toISOString().slice(0, 10)
const number = value => value === undefined ? 'never' : String(value)

async function main() {
  const parsed = getopt(globalThis.ecmaosSyscalls.argv.slice(1), {
    flags: 'l', values: 'dmMWIE',
    long: { list: 'l', lastday: 'd', mindays: 'm', maxdays: 'M', warndays: 'W', inactive: 'I', expiredate: 'E' }
  })
  if (parsed.error) { say(2, `chage: ${parsed.error}\n`); return 2 }
  if (parsed.opts.help) { say(1, usage + '\n'); return 0 }
  const { opts, rest } = parsed
  if (rest.length !== 1) { say(2, `chage: ${rest.length === 0 ? 'no user name given' : 'too many arguments'}\n${usage}\n`); return 2 }

  const fields = { d: ['lastChange', day], m: ['min', count], M: ['max', count], W: ['warn', count], I: ['inactive', count], E: ['expire', day] }
  const changes = {}
  for (const [letter, [name, parse]] of Object.entries(fields)) {
    if (opts[letter] === undefined) continue
    const value = parse(opts[letter])
    if (value === undefined) { say(2, `chage: invalid numeric argument '${opts[letter]}'\n`); return 1 }
    changes[name] = value
  }
  if (!opts.l && Object.keys(changes).length === 0) { say(2, usage + '\n'); return 2 }

  const result = await manage('chage', { username: rest[0], changes })
  if (result.error) return finish('chage', result)
  if (opts.l) {
    const a = result.aging
    const expires = a.lastChange === undefined || a.max === undefined || a.max >= 99999 ? undefined : a.lastChange + a.max
    say(1, [
      `Last password change\t\t\t\t\t: ${date(a.lastChange)}`,
      `Password expires\t\t\t\t\t: ${date(expires)}`,
      `Password inactive\t\t\t\t\t: ${expires === undefined || a.inactive === undefined ? 'never' : date(expires + a.inactive)}`,
      `Account expires\t\t\t\t\t\t: ${date(a.expire)}`,
      `Minimum number of days between password change\t\t: ${number(a.min)}`,
      `Maximum number of days between password change\t\t: ${number(a.max)}`,
      `Number of days of warning before password expires\t: ${number(a.warn)}`
    ].join('\n') + '\n')
  }
  return 0
}

await start('chage', main)
