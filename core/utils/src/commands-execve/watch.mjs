/**
 * Run a command again and again, clearing the screen between runs: `watch -n 2 ps`.
 *
 * With one word the command is a program; with more than one it is run through a shell (`watch 'ls | wc -l'`
 * is one word, so it also goes through a shell). It stops on `^C`, and with `-e` when the command fails,
 * with `-g` when its output changes.
 */

import { findProgram, openDevNull, readAll, run, waitFor } from './lib/run.mjs'

const sys = globalThis.ecmaosSyscalls
const { argv, exit, writeAll, pipe, close, spawn, getcwd, env, read } = sys

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`watch: ${text}\n`))

const usage = `Usage: watch [OPTION]... COMMAND
Run COMMAND repeatedly, showing its output full-screen.

  -n, --interval=SECONDS  seconds to wait between runs (default 2)
  -t, --no-title          leave out the header
  -e, --errexit           stop, with the command's status, when it fails
  -g, --chgexit           stop when the output changes
  --help                  display this help and exit`

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

async function main() {
  const args = argv.slice(1)
  let interval = 2000
  let title = true
  let errexit = false
  let chgexit = false
  let i = 0
  for (; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (arg === '--') { i++; break }
    if (!arg.startsWith('-') || arg === '-') break
    let m
    if ((m = /^--interval(?:=(.*))?$/.exec(arg)) || arg === '-n' || /^-n./.test(arg)) {
      const text = m ? (m[1] ?? args[++i]) : (arg.length > 2 ? arg.slice(2) : args[++i])
      const seconds = Number(text)
      if (!(seconds >= 0) || text === undefined) { err(`failed to parse argument: '${text}'`); return 1 }
      interval = Math.max(0.1, seconds) * 1000
    } else if (arg === '-t' || arg === '--no-title') title = false
    else if (arg === '-e' || arg === '--errexit') errexit = true
    else if (arg === '-g' || arg === '--chgexit') chgexit = true
    else { err(`invalid option -- '${arg.replace(/^-+/, '')}'`); return 1 }
  }
  const words = args.slice(i)
  if (words.length === 0) { err('no command'); return 1 }

  const shell = findProgram('ecmash')
  const [program, programArgv] = words.length === 1 && !/[\s|&;<>$`'"*?(){}\[\]~]/.test(words[0]) && findProgram(words[0])
    ? [findProgram(words[0]), words]
    : [shell, ['ecmash', '-c', words.join(' ')]]
  if (!program) { err(`${words[0]}: command not found`); return 127 }

  const stdin = openDevNull()
  let previous
  for (;;) {
    // the command's output comes through a pipe so a run that changed it can be told from one that did not
    const [reader, writer] = pipe()
    const pid = await spawn(program, programArgv, { cwd: getcwd(), env, fds: { 0: stdin, 1: writer, 2: writer } })
    close(writer)
    const output = readAll(reader)
    close(reader)
    const done = await waitFor(pid)
    const text = new TextDecoder().decode(output)
    if (title) {
      const header = `Every ${(interval / 1000).toFixed(1)}s: ${words.join(' ')}`
      writeAll(1, encoder.encode(`\x1b[H\x1b[2J${header}    ${new Date().toString().slice(0, 24)}\n\n`))
    } else writeAll(1, encoder.encode('\x1b[H\x1b[2J'))
    writeAll(1, output)
    const status = done.signal ? 128 + done.signal : done.code
    if (done.signal === 2) return 130
    if (errexit && status !== 0) return status
    if (chgexit && previous !== undefined && previous !== text) return 0
    previous = text
    await pause(interval)
  }
}

try {
  exit(await main())
} catch (error) {
  err(error?.message ?? String(error))
  exit(1)
}
