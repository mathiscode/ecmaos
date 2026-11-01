/** `lastlog`: each account's latest login, built from `/var/log/wtmp` and the accounts in `/etc/passwd`. */

import { getopt } from './lib/getopt.mjs'
import { readTextFile } from './lib/fs-text.mjs'
import { zoneAt } from './lib/tz.mjs'

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`lastlog: ${text}\n`))

const usage = `Usage: lastlog [options]

Options:
  -b, --before DAYS     print only lastlog records older than DAYS
  -C, --clear           clear lastlog record of an user (needs -u)
  -S, --set             set lastlog record to current time (needs -u)
  -t, --time DAYS       print only lastlog records more recent than DAYS
  -u, --user LOGIN      print lastlog record of the specified LOGIN
  -h, --help            display this help message and exit

The records come from /var/log/wtmp, so -C and -S, which would change them, are refused.`

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = n => String(n).padStart(2, '0')

/** `Sat Oct 31 12:00:00 -0400 2026`, in the zone TZ gives, else the browser's */
function stamp(ms) {
  const zone = zoneAt(ms)
  const offset = zone ? zone.offset : -new Date(ms).getTimezoneOffset()
  const d = new Date(ms + offset * 60000)
  const sign = offset < 0 ? '-' : '+'
  const abs = Math.abs(offset)
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)} ${d.getUTCFullYear()}`
}

const read = path => { try { return readTextFile(path) } catch { return '' } }

function main() {
  const parsed = getopt(argv.slice(1), {
    short: 'b:Ct:Su:h',
    long: { before: { key: 'b', arg: 'required' }, clear: 'C', time: { key: 't', arg: 'required' }, set: 'S', user: { key: 'u', arg: 'required' }, help: 'h' }
  })
  if (parsed.error) { err(parsed.error); out(usage + '\n'); return 1 }
  const flags = new Map(parsed.options)
  if (flags.has('h')) { out(usage + '\n'); return 0 }
  if (flags.has('C') || flags.has('S')) { err('the records are read from /var/log/wtmp and cannot be changed'); return 1 }

  const accounts = read('/etc/passwd').split('\n').filter(Boolean).map(line => line.split(':'))
  const latest = new Map()
  for (const line of read('/var/log/wtmp').split('\n')) {
    const [kind, user, tty, time] = line.split('\t')
    if (kind === 'login') latest.set(user, { tty, time: Number(time) })
  }

  let rows = accounts
  if (typeof flags.get('u') === 'string') {
    rows = accounts.filter(([name]) => name === flags.get('u'))
    if (!rows.length) { err(`user '${flags.get('u')}' does not exist`); return 1 }
  }
  const now = Date.now()
  const days = key => (typeof flags.get(key) === 'string' ? Number(flags.get(key)) : undefined)
  const before = days('b')
  const since = days('t')
  if (Number.isNaN(before) || Number.isNaN(since)) { err('invalid number of days'); return 1 }

  out('Username         Port     From             Latest\n')
  for (const [name] of rows) {
    const login = latest.get(name)
    if (before !== undefined && (!login || now - login.time < before * 86400000)) continue
    if (since !== undefined && (!login || now - login.time > since * 86400000)) continue
    out(`${name.padEnd(16)} ${login ? `${login.tty.padEnd(8)} ${''.padEnd(16)} ${stamp(login.time)}` : '                                 **Never logged in**'}\n`)
  }
  return 0
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
