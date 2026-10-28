/**
 * `flock`: run a command while holding a lock on a file, so that scripts take turns. The lock is a whole-file record
 * lock (the kernel's `fcntl` locks, which C programs' `lockf` and `fcntl` meet too), held by `flock` itself while the
 * command runs and given up when it ends. On Linux `flock(2)` locks are a separate kind; here they are the same one.
 * `flock FD`, which locks a descriptor the shell holds and leaves it locked, is refused: a lock belongs to the process that
 * takes it, and `flock` would end at once.
 */

import { getopt, tryHelp } from './lib/getopt.mjs'
import { reasonOf } from './lib/errno.mjs'

const { argv, env, exit, writeAll, open, close, stat, isDirectory, spawn, waitpid, getcwd, custom, O_RDONLY, O_CREAT } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`flock: ${text}\n`))

const usage = `
Usage:
 flock [options] <file>|<directory> <command> [<argument>...]
 flock [options] <file>|<directory> -c <command>
 flock [options] <file descriptor number>

Manage file locks from shell scripts.

Options:
 -s, --shared             get a shared lock
 -x, --exclusive          get an exclusive lock (default)
 -u, --unlock             remove a lock
 -n, --nonblock           fail rather than wait
 -w, --timeout <secs>     wait for a limited amount of time
 -E, --conflict-exit-code <number>  exit code after conflict or timeout
 -o, --close              close file descriptor before running command
 -c, --command <command>  run a single command string through the shell
 -F, --no-fork            execute command without forking
     --verbose            increase verbosity

 -h, --help               display this help
 -V, --version            display version`

const READ_LOCK = 0, WRITE_LOCK = 1
const SET = 1, SET_WAIT = 2, RELEASE = 3

function findProgram(command) {
  const isFile = path => { try { return !isDirectory(path) && (stat(path), true) } catch { return false } }
  if (command.includes('/')) return isFile(command) ? command : undefined
  for (const dir of (env.PATH ?? '/bin:/usr/bin').split(':')) if (dir && isFile(`${dir}/${command}`)) return `${dir}/${command}`
  return undefined
}

async function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'sxunw:E:oc:FhV',
    long: { shared: 's', exclusive: 'x', unlock: 'u', nonblock: 'n', nb: 'n', timeout: { key: 'w', arg: 'required' }, wait: { key: 'w', arg: 'required' }, 'conflict-exit-code': { key: 'E', arg: 'required' }, close: 'o', command: { key: 'c', arg: 'required' }, 'no-fork': 'F', verbose: 'verbose', help: 'h', version: 'V' },
    permute: false
  })
  if (error) { err(error); writeAll(2, encoder.encode(tryHelp('flock') + '\n')); return 64 }
  let type = WRITE_LOCK
  let unlock = false
  let nonblock = false
  let timeout
  let conflict = 1
  let command
  let verbose = false
  for (const [key, value] of options) {
    if (key === 'h') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (key === 'V') { writeAll(1, encoder.encode('flock from util-linux 2.40 (ecmaOS)\n')); return 0 }
    if (key === 's') type = READ_LOCK
    else if (key === 'x') type = WRITE_LOCK
    else if (key === 'u') unlock = true
    else if (key === 'n') nonblock = true
    else if (key === 'w') {
      timeout = Number(value)
      if (!Number.isFinite(timeout) || timeout < 0) { err(`invalid timeout value: '${value}'`); return 64 }
      if (timeout === 0) nonblock = true
    } else if (key === 'E') {
      conflict = Number(value)
      if (!Number.isInteger(conflict) || conflict < 0 || conflict > 255) { err(`invalid exit code: '${value}'`); return 64 }
    } else if (key === 'c') command = value
    else if (key === 'F') { err('--no-fork is not possible here: there is no exec, so the command always runs as a child'); return 64 }
    else if (key === 'verbose') verbose = true
  }
  const [target, ...rest] = operands
  if (target === undefined) { err('requires file descriptor, file or directory'); writeAll(2, encoder.encode(tryHelp('flock') + '\n')); return 64 }
  if (/^\d+$/.test(target) && command === undefined && rest.length === 0) {
    err(`cannot lock descriptor ${target}: a lock belongs to the process that takes it, so it would end with flock; use flock FILE COMMAND`)
    return 64
  }
  if (command === undefined && rest.length === 0) { err('requires a command to run'); return 64 }
  if (command !== undefined && rest.length) { err('-c requires exactly one command argument'); return 64 }

  // the file is opened (and made, if need be) as flock opens it, so a missing one or one that cannot be read says so
  let fd
  try { fd = open(target, O_RDONLY | O_CREAT, 0o666) } catch {
    try { fd = open(target, O_RDONLY) } catch (e) { err(`cannot open lock file ${target}: ${reasonOf(e)}`); return 66 }
  }
  let info
  try { info = stat(target) } catch (e) { err(`${target}: ${reasonOf(e)}`); close(fd); return 66 }
  const key = `${info.dev}:${info.ino}`

  if (unlock) { await custom('lock_op', RELEASE, key, 0, 0, 0); close(fd); return 0 }

  const started = Date.now()
  for (;;) {
    try {
      await custom('lock_op', nonblock || timeout !== undefined ? SET : SET_WAIT, key, type, 0, -1)
      break
    } catch (e) {
      const text = `${e?.code} ${e?.message}`
      if (!/EAGAIN/.test(text)) { err(`${target}: ${reasonOf(e)}`); close(fd); return 1 }
      if (nonblock || (timeout !== undefined && Date.now() - started >= timeout * 1000)) {
        if (verbose) err(nonblock ? 'failed to get lock' : 'timeout while waiting to get lock')
        close(fd)
        return conflict
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  if (verbose) err(`getting lock took ${((Date.now() - started) / 1000).toFixed(6)} seconds`)

  const shell = env.SHELL && env.SHELL.startsWith('/') ? env.SHELL : '/bin/sh'
  const argvOf = command !== undefined ? [shell, '-c', command] : rest
  const program = command !== undefined ? shell : findProgram(rest[0])
  if (!program) { err(`failed to execute ${rest[0]}: No such file or directory`); return 127 }
  if (verbose) err(`executing ${argvOf.join(' ')}`)
  let status
  try {
    const pid = await spawn(program, argvOf, { cwd: getcwd(), env: { ...env } })
    const done = await waitpid(pid, false)
    status = done.signal ? 128 + done.signal : done.code
  } catch (e) {
    err(`failed to execute ${argvOf[0]}: ${reasonOf(e)}`)
    status = 126
  }
  await custom('lock_op', RELEASE, key, 0, 0, 0).catch(() => {})
  close(fd)
  return status
}

try {
  exit(await main())
} catch (error) {
  err(reasonOf(error))
  exit(1)
}
