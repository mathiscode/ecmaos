/** Write a message to every terminal with someone logged in. */

import { readFdText, readTextFile } from './lib/fs-text.mjs'

const { argv, env, exit, writeAll, open, close, O_WRONLY } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(text + '\n'))

const usage = `Usage: wall [-n] [MESSAGE]
Write MESSAGE, or standard input, to every terminal that has a login.

  -n      do not print the banner line
  --help  display this help and exit

The terminals are the lines of /run/utmp (see who).`


function main() {
  const args = argv.slice(1)
  let banner = true
  const words = []
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') { err(usage); return 0 }
    else if (arg === '-n') banner = false
    else words.push(arg)
  }
  const message = words.length ? words.join(' ') + '\n' : readFdText(0)
  if (!message.trim()) { err('wall: no message'); return 1 }

  const hostname = (() => { try { return readTextFile('/etc/hostname').trim() } catch { return 'localhost' } })()
  const heading = banner ? `\r\n\x07Broadcast message from ${env?.USER ?? 'unknown'}@${hostname} (${new Date().toLocaleString()}):\r\n\r\n` : '\r\n'
  const text = heading + message.replace(/\r?\n/g, '\r\n') + '\r\n'

  let lines = []
  try {
    lines = [...new Set(readTextFile('/run/utmp').split('\n').filter(Boolean).map(row => row.split('\t')[1]))]
  } catch { /* nobody logged in */ }

  let failed = 0
  for (const line of lines) {
    try {
      const fd = open(`/dev/xterm${String(line).replace(/^tty/, '')}`, O_WRONLY)
      try { writeAll(fd, encoder.encode(text)) } finally { close(fd) }
    } catch {
      failed++
    }
  }
  if (failed) err(`wall: could not reach ${failed} terminal${failed === 1 ? '' : 's'}`)
  return failed ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  err(`wall: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
