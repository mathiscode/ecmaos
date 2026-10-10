/** Show the running processes, refreshed until `q`. What it can know is what `/proc` says: there is no CPU accounting in a browser. */

import { decodeKeys, rawMode, terminalSize, ttyFd } from '../../../../utils/src/commands-execve/lib/tty.mjs'
import { listProcesses, readText } from './lib/proc.mjs'

const { argv, exit, write, read, poll, POLLIN } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => write(1, encoder.encode(text))
const err = text => write(2, encoder.encode(text + '\n'))

const usage = `Usage: top [-b] [-n COUNT] [-d SECONDS]
Show the running processes and how much memory the browser reports.

  -b           batch mode: print the screen one after another instead of redrawing
  -n COUNT     stop after COUNT screens
  -d SECONDS   delay between screens (default 3)
  --help       display this help and exit

Keys: q or ^C quits, space redraws now.

There is no CPU accounting in a browser, so there is no %CPU column.`

/** `poll`, returning 0 when a signal (a window resize) cut the wait short. */
function wait(fds, ms) {
  try { return poll(fds, ms)[0] } catch (error) { if (error?.code === 'EINTR') return 0; throw error }
}

function userNames() {
  const names = new Map()
  try {
    for (const line of readText('/etc/passwd').split('\n')) {
      const [name, , uid] = line.split(':')
      if (name && uid !== undefined && !names.has(Number(uid))) names.set(Number(uid), name)
    }
  } catch { /* no passwd file: ids only */ }
  return names
}

function memoryLine() {
  try {
    const info = {}
    for (const line of readText('/proc/meminfo').split('\n')) {
      const match = /^(\w+):\s*(\d+) kB/.exec(line)
      if (match) info[match[1]] = Number(match[2])
    }
    const mib = kb => (kb / 1024).toFixed(1)
    if (info.MemTotal) return `MiB Mem : ${mib(info.MemTotal)} total${info.MemAvailable !== undefined ? `, ${mib(info.MemAvailable)} available` : ''}`
    if (info.MemAvailable !== undefined) return `MiB Mem : ${mib(info.MemAvailable)} available to this tab`
  } catch { /* none */ }
  return 'MiB Mem : not reported by this browser'
}

function uptimeText() {
  try {
    const seconds = Number(readText('/proc/uptime').split(' ')[0])
    const d = Math.floor(seconds / 86400), h = Math.floor(seconds % 86400 / 3600), m = Math.floor(seconds % 3600 / 60)
    return `${d ? `${d} days, ` : ''}${h}:${String(m).padStart(2, '0')}`
  } catch { return '?' }
}

/** One screen as lines, at most `rows` of them. */
function screen(rows) {
  const names = userNames()
  const processes = listProcesses()
  const lines = [
    `top - ${new Date().toLocaleTimeString([], { hour12: false })} up ${uptimeText()}`,
    `Tasks: ${processes.length} total`,
    memoryLine(),
    '',
    `${'PID'.padStart(7)} ${'PPID'.padStart(7)} ${'USER'.padEnd(10)} COMMAND`
  ]
  for (const { pid, ppid, uid, command } of processes) {
    if (lines.length >= rows) break
    lines.push(`${String(pid).padStart(7)} ${String(ppid).padStart(7)} ${(names.get(uid) ?? String(uid)).slice(0, 10).padEnd(10)} ${command}`)
  }
  return lines
}

function main() {
  const args = argv.slice(1)
  let batch = false
  let count = Infinity
  let delay = 3
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help' || arg === '-h') { err(usage); return 0 }
    else if (arg === '-b') batch = true
    else if (arg === '-n') count = Number(args[++i])
    else if (arg === '-d') delay = Number(args[++i])
    else { err(`top: unknown option '${arg}'`); err("Try 'top --help' for more information."); return 1 }
  }
  if (!(count >= 1) || !(delay > 0)) { err('top: the count and the delay must be positive numbers'); return 1 }

  const tty = ttyFd()
  const interactive = !batch && tty >= 0
  if (!interactive) {
    for (let n = 0; n < count; n++) {
      out(screen(Infinity).join('\n') + '\n')
      if (n + 1 < count) { wait([], delay * 1000); out('\n') }
    }
    return 0
  }

  const restore = rawMode(tty)
  out('\x1b[?25l\x1b[?1049h')
  try {
    for (let n = 0; n < count; n++) {
      const { rows } = terminalSize(tty)
      out('\x1b[H\x1b[2J' + screen(rows - 1).join('\r\n'))
      // wait for a key, or for the delay to pass
      const until = Date.now() + delay * 1000
      while (Date.now() < until) {
        const ready = wait([{ fd: tty, events: POLLIN }], until - Date.now())
        if (!ready) break
        const buffer = new Uint8Array(64)
        const got = read(tty, buffer, -1)
        if (got <= 0) return 0
        const keys = decodeKeys(buffer.subarray(0, got))
        if (keys.some(key => key === 'q' || key === 'Q')) return 0
        if (keys.includes(' ')) break
      }
    }
    return 0
  } finally {
    out('\x1b[?1049l\x1b[?25h')
    restore()
  }
}

try {
  exit(main())
} catch (error) {
  err(`top: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
