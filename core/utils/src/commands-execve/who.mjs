/** Show who is logged in, read from `/run/utmp`: one line per console with a login. */

const { argv, exit, writeAll, open, read, close, O_RDONLY } = globalThis.ecmaosSyscalls

const usage = `Usage: who [OPTION]
Print who is logged in, one console per line.

  -b, --boot   print the time of the last system boot
  -q, --count  print the login names and the number of users
  --help       display this help and exit

Reads /run/utmp. Each line is: NAME  LINE  TIME`

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

const pad = n => String(n).padStart(2, '0')
const stamp = ms => {
  const d = new Date(Number(ms))
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function main() {
  const args = argv.slice(1)
  if (args.includes('--help') || args.includes('-h')) {
    writeAll(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  const out = text => writeAll(1, new TextEncoder().encode(text))

  if (args.includes('-b') || args.includes('--boot')) {
    const boots = readText('/var/log/wtmp').split('\n').filter(line => line.startsWith('boot\t'))
    const last = boots[boots.length - 1]
    if (last) out(`         system boot  ${stamp(last.split('\t')[3])}\n`)
    return 0
  }

  const rows = readText('/run/utmp').split('\n').filter(Boolean).map(line => line.split('\t'))

  if (args.includes('-q') || args.includes('--count')) {
    out(rows.map(([user]) => user).join(' ') + (rows.length ? '\n' : '') + `# users=${rows.length}\n`)
    return 0
  }

  for (const [user, tty, time] of rows) out(`${user.padEnd(12)} ${tty.padEnd(10)} ${stamp(time)}\n`)
  return 0
}

try {
  exit(main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`who: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
