/**
 * `/bin/login -t N USER`: the second half of a login, run by `getty`. Asks for the password (unless a passkey settled
 * it), hands both to the kernel (`login_begin`, `login_session`, which also try a passkey since WebAuthn needs the
 * page), prints `/etc/motd`, runs the user's shell on the terminal and ends the session when it returns. Exit status
 * 0 after a session, 1 for a refused login. `^C` and `^\` at the password prompt are ignored.
 */

import { makeLoginIO } from './lib/login-io.mjs'

const sys = globalThis.ecmaosSyscalls
const { write, custom, spawn, waitpid, unlink, onSignal, argv, exit, isDirectory, stat } = sys
const { out, readFile, readSilent, isInterrupt } = makeLoginIO(sys)

const SIGINT = 2
const SIGQUIT = 3
const SIGTSTP = 20

const encoder = new TextEncoder()
const fail = (message, code = 1) => {
  write(2, encoder.encode(`login: ${message}\n`))
  exit(code)
}

/** `-t N USER`: the terminal to log in on and the user name; `-p USER`: the pty this program already runs on (terminal -1). */
function parseArgs(args) {
  let tty
  const rest = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-t') tty = Number(args[++i])
    else if (args[i] === '-p') tty = -1
    else rest.push(args[i])
  }
  return { tty, username: rest[0] }
}

/** The kernel answers a `login_session` through a scratch file, as its other string-returning calls do. */
async function loginSession(tty, username, password) {
  const path = `/tmp/.login-${Math.random().toString(36).slice(2)}`
  await custom('login_session', tty, username, password, path)
  try {
    return JSON.parse(readFile(path) ?? '{"ok":false,"message":"login failed"}')
  } finally {
    try { unlink(path) } catch { /* best effort */ }
  }
}

async function runShell(tty, session) {
  // a pty has no built-in shell to fall back on, so a user whose shell is not a program gets ecmash
  const shell = tty < 0 && !session.shell.startsWith('/') ? '/bin/ecmash' : session.shell
  const isProgram = shell.startsWith('/') && (() => { try { return !isDirectory(shell) && stat(shell) !== undefined } catch { return false } })()
  if (!isProgram) {
    // The kernel's built-in shell has no file; the kernel runs it on this terminal until it exits.
    await custom('login_builtin', tty)
    return
  }
  const name = shell.slice(shell.lastIndexOf('/') + 1)
  try {
    // as the user who logged in: login itself is a root process, the shell it starts is not
    const credentials = { uid: session.uid, gid: session.gid, groups: session.groups }
    // on a pty the shell inherits the terminal; a numbered one is named
    const pid = await spawn(shell, [`-${name}`], { cwd: session.home, env: session.env, credentials, ...(tty >= 0 && { tty }) })
    await waitpid(pid, false)
  } catch (error) {
    out(`login: cannot run ${shell}: ${error?.message ?? error}\n`)
  }
}

async function main() {
  const { tty, username } = parseArgs(argv.slice(1))
  if (!username || tty === undefined || !Number.isInteger(tty)) {
    write(2, encoder.encode('usage: login -t TTY USER | login -p USER\n'))
    return 2
  }
  for (const signal of [SIGINT, SIGQUIT, SIGTSTP]) onSignal(signal, () => {})

  let password = ''
  const settled = tty >= 0 && await custom('login_begin', tty, username) === 1
  if (!settled) {
    try {
      password = readSilent('Password: ') ?? ''
    } catch (error) {
      if (isInterrupt(error)) { out('\n'); return 1 }
      throw error
    }
  }

  const session = await loginSession(tty, username, password)
  if (!session.ok) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    out(`${session.message || 'Login incorrect'}\n`)
    return 1
  }

  const motd = readFile('/etc/motd')
  if (motd) out(`\n${motd}\n`)

  try {
    await runShell(tty, session)
  } finally {
    if (tty >= 0) await custom('login_end', tty)
  }
  return 0
}

let status
try {
  status = await main()
} catch (error) {
  fail(error?.message ?? String(error))
}
exit(status)
