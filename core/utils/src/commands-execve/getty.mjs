/**
 * `/sbin/getty`: the login prompt on one terminal, run by init as a `respawn` entry whose id names the terminal
 * (`tty1::respawn:/sbin/getty tty1`). Prints `/etc/issue`, asks for a user name, runs `/bin/login` with it and waits;
 * when `login` returns, asks again. It does not exit between logins, so init's backoff never counts a logout as a
 * crash. `^C` and `^\` at the prompt are ignored.
 */

import { makeLoginIO } from './lib/login-io.mjs'

const sys = globalThis.ecmaosSyscalls
const { write, custom, spawn, waitpid, onSignal, argv, exit } = sys
const { out, readFile, readLine, isInterrupt } = makeLoginIO(sys)

const SIGINT = 2
const SIGQUIT = 3
const SIGTSTP = 20

const encoder = new TextEncoder()

/** `getty -p` (or `pts/N`): a login prompt on the terminal the program already has, a pty, not on a numbered one. */
const onPty = argv.slice(1).some(arg => arg === '-p' || /(^|\/)pts\/\d+$/.test(arg))

/** `getty tty2`, `getty 2` or `getty /dev/tty2`: the terminal number, 0 when none is given. */
function ttyNumber() {
  const match = /(\d+)$/.exec(argv[1] ?? '')
  return match ? Number(match[1]) : 0
}

async function main() {
  const tty = ttyNumber()
  for (const signal of [SIGINT, SIGQUIT, SIGTSTP]) onSignal(signal, () => {})
  await custom('system_ready')

  for (;;) {
    const issue = readFile('/etc/issue')
    out(`\n${new Date().toLocaleString()}\n`)
    if (issue) out(issue.endsWith('\n') ? issue : issue + '\n')
    const hostname = (readFile('/etc/hostname') ?? 'localhost').trim()

    out(`${hostname} login: `)
    let username
    try {
      username = readLine()
    } catch (error) {
      if (isInterrupt(error)) { out('\n'); continue }
      throw error
    }
    if (username === null) { await new Promise(resolve => setTimeout(resolve, 1000)); continue }
    if (!username.trim()) continue

    try {
      // on a pty the login inherits it; a numbered terminal is named
      const pid = onPty
        ? await spawn('/bin/login', ['login', '-p', username.trim()], { cwd: '/' })
        : await spawn('/bin/login', ['login', '-t', String(tty), username.trim()], { cwd: '/', tty })
      await waitpid(pid, false)
    } catch (error) {
      out(`getty: cannot run /bin/login: ${error?.message ?? error}\n`)
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }
}

try {
  await main()
} catch (error) {
  write(2, encoder.encode(`getty: ${error?.message ?? error}\n`))
  exit(1)
}
