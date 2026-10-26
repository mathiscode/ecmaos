/** `logger`: write messages to the system log, `/dev/log` (and so `/var/log/messages`), or with `-k` to the kernel log, `/dev/kmsg`. */

import { getopt } from './lib/getopt.mjs'
import { reasonOf } from './lib/errno.mjs'
import { readFdText, readTextFile } from './lib/fs-text.mjs'

const { argv, env, exit, writeAll, open, close, getpid, O_WRONLY } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`logger: ${text}\n`))

const usage = `Usage: logger [OPTION]... [MESSAGE]...
Enter messages into the system log.

  -i, --id[=ID]       log the process id (or ID) with the tag
  -k, --kernel        write to the kernel log, /dev/kmsg
  -p, --priority PRI  FACILITY.LEVEL, or a number (default user.notice)
  -s, --stderr        also write the message to standard error
  -t, --tag TAG       mark every line with TAG (default: the user name)
  -f, --file FILE     log the lines of FILE
  -n, --server, -u    refused: there is no syslog socket to name
      --help          display this help and exit
      --version       output version information and exit

With no MESSAGE and no -f, the lines of standard input are logged.`

const FACILITIES = { kern: 0, user: 1, mail: 2, daemon: 3, auth: 4, security: 4, syslog: 5, lpr: 6, news: 7, uucp: 8, cron: 9, authpriv: 10, ftp: 11, local0: 16, local1: 17, local2: 18, local3: 19, local4: 20, local5: 21, local6: 22, local7: 23 }
const LEVELS = { emerg: 0, panic: 0, alert: 1, crit: 2, err: 3, error: 3, warning: 4, warn: 4, notice: 5, info: 6, debug: 7 }

/** `daemon.err`, `local3.info`, a bare level (user is the facility), or a number; the combined priority, or undefined */
function priorityOf(text) {
  if (/^\d+$/.test(text)) return Number(text) <= 191 ? Number(text) : undefined
  const [first, second] = text.toLowerCase().split('.')
  if (second === undefined) return first in LEVELS ? (1 << 3) | LEVELS[first] : undefined
  return first in FACILITIES && second in LEVELS ? (FACILITIES[first] << 3) | LEVELS[second] : undefined
}

function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'i::kp:st:f:n:u:d',
    long: { id: { key: 'i', arg: 'optional' }, kernel: 'k', priority: { key: 'p', arg: 'required' }, stderr: 's', tag: { key: 't', arg: 'required' }, file: { key: 'f', arg: 'required' }, server: { key: 'n', arg: 'required' }, socket: { key: 'u', arg: 'required' }, help: 'help', version: 'version' }
  })
  if (error) { err(error); return 1 }
  let pid
  let kernel = false
  let echo = false
  let priority = 13
  let tag = env.USER || env.LOGNAME || 'root'
  let file
  for (const [key, value] of options) {
    if (key === 'help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (key === 'version') { writeAll(1, encoder.encode('logger (ecmaOS coreutils) 1.0\n')); return 0 }
    if (key === 'i') pid = value === true ? getpid() : value
    else if (key === 'k') kernel = true
    else if (key === 's') echo = true
    else if (key === 't') tag = value
    else if (key === 'f') file = value
    else if (key === 'p') {
      priority = priorityOf(value)
      if (priority === undefined) { err(`unknown priority name: ${value}`); return 1 }
    } else if (key === 'n' || key === 'u') { err('a log server cannot be named: messages go to /dev/log'); return 1 }
  }

  let lines
  if (operands.length) lines = [operands.join(' ')]
  else {
    let text
    try { text = file ? readTextFile(file) : readFdText(0) } catch (e) { err(`${file}: ${reasonOf(e)}`); return 1 }
    lines = text.split('\n').filter(line => line !== '')
  }

  const device = kernel ? '/dev/kmsg' : '/dev/log'
  let fd
  try { fd = open(device, O_WRONLY) } catch (e) { err(`cannot open ${device}: ${reasonOf(e)}`); return 1 }
  try {
    for (const line of lines) {
      const prefix = kernel || !tag ? '' : `${tag}${pid !== undefined ? `[${pid}]` : ''}: `
      writeAll(fd, encoder.encode(`<${priority}>${prefix}${line}\n`))
      if (echo) writeAll(2, encoder.encode(`${prefix}${line}\n`))
    }
  } catch (e) {
    err(`write to ${device} failed: ${reasonOf(e)}`)
    return 1
  } finally { close(fd) }
  return 0
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
