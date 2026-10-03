/**
 * `/bin/login -t N USER`: the second half of a login, run by `getty` once it has a user name. It asks for
 * the password (unless a passkey already settled it), hands both to the kernel (`login_begin`,
 * `login_session`, which also try a passkey, since WebAuthn needs the page and not a worker), prints
 * `/etc/motd`, runs the user's shell on the terminal and waits for it, then ends the session.
 *
 * Exit status: 0 after a session that ended normally, 1 for a refused login (the reason is printed).
 * `^C` and `^\` at the password prompt are ignored, as in getty.
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

/** `-t N USER`: the terminal to log in on and the user name. */
function parseArgs(args) {
  let tty
  const rest = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-t') tty = Number(args[++i])
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
  const shell = session.shell
  const isProgram = shell.startsWith('/') && (() => { try { return !isDirectory(shell) && stat(shell) !== undefined } catch { return false } })()
  if (!isProgram) {
    // The kernel's built-in shell has no file; the kernel runs it on this terminal until it exits.
    await custom('login_builtin', tty)
    return
  }
  const name = shell.slice(shell.lastIndexOf('/') + 1)
  try {
    const pid = await spawn(shell, [`-${name}`], { cwd: session.home, env: session.env, tty })
    await waitpid(pid, false)
  } catch (error) {
    out(`login: cannot run ${shell}: ${error?.message ?? error}\n`)
  }
}

async function main() {
  const { tty, username } = parseArgs(argv.slice(1))
  if (!username || tty === undefined || !Number.isInteger(tty)) {
    write(2, encoder.encode('usage: login -t TTY USER\n'))
    return 2
  }
  for (const signal of [SIGINT, SIGQUIT, SIGTSTP]) onSignal(signal, () => {})

  let password = ''
  const settled = await custom('login_begin', tty, username) === 1
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
    await custom('login_end', tty)
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
