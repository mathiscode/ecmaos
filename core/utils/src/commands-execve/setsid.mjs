/**
 * `setsid`: run a program in a new session, away from the terminal. There is no exec, so the program is always a child
 * started as the leader of its own session (as `-f` asks); `setsid` returns at once unless `-w` says to wait for it and
 * return its status, which is what a shell sees of `setsid` on Linux, since a command it runs leads its own group.
 */

import { getopt, tryHelp } from './lib/getopt.mjs'
import { reasonOf } from './lib/errno.mjs'

const { argv, env, exit, writeAll, spawn, waitpid, stat, isDirectory, getcwd, tcgetattr, custom } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`setsid: ${text}\n`))

const usage = `
Usage:
 setsid [options] <program> [arguments ...]

Run a program in a new session.

Options:
 -c, --ctty     set the controlling terminal to the current one
 -f, --fork     always fork
 -w, --wait     wait program to exit, and use the same return

 -h, --help     display this help
 -V, --version  display version`

function findProgram(command) {
  const isFile = path => { try { return !isDirectory(path) && (stat(path), true) } catch { return false } }
  if (command.includes('/')) return isFile(command) ? command : undefined
  for (const dir of (env.PATH ?? '/bin:/usr/bin').split(':')) if (dir && isFile(`${dir}/${command}`)) return `${dir}/${command}`
  return undefined
}

async function main() {
  const { options, operands, error } = getopt(argv.slice(1), { short: 'cfwhV', long: { ctty: 'c', fork: 'f', wait: 'w', help: 'h', version: 'V' }, permute: false })
  if (error) { err(error); writeAll(2, encoder.encode(tryHelp('setsid') + '\n')); return 1 }
  let wait = false
  let ctty = false
  for (const [key] of options) {
    if (key === 'h') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (key === 'V') { writeAll(1, encoder.encode('setsid from util-linux 2.40 (ecmaOS)\n')); return 0 }
    if (key === 'w') wait = true
    else if (key === 'c') ctty = true
  }
  if (operands.length === 0) { err('no command specified'); writeAll(2, encoder.encode(tryHelp('setsid') + '\n')); return 1 }
  const program = findProgram(operands[0])
  if (!program) { err(`failed to execute ${operands[0]}: No such file or directory`); return 127 }
  // -c gives the new session this terminal, as TIOCSCTTY does
  let tty
  if (ctty) {
    try { tcgetattr(0) } catch { err('failed to set the controlling terminal: standard input is not a terminal'); return 1 }
    tty = await custom('tty_get')
  }
  let pid
  try {
    pid = await spawn(program, operands, { cwd: getcwd(), env: { ...env }, setsid: true, ...(tty !== undefined ? { tty } : {}) })
  } catch (e) { err(`failed to execute ${operands[0]}: ${reasonOf(e)}`); return 126 }
  if (!wait) return 0
  const done = await waitpid(pid, false)
  return done.signal ? 128 + done.signal : done.code
}

try {
  exit(await main())
} catch (error) {
  err(reasonOf(error))
  exit(1)
}
