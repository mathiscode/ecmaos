/** Send a message to one user's terminal. */

import { readFdText, readTextFile } from './lib/fs-text.mjs'
import { deviceOf, mayWrite } from './lib/mesg-state.mjs'

const { argv, env, exit, writeAll, open, close, O_WRONLY } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(text + '\n'))

const usage = `Usage: write USER [TTY]
Send standard input to USER's terminal, ending at end of input (^D).

  TTY     the terminal to use when the user has more than one (tty1 or just 1)
  --help  display this help and exit`

function main() {
  const args = argv.slice(1)
  if (args.includes('--help') || args.includes('-h')) { globalThis.ecmaosSyscalls.writeAll(1, new TextEncoder().encode(usage + '\n')); return 0 }
  if (args.length < 1 || args.length > 2) { err('write: usage: write USER [TTY]'); return 1 }
  const [user, requested] = args

  let rows = []
  try {
    rows = readTextFile('/run/utmp').split('\n').filter(Boolean).map(row => row.split('\t'))
  } catch { /* nobody logged in */ }
  const lines = rows.filter(row => row[0] === user).map(row => row[1])
  if (!lines.length) { err(`write: ${user} is not logged in`); return 1 }

  let line = lines[0]
  if (requested) {
    const wanted = /^tty/.test(requested) ? requested : `tty${requested}`
    if (!lines.includes(wanted)) { err(`write: ${user} is not logged in on ${wanted}`); return 1 }
    line = wanted
  } else if (lines.length > 1) {
    err(`write: ${user} is logged in more than once; writing to ${line}`)
  }

  if (!mayWrite(deviceOf(line))) { err(`write: ${user} has messages disabled on ${line}`); return 1 }

  const message = readFdText(0)
  if (!message.trim()) return 0
  const hostname = (() => { try { return readTextFile('/etc/hostname').trim() } catch { return 'localhost' } })()
  const text = `\r\n\x07Message from ${env?.USER ?? 'unknown'}@${hostname} at ${new Date().toLocaleTimeString([], { hour12: false })}:\r\n${message.replace(/\r?\n/g, '\r\n')}EOF\r\n`
  try {
    const fd = open(`/dev/xterm${line.replace(/^tty/, '')}`, O_WRONLY)
    try { writeAll(fd, encoder.encode(text)) } finally { close(fd) }
  } catch (error) {
    err(`write: cannot write to ${line}: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  return 0
}

try {
  exit(main())
} catch (error) {
  err(`write: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
