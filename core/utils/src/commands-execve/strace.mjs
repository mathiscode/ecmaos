/**
 * Runs a command and prints its system calls: `strace ls /`. The kernel writes one line per call to this program's
 * stderr (or the file `-o` names). Not `ptrace`: the command is never stopped, and arguments are as the kernel
 * received them.
 */

import { findProgram, statusOf, waitFor } from './lib/run.mjs'

const sys = globalThis.ecmaosSyscalls
const { argv, exit, writeAll, spawn, getcwd, env, open, close, custom } = sys

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`strace: ${text}\n`))

const usage = `Usage: strace [OPTION]... COMMAND [ARG]...
       strace [OPTION]... -p PID
Run COMMAND and print the system calls it makes, or print those of a process that is already running.

  -p PID              attach to a running process (yours, or any if you are root); ^C detaches
  -f                  also trace the programs COMMAND starts
  -o FILE             write the trace to FILE instead of standard error
  -s N                show at most N bytes of a string or buffer (default 32)
  -e trace=SET        only these calls: names, or file, desc, process, signal, network; a leading ! excludes
  -c                  count the calls and print a table at the end instead of the calls
  -t, -tt, -r         a time on each line: seconds, with microseconds, or since the last call
  -y                  show the path an fd was opened from beside its number
  --help              display this help and exit

This logs the calls the kernel sees; it does not stop or step the program as ptrace does.`

/** `-p`: trace a process that is already running until it ends (or until ^C ends this program, which detaches) */
async function follow(pid, options, outFile) {
  let fd = 2
  if (outFile) {
    try { fd = open(outFile, 0o1101, 0o644) } catch (error) { err(`${outFile}: ${error?.message ?? error}`); return 1 }
  }
  try {
    await custom('trace_attach', pid, JSON.stringify({ fd, ...options }))
  } catch (error) {
    const reason = String(error?.message ?? error).replace(/^[A-Z]+: /, '').replace(/, trace_attach$/, '')
    err(`attach: ptrace(PTRACE_SEIZE, ${pid}): ${reason.charAt(0).toUpperCase()}${reason.slice(1)}`)
    if (outFile) close(fd)
    return 1
  }
  err(`Process ${pid} attached`)
  for (;;) {
    try { await custom('proc_kill', pid, 0) } catch { break }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  // the kernel writes the end of the trace as the process goes; let it land
  await new Promise(resolve => setTimeout(resolve, 100))
  if (outFile) close(fd)
  return 0
}

async function main() {
  const args = argv.slice(1)
  const options = {}
  let outFile
  let attach
  let i = 0
  const needs = (flag, text) => { if (text === undefined) { err(`option requires an argument -- '${flag}'`); return false } return true }
  for (; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (arg === '--') { i++; break }
    if (!arg.startsWith('-') || arg === '-') break
    if (arg === '-f' || arg === '--follow-forks') options.follow = true
    else if (arg === '-c') options.summary = true
    else if (arg === '-p' || arg.startsWith('-p')) {
      const text = arg.length > 2 ? arg.slice(2) : args[++i]
      if (!needs('p', text)) return 1
      if (!/^\d+$/.test(text)) { err(`Invalid process id: '${text}'`); return 1 }
      attach = Number(text)
    }
    else if (arg === '-t') options.clock = 'time'
    else if (arg === '-tt') options.clock = 'micro'
    else if (arg === '-r') options.clock = 'relative'
    else if (arg === '-y') options.paths = true
    else if (arg === '-s' || arg.startsWith('-s')) {
      const text = arg.length > 2 ? arg.slice(2) : args[++i]
      if (!needs('s', text)) return 1
      if (!/^\d+$/.test(text)) { err(`invalid -s argument: '${text}'`); return 1 }
      options.strsize = Number(text)
    } else if (arg === '-o' || arg.startsWith('-o')) {
      outFile = arg.length > 2 ? arg.slice(2) : args[++i]
      if (!needs('o', outFile)) return 1
    } else if (arg === '-e' || arg.startsWith('-e')) {
      let text = arg.length > 2 ? arg.slice(2) : args[++i]
      if (!needs('e', text)) return 1
      text = text.replace(/^trace=/, '')
      const negate = text.startsWith('!')
      const names = text.replace(/^!/, '').split(',').filter(Boolean)
      if (names.length === 0) { err(`invalid -e argument: '${text}'`); return 1 }
      if (negate) options.exclude = [...(options.exclude ?? []), ...names]
      else options.include = [...(options.include ?? []), ...names]
    } else { err(`invalid option -- '${arg.replace(/^-+/, '')}'`); err("Try 'strace --help' for more information."); return 1 }
  }

  const command = args.slice(i)
  if (attach !== undefined && command.length > 0) { err('-p and a command cannot be used together'); return 1 }
  if (attach !== undefined) return follow(attach, options, outFile)
  if (command.length === 0) { writeAll(2, encoder.encode(usage + '\n')); return 1 }
  const program = findProgram(command[0])
  if (!program) { err(`Can't stat '${command[0]}': No such file or directory`); return 1 }

  let fd = 2
  if (outFile) {
    try { fd = open(outFile, 0o1101, 0o644) } catch (error) { err(`${outFile}: ${error?.message ?? error}`); return 1 }
  }
  let pid
  try {
    pid = await spawn(program, command, { cwd: getcwd(), env, trace: { fd, ...options } })
  } catch (error) {
    err(`${command[0]}: ${error?.message ?? error}`)
    return 1
  } finally {
    if (outFile && pid === undefined) close(fd)
  }
  const done = await waitFor(pid)
  if (outFile) close(fd)
  return statusOf(done)
}

try {
  exit(await main())
} catch (error) {
  err(error?.message ?? String(error))
  exit(1)
}
