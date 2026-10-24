/** Show who is logged in and what the machine is doing: the uptime line, then one line per console with a login (`/run/utmp`). */

import { readTextFile } from './lib/fs-text.mjs'

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(text + '\n'))

const usage = `Usage: w [-h] [-s] [USER]
Show who is logged in and what the machine is doing.

  -h, --no-header  no header line
  -s, --short      no login time or CPU columns
  --help           display this help and exit

The first line is the time, how long the machine has been up, how many users are logged in and the load averages.
Each line after the header is a console with a login, read from /run/utmp. WHAT is '-': the kernel does not say
what a terminal's foreground program is.`

const pad = n => String(n).padStart(2, '0')

/** procps's wording: `5 min`, `3:20`, or `1 day,  3:20` */
function upFor(seconds) {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days) return `${days} day${days === 1 ? '' : 's'}, ${String(hours).padStart(2)}:${pad(minutes)}`
  if (hours) return `${hours}:${pad(minutes)}`
  return `${minutes} min`
}

/** `HH:MM` today, or `DayMon` for an older login, as `w` prints it */
function loggedAt(ms) {
  const at = new Date(ms)
  const now = new Date()
  if (at.toDateString() === now.toDateString()) return `${pad(at.getHours())}:${pad(at.getMinutes())}`
  return `${at.toLocaleString('en', { weekday: 'short' })}${pad(at.getHours())}`
}

function main() {
  const args = argv.slice(1)
  let header = true
  let short = false
  let only
  for (const arg of args) {
    if (arg === '--help') { out(usage + '\n'); return 0 }
    else if (arg === '-h' || arg === '--no-header') header = false
    else if (arg === '-s' || arg === '--short') short = true
    else if (arg.startsWith('-')) { err(`w: unknown option '${arg}'`); err("Try 'w --help' for more information."); return 1 }
    else only = arg
  }

  let logins = []
  try {
    logins = readTextFile('/run/utmp').split('\n').filter(Boolean).map(row => {
      const [user, tty, at] = row.split('\t')
      return { user, tty, at: Number(at) }
    })
  } catch { /* nobody has logged in */ }
  if (only) logins = logins.filter(login => login.user === only)

  let load = '0.00 0.00 0.00'
  try { load = readTextFile('/proc/loadavg').split(' ').slice(0, 3).join(' ') } catch { /* no /proc/loadavg */ }
  const now = new Date()

  if (header) {
    const uptime = Number(readTextFile('/proc/uptime').split(' ')[0]) || 0
    out(` ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} up ${upFor(uptime)},  ${logins.length} user${logins.length === 1 ? '' : 's'},  load average: ${load.split(' ').join(', ')}\n`)
    out(short ? 'USER     TTY      FROM    IDLE WHAT\n' : 'USER     TTY      FROM             LOGIN@   IDLE   JCPU   PCPU WHAT\n')
  }
  for (const { user, tty, at } of logins) {
    out(short
      ? `${user.padEnd(8)} ${tty.padEnd(8)} ${'-'.padEnd(7)} 0.00s -\n`
      : `${user.padEnd(8)} ${tty.padEnd(8)} ${'-'.padEnd(16)} ${loggedAt(at).padEnd(8)} 0.00s  0.00s  0.00s -\n`)
  }
  return 0
}

try {
  exit(main())
} catch (error) {
  err(`w: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
