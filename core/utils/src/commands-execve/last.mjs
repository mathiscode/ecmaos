/** Show past logins, newest first, read from `/var/log/wtmp`. */

const { argv, exit, writeAll, open, read, close, O_RDONLY } = globalThis.ecmaosSyscalls

const usage = `Usage: last [-n NUM] [USER]...
Show the logins recorded in /var/log/wtmp, newest first.

  -n, --limit NUM  show at most NUM lines
  --help           display this help and exit

A session ends at the next system boot, since a console has no logout to record: the page
closing is not something that can write a line. The current boot's logins read "still logged in".`

function readText(path) {
  const fd = open(path, O_RDONLY)
  try {
    const chunks = []
    let total = 0
    while (true) {
      const buffer = new Uint8Array(65536)
      const n = read(fd, buffer, -1)
      if (n <= 0) break
      chunks.push(buffer.subarray(0, n))
      total += n
    }
    const joined = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length }
    return new TextDecoder().decode(joined)
  } finally {
    close(fd)
  }
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = n => String(n).padStart(2, '0')
const stamp = ms => {
  const d = new Date(Number(ms))
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const clock = ms => { const d = new Date(Number(ms)); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
const span = ms => {
  const minutes = Math.max(0, Math.floor(ms / 60000))
  const days = Math.floor(minutes / 1440)
  const hh = pad(Math.floor((minutes % 1440) / 60)), mm = pad(minutes % 60)
  return days > 0 ? `${days}+${hh}:${mm}` : `${hh}:${mm}`
}

function main() {
  const args = argv.slice(1)
  if (args.includes('--help') || args.includes('-h')) {
    writeAll(1, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  let limit = Infinity
  const users = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-n' || args[i] === '--limit') limit = Number(args[++i])
    else if (/^-\d+$/.test(args[i])) limit = Number(args[i].slice(1))
    else users.push(args[i])
  }
  if (!(limit >= 0)) {
    writeAll(2, new TextEncoder().encode('last: invalid line count\n'))
    return 1
  }

  const records = readText('/var/log/wtmp').split('\n').filter(Boolean).map(line => line.split('\t'))

  // Walk newest to oldest. A login is still open only if no boot line came after it.
  const rows = []
  let nextBoot // the boot line just newer than the entries being walked
  for (let i = records.length - 1; i >= 0; i--) {
    const [kind, user, tty, time] = records[i]
    if (kind === 'boot') {
      nextBoot = Number(time)
      rows.push({ user: 'reboot', tty: 'system boot', time: Number(time), end: undefined, boot: true })
    } else if (kind === 'login') {
      rows.push({ user, tty, time: Number(time), end: nextBoot, boot: false })
    }
  }

  let shown = 0
  for (const row of rows) {
    if (shown >= limit) break
    if (users.length > 0 && !users.includes(row.user)) continue
    let tail
    if (row.boot) tail = ''
    else if (row.end === undefined) tail = '  still logged in'
    else tail = ` - ${clock(row.end)}  (${span(row.end - row.time)})`
    writeAll(1, new TextEncoder().encode(`${row.user.padEnd(8)} ${row.tty.padEnd(12)} ${stamp(row.time)}${tail}\n`))
    shown++
  }
  return 0
}

try {
  exit(main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`last: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
