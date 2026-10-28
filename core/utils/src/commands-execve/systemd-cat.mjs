/**
 * `systemd-cat`: connect a command's output, or standard input, to the system log. Each line becomes a message on
 * `/dev/log` as `IDENT[PID]: line` (the pid is the command's), and so a line of `/var/log/messages` and of `journalctl`.
 * A line starting `<N>` is logged at level N unless `--level-prefix=false`. Init runs every unit's processes under it.
 * There is no exec here, so the command is a child: this program reads its output through pipes, ignores the signals
 * that stop a unit so as to log what the command prints as it goes down, and then ends as the command did, by the same
 * signal or with the same status.
 */

import { getopt, tryHelp } from './lib/getopt.mjs'
import { reasonOf } from './lib/errno.mjs'

const sys = globalThis.ecmaosSyscalls
const { argv, env, exit, writeAll, open, close, read, pipe, spawn, waitpid, poll, stat, isDirectory, getpid, custom, onSignal, offSignal, getcwd, POLLIN, POLLHUP, O_WRONLY } = sys
const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`systemd-cat: ${text}\n`))

const usage = `systemd-cat [OPTIONS...] COMMAND ...

Execute process with stdout/stderr connected to the journal.

  -h --help                      Show this help
     --version                   Show package version
  -t --identifier=STRING         Set syslog identifier
  -p --priority=PRIORITY         Set priority value (0..7)
     --stderr-priority=PRIORITY  Set priority value (0..7) used for stderr
     --level-prefix=BOOL         Control whether level prefix shall be parsed`

const LEVELS = { emerg: 0, alert: 1, crit: 2, err: 3, warning: 4, notice: 5, info: 6, debug: 7 }
const levelOf = text => /^[0-7]$/.test(text) ? Number(text) : LEVELS[text]
/** The signals a unit is stopped and interrupted by: the command takes them, this program keeps reading */
const HELD = [1, 2, 3, 15]

function findProgram(command) {
  const isFile = path => { try { return !isDirectory(path) && (stat(path), true) } catch { return false } }
  if (command.includes('/')) return isFile(command) ? command : undefined
  for (const dir of (env.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(':')) if (dir && isFile(`${dir}/${command}`)) return `${dir}/${command}`
  return undefined
}

function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'ht:p:',
    long: { help: 'h', version: 'version', identifier: { key: 't', arg: 'required' }, priority: { key: 'p', arg: 'required' }, 'stderr-priority': { key: 'stderr', arg: 'required' }, 'level-prefix': { key: 'prefix', arg: 'required' } },
    permute: false
  })
  if (error) { err(error); writeAll(2, encoder.encode(tryHelp('systemd-cat') + '\n')); return Promise.resolve(1) }
  let identifier
  let priority = 6
  let stderrPriority
  let levelPrefix = true
  for (const [key, value] of options) {
    if (key === 'h') { writeAll(1, encoder.encode(usage + '\n')); return Promise.resolve(0) }
    if (key === 'version') { writeAll(1, encoder.encode('systemd-cat (ecmaOS coreutils) 1.0\n')); return Promise.resolve(0) }
    if (key === 't') identifier = value
    else if (key === 'p' || key === 'stderr') {
      const level = levelOf(value)
      if (level === undefined) { err(`Failed to parse ${key === 'p' ? '' : 'stderr '}priority value: ${value}`); return Promise.resolve(1) }
      if (key === 'p') priority = level
      else stderrPriority = level
    } else if (key === 'prefix') levelPrefix = !/^(0|no|false|off)$/i.test(value)
  }
  stderrPriority ??= priority

  let log
  try { log = open('/dev/log', O_WRONLY) } catch (e) { err(`Failed to connect to the system log: ${reasonOf(e)}`); return Promise.resolve(1) }

  const sendLine = (line, level, pid) => {
    let text = line
    let lineLevel = level
    const prefix = levelPrefix && /^<([0-7])>/.exec(text)
    if (prefix) { lineLevel = Number(prefix[1]); text = text.slice(3) }
    const tag = identifier ?? 'systemd-cat'
    // facility user, as systemd-cat logs
    try { writeAll(log, encoder.encode(`<${8 + lineLevel}>${tag}${pid ? `[${pid}]` : ''}: ${text}\n`)) } catch { /* the log is gone; the command still runs */ }
  }

  /** Reads `streams` (`{ fd, level }`) to their end, logging each line as `pid`'s */
  const drain = (streams, pid) => {
    const decoder = new TextDecoder()
    const pending = streams.map(() => '')
    const open_ = streams.map(() => true)
    const buffer = new Uint8Array(65536)
    while (open_.some(Boolean)) {
      const watching = streams.map((stream, i) => ({ stream, i })).filter(({ i }) => open_[i])
      let ready
      try { ready = poll(watching.map(({ stream }) => ({ fd: stream.fd, events: POLLIN })), -1) } catch (e) { if (`${e?.code} ${e?.message}`.includes('EINTR')) continue; throw e }
      ready.forEach((revents, index) => {
        if (!(revents & (POLLIN | POLLHUP))) return
        const { stream, i } = watching[index]
        let n
        try { n = read(stream.fd, buffer, -1) } catch (e) { if (`${e?.code} ${e?.message}`.includes('EINTR')) return; n = 0 }
        if (n <= 0) {
          open_[i] = false
          if (pending[i]) sendLine(pending[i], stream.level, pid)
          pending[i] = ''
          return
        }
        const lines = (pending[i] + decoder.decode(buffer.subarray(0, n), { stream: true })).split('\n')
        pending[i] = lines.pop()
        for (const line of lines) sendLine(line.replace(/\r$/, ''), stream.level, pid)
      })
    }
  }

  if (operands.length === 0) {
    drain([{ fd: 0, level: priority }], 0)
    close(log)
    return Promise.resolve(0)
  }

  const program = findProgram(operands[0])
  if (!program) { err(`Failed to execute ${operands[0]}: No such file or directory`); return Promise.resolve(1) }
  identifier ??= operands[0].slice(operands[0].lastIndexOf('/') + 1)
  const [outRead, outWrite] = pipe()
  const separate = stderrPriority !== priority
  const [errRead, errWrite] = separate ? pipe() : [outRead, outWrite]
  for (const signal of HELD) onSignal(signal, () => {})
  return spawn(program, operands, { cwd: getcwd(), env: { ...env }, fds: { 1: outWrite, 2: errWrite } }).then(async pid => {
    close(outWrite)
    if (separate) close(errWrite)
    drain(separate ? [{ fd: outRead, level: priority }, { fd: errRead, level: stderrPriority }] : [{ fd: outRead, level: priority }], pid)
    close(outRead)
    if (separate) close(errRead)
    close(log)
    let done
    for (;;) {
      try { done = await waitpid(pid, false); break } catch (e) { if (!`${e?.code} ${e?.message}`.includes('EINTR')) throw e }
    }
    if (done.signal) {
      // end as the command did: the signal's default action, with nothing held any more
      for (const signal of HELD) offSignal?.(signal)
      await custom('proc_kill', getpid(), done.signal).catch(() => {})
      return 128 + done.signal
    }
    return done.code
  }, e => {
    err(`Failed to execute ${operands[0]}: ${reasonOf(e)}`)
    return 1
  })
}

try {
  exit(await main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
