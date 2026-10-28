/**
 * `script`: run a shell (or `-c COMMAND`) on a pseudo-terminal of its own and keep what it writes, as util-linux's
 * script does: a typescript with its `Script started`/`Script done` lines, timing for `scriptreplay` (`-t`, `-T`; the
 * classic format, or the advanced one with `-m advanced`), and the keys typed (`-I`, `-B`). `--cast` (an ecmaOS
 * addition) writes an asciicast v2 recording instead, the format asciinema plays, which `scriptreplay` plays too.
 *
 * The terminal it runs on is put in raw mode, so every key goes to the pty, whose own line discipline echoes, edits
 * and signals as a terminal would; the pty is given the terminal's settings and size, and its size again on SIGWINCH.
 */

import { reasonOf } from './lib/errno.mjs'
import { getopt, tryHelp } from './lib/getopt.mjs'
import { isTty } from './lib/tty.mjs'

const sys = globalThis.ecmaosSyscalls
const { argv, env, exit, open, read, close, writeAll, getcwd, ioctl, tcgetattr, tcsetattr, winsize, spawn, waitpid, poll, onSignal, POLLIN, POLLHUP, O_WRONLY, O_CREAT, O_TRUNC } = sys
const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`script: ${text}\n`))

const O_RDWR = 2
const O_APPEND = 0o2000
const TIOCGPTN = 0x80045430
const TIOCSWINSZ = 0x5414
const SIGWINCH = 28
// termios bits (`<asm-generic/termbits.h>`)
const ISIG = 0o1, ICANON = 0o2, ECHO = 0o10, IEXTEN = 0o100000
const ICRNL = 0o400, IXON = 0o2000
const OPOST = 0o1

const usage = `Usage:
 script [options] [file]

Make a typescript of a terminal session.

Options:
 -I, --log-in <file>           log stdin to file
 -O, --log-out <file>          log stdout to file (default)
 -B, --log-io <file>           log stdin and stdout to file

 -T, --log-timing <file>       log timing information to file
 -t[<file>], --timing[=<file>] deprecated alias to -T (default file is stderr)
 -m, --logging-format <name>   force to 'classic' or 'advanced' format

     --cast <file>             record an asciicast v2 file (asciinema's format) instead of a typescript

 -a, --append                  append to the log file
 -c, --command <command>       run command rather than interactive shell
 -e, --return                  return exit code of the child process
 -f, --flush                   run flush after each write
 -E, --echo <when>             echo input in session (auto, always or never)
 -q, --quiet                   be quiet

 -h, --help                    display this help
 -V, --version                 display version`

const now = () => performance.now() / 1000

/** The local time as util-linux writes it in the typescript's first and last lines */
function stamp(date = new Date()) {
  const pad = n => String(n).padStart(2, '0')
  const offset = -date.getTimezoneOffset()
  const zone = `${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${zone}`
}

/** A log file, opened for writing (or appending); `-` for the timing file is standard error */
function logFile(path, append) {
  if (path === '-' || path === '/dev/stderr') return { fd: 2, write: bytes => writeAll(2, bytes), close() {} }
  const fd = open(path, O_WRONLY | O_CREAT | (append ? O_APPEND : O_TRUNC), 0o644)
  return { fd, write: bytes => writeAll(fd, bytes), close: () => close(fd) }
}

async function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'I:O:B:T:t::m:ac:efE:qhV',
    long: {
      'log-in': { key: 'I', arg: 'required' }, 'log-out': { key: 'O', arg: 'required' }, 'log-io': { key: 'B', arg: 'required' },
      'log-timing': { key: 'T', arg: 'required' }, timing: { key: 't', arg: 'optional' }, 'logging-format': { key: 'm', arg: 'required' },
      cast: { key: 'cast', arg: 'required' }, append: 'a', command: { key: 'c', arg: 'required' }, return: 'e', flush: 'f',
      echo: { key: 'E', arg: 'required' }, quiet: 'q', help: 'h', version: 'V'
    }
  })
  if (error) { err(error); writeAll(2, encoder.encode(tryHelp('script') + '\n')); return 1 }
  let inLog, outLog, timing, format, cast, append = false, command, returnStatus = false, quiet = false
  for (const [key, value] of options) {
    if (key === 'h') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (key === 'V') { writeAll(1, encoder.encode('script from util-linux 2.41 (ecmaOS)\n')); return 0 }
    if (key === 'I') inLog = value
    else if (key === 'O') outLog = value
    else if (key === 'B') inLog = outLog = value
    else if (key === 'T') timing = value
    else if (key === 't') timing = value === true ? '-' : value
    else if (key === 'm') {
      if (value !== 'classic' && value !== 'advanced') { err(`unsupported logging format: '${value}'`); return 1 }
      format = value
    } else if (key === 'cast') cast = value
    else if (key === 'a') append = true
    else if (key === 'c') command = value
    else if (key === 'e') returnStatus = true
    else if (key === 'q') quiet = true
    else if (key === 'E' && !['auto', 'always', 'never'].includes(value)) { err(`unsupported echo mode: '${value}'`); return 1 }
  }
  if (operands.length > 1) { err(`unexpected number of arguments`); writeAll(2, encoder.encode(tryHelp('script') + '\n')); return 1 }
  if (operands[0] && !outLog) outLog = operands[0]
  if (!outLog && !inLog && !cast) outLog = 'typescript'
  // the classic timing format describes one stream; logging the input too needs the advanced one, as util-linux says
  if (inLog && timing && format === 'classic') { err('log multiple streams is mutually exclusive with \'classic\' format'); return 1 }
  if (inLog && timing) format = 'advanced'
  format ??= 'classic'

  const terminal = isTty(0)
  const size = (() => { try { const s = winsize(0); if (s.row > 0 && s.col > 0) return { rows: s.row, cols: s.col } } catch {} return { rows: 24, cols: 80 } })()
  const shell = env.SHELL && env.SHELL.startsWith('/') ? env.SHELL : '/bin/sh'
  const childArgv = command === undefined ? [shell, '-i'] : [shell, '-c', command]

  let master, slave, ptyName
  try {
    master = open('/dev/ptmx', O_RDWR)
    ptyName = `/dev/pts/${ioctl(master, TIOCGPTN)}`
    slave = open(ptyName, O_RDWR)
  } catch (e) { err(`failed to create pseudo-terminal: ${reasonOf(e)}`); return 1 }
  if (terminal) { try { const settings = tcgetattr(0); tcsetattr(slave, settings) } catch {} }
  ioctl(master, TIOCSWINSZ, size)

  const files = []
  const opened = path => files.find(file => file.path === path)?.log
  const openLog = path => {
    const existing = opened(path)
    if (existing) return existing
    const log = logFile(path, append)
    files.push({ path, log })
    return log
  }
  let outFile, inFile, timingFile, castFile
  try {
    if (outLog) outFile = openLog(outLog)
    if (inLog) inFile = openLog(inLog)
    if (timing) timingFile = openLog(timing)
    if (cast) castFile = openLog(cast)
  } catch (e) { err(`cannot open ${e.path ?? outLog ?? cast}: ${reasonOf(e)}`); return 1 }

  const term = env.TERM || 'xterm-256color'
  const started = new Date()
  const header = `Script started on ${stamp(started)} [${command !== undefined ? `COMMAND="${command}" ` : ''}TERM="${term}" TTY="${ptyName}" COLUMNS="${size.cols}" LINES="${size.rows}"]\n`
  if (outFile) outFile.write(encoder.encode(header))
  if (inFile && inFile !== outFile) inFile.write(encoder.encode(header))
  if (castFile) castFile.write(encoder.encode(JSON.stringify({ version: 2, width: size.cols, height: size.rows, timestamp: Math.floor(started.getTime() / 1000), env: { SHELL: shell, TERM: term }, ...(command !== undefined ? { command } : {}) }) + '\n'))
  if (!quiet) {
    const logs = [outLog && `output log file is '${outLog}'`, inLog && inLog !== outLog && `input log file is '${inLog}'`, cast && `asciicast file is '${cast}'`].filter(Boolean)
    writeAll(1, encoder.encode(`Script started, ${logs.join(', ')}.\n`))
  }

  const begin = now()
  let last = begin
  // a character split across two reads is written whole, in the event of its last byte
  const decoders = { O: new TextDecoder(), I: new TextDecoder() }
  const record = (stream, bytes) => {
    const at = now()
    if (stream === 'O' && outFile) outFile.write(bytes)
    if (stream === 'I' && inFile) inFile.write(bytes)
    if (timingFile && (stream === 'O' ? outFile : inFile)) {
      const delay = (at - last).toFixed(6)
      timingFile.write(encoder.encode(format === 'advanced' ? `${stream} ${delay} ${bytes.length}\n` : `${delay} ${bytes.length}\n`))
      last = at
    }
    // the keys go in a cast only when the input is logged too (asciinema's --stdin)
    if (castFile && (stream === 'O' || inFile)) castFile.write(encoder.encode(JSON.stringify([Number((at - begin).toFixed(6)), stream === 'O' ? 'o' : 'i', decoders[stream].decode(bytes, { stream: true })]) + '\n'))
  }

  let pid
  try {
    pid = await spawn(childArgv[0], childArgv, { cwd: getcwd(), env: { ...env, TERM: term }, fds: { 0: slave, 1: slave, 2: slave }, setsid: true, ctty: slave })
  } catch (e) { err(`failed to execute ${childArgv[0]}: ${reasonOf(e)}`); return 1 }
  close(slave)

  // raw: every key to the pty as typed, its output to the terminal as written (the pty's line discipline did the rest)
  let restore = () => {}
  if (terminal) {
    const saved = tcgetattr(0)
    tcsetattr(0, { lflag: saved.lflag & ~(ICANON | ECHO | ISIG | IEXTEN), iflag: saved.iflag & ~(ICRNL | IXON), oflag: saved.oflag & ~OPOST })
    restore = () => { try { tcsetattr(0, { lflag: saved.lflag, iflag: saved.iflag, oflag: saved.oflag }) } catch {} }
  }
  let resized = false
  if (terminal) onSignal(SIGWINCH, () => { resized = true })

  const buffer = new Uint8Array(65536)
  let reading = true
  let status
  // a read of the master with nothing in it waits, so each read is asked for only when poll says there is something
  const drain = () => {
    while (poll([{ fd: master, events: POLLIN }], 0)[0] & POLLIN) {
      const n = read(master, buffer, -1)
      if (n <= 0) return
      const bytes = buffer.slice(0, n)
      writeAll(1, bytes)
      record('O', bytes)
    }
  }
  for (;;) {
    let ready = [0, 0]
    try { ready = poll(reading ? [{ fd: master, events: POLLIN }, { fd: 0, events: POLLIN }] : [{ fd: master, events: POLLIN }], 50) } catch (e) { if (!`${e?.code} ${e?.message}`.includes('EINTR')) throw e }
    if (resized) {
      resized = false
      try { const s = winsize(0); ioctl(master, TIOCSWINSZ, { rows: s.row, cols: s.col }) } catch {}
    }
    if (ready[0] & POLLIN) drain()
    if (reading && ready[1] & (POLLIN | POLLHUP)) {
      let n = 0
      try { n = read(0, buffer, -1) } catch (e) { if (!`${e?.code} ${e?.message}`.includes('EINTR')) throw e; n = -1 }
      if (n === 0) reading = false
      else if (n > 0) {
        const bytes = buffer.slice(0, n)
        writeAll(master, bytes)
        record('I', bytes)
      }
    }
    const done = await waitpid(pid, true)
    if (done) { status = done; break }
  }
  drain()
  restore()

  const code = status.signal ? 128 + status.signal : status.code
  const footer = `\nScript done on ${stamp()} [COMMAND_EXIT_CODE="${code}"]\n`
  if (outFile) outFile.write(encoder.encode(footer))
  if (inFile && inFile !== outFile) inFile.write(encoder.encode(footer))
  for (const { log } of files) log.close()
  close(master)
  if (!quiet) writeAll(1, encoder.encode('Script done.\n'))
  return returnStatus ? code : 0
}

exit(await main())
