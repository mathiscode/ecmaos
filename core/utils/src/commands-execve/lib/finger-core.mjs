/** `finger` and `pinky`: who is logged in and what the accounts are. Reads `/run/utmp`, `/var/log/wtmp` and `/etc/passwd`. */

import { getopt } from './getopt.mjs'
import { readTextFile } from './fs-text.mjs'

const { argv, writeAll } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const usages = (name) => name === 'pinky'
  ? `Usage: pinky [OPTION]... [USER]...
  -l              produce long format output for the specified USERs
  -b              omit the user's home directory and shell in long format
  -f              omit the line of column headings in short format
  -w              omit the user's full name in short format
  -i              omit the user's full name and remote host in short format
  -q              omit the user's full name, remote host and idle time in short format
      --help      display this help and exit`
  : `Usage: finger [-lmps] [login ...]
  -s   short format (the default for no names)
  -l   long format (the default for names)
  -p   leave out the home directory, shell, and the plan
  -m   match login names only, not real names`

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = n => String(n).padStart(2, '0')
const long = ms => { const d = new Date(ms); return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} (${Intl.DateTimeFormat().resolvedOptions().timeZone})` }
const short = ms => { const d = new Date(ms); return `${MONTHS[d.getMonth()]} ${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}` }
const read = path => { try { return readTextFile(path) } catch { return '' } }

/** Runs `name` ('finger' or 'pinky') over the command line and returns the exit status */
export function fingerMain(name) {
  const err = text => writeAll(2, encoder.encode(`${name}: ${text}\n`))
  const usage = usages(name)
  const parsed = getopt(argv.slice(1), { short: 'lspmbfwiqh', long: { help: 'h' } })
  if (parsed.error) { err(parsed.error); out(usage + '\n'); return 1 }
  const flags = new Set(parsed.options.map(([key]) => key))
  if (flags.has('h')) { out(usage + '\n'); return 0 }

  const accounts = read('/etc/passwd').split('\n').filter(Boolean).map(line => {
    const [login, , uid, , gecos, home, shell] = line.split(':')
    return { login, uid, full: (gecos ?? '').split(',')[0], home, shell }
  })
  const sessions = read('/run/utmp').split('\n').filter(Boolean).map(line => { const [login, tty, time] = line.split('\t'); return { login, tty, time: Number(time) } })
  const logins = new Map()
  for (const line of read('/var/log/wtmp').split('\n')) {
    const [kind, user, tty, time] = line.split('\t')
    if (kind === 'login') logins.set(user, { tty, time: Number(time) })
  }

  const wantLong = name === 'pinky' ? flags.has('l') : flags.has('l') || (parsed.operands.length > 0 && !flags.has('s'))
  if (!wantLong) {
    const wanted = parsed.operands
    const rows = sessions.filter(row => !wanted.length || wanted.includes(row.login))
    if (name === 'pinky') {
      if (!flags.has('f')) out(`Login    ${flags.has('w') || flags.has('i') || flags.has('q') ? '' : 'Name                 '}TTY      ${flags.has('q') ? '' : 'Idle   '}When\n`)
      for (const row of rows) {
        const account = accounts.find(a => a.login === row.login)
        out(`${row.login.padEnd(8)} ${flags.has('w') || flags.has('i') || flags.has('q') ? '' : (account?.full ?? '').padEnd(20) + ' '}${row.tty.padEnd(8)} ${flags.has('q') ? '' : '       '}${short(row.time)}\n`)
      }
    } else {
      out('Login     Name              Tty      Idle  Login Time   Office     Office Phone\n')
      for (const row of rows) {
        const account = accounts.find(a => a.login === row.login)
        out(`${row.login.padEnd(9)} ${(account?.full ?? '').padEnd(17)} ${row.tty.padEnd(8)} ${''.padEnd(5)} ${short(row.time)}\n`)
      }
    }
    return 0
  }

  const names = parsed.operands.length ? parsed.operands : accounts.map(a => a.login)
  let first = true
  for (const wanted of names) {
    const account = accounts.find(a => a.login === wanted) ?? (flags.has('m') ? undefined : accounts.find(a => a.full.toLowerCase() === wanted.toLowerCase()))
    if (!account) { out(`${name}: ${wanted}: no such user.\n`); continue }
    if (!first) out('\n')
    first = false
    out(`Login: ${account.login.padEnd(32)}Name: ${account.full}\n`)
    if (!flags.has('b') && !flags.has('p')) out(`Directory: ${(account.home ?? '').padEnd(28)}Shell: ${account.shell ?? ''}\n`)
    const here = sessions.filter(row => row.login === account.login)
    for (const row of here) out(`On since ${long(row.time)} on ${row.tty}\n`)
    const last = logins.get(account.login)
    if (!here.length) out(last ? `Last login ${long(last.time)} on ${last.tty}\n` : 'Never logged in.\n')
    if (name === 'finger') {
      out('No mail.\n')
      if (!flags.has('p')) out('No Plan.\n')
    }
  }
  return 0
}

