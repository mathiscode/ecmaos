/**
 * `/sbin/getty`: the login prompt on one terminal, run by init as a `respawn` entry whose id names the
 * terminal (`tty1::respawn:/sbin/getty`). init gives it that terminal as its controlling terminal.
 *
 * It asks for a user name and a password, hands them to the kernel (`login_begin`, `login_session`,
 * which also try a passkey, since WebAuthn needs the page and not a worker), then runs the user's
 * shell on the terminal and waits for it. When the shell exits it ends the session and asks again.
 * It does not exit between logins, so init's respawn backoff never counts a logout as a crash.
 *
 * `^C` and `^\` at the prompt are ignored, as on Linux: they must not take the login down.
 */

const sys = globalThis.ecmaosSyscalls
const { read, write, writeAll, open, close, custom, spawn, waitpid, unlink, tcgetattr, tcsetattr, onSignal, argv, exit, isDirectory, stat, O_RDONLY } = sys

const SIGINT = 2
const SIGQUIT = 3
const SIGTSTP = 20
const ECHO = 0o10

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const out = text => writeAll(1, encoder.encode(text))

/** `getty tty2`, `getty 2` or `getty /dev/tty2`: the terminal number, 0 when none is given. */
function ttyNumber() {
  const match = /(\d+)$/.exec(argv[1] ?? '')
  return match ? Number(match[1]) : 0
}

function readFile(path) {
  try {
    const fd = open(path, O_RDONLY, 0)
    try {
      const chunks = []
      const buffer = new Uint8Array(65536)
      for (;;) {
        const n = read(fd, buffer, -1)
        if (n <= 0) break
        chunks.push(decoder.decode(buffer.subarray(0, n), { stream: true }))
      }
      return chunks.join('')
    } finally {
      close(fd)
    }
  } catch {
    return undefined
  }
}

/** A `read` that a signal cut short: the line being typed is dropped and the prompt comes back. */
const isInterrupt = error => `${error?.code} ${error?.message ?? error}`.includes('EINTR')

/** One line from the terminal, without its newline. Null at end of input. */
function readLine() {
  const bytes = []
  const buffer = new Uint8Array(1)
  for (;;) {
    const n = read(0, buffer, -1)
    if (n <= 0) return bytes.length ? decoder.decode(new Uint8Array(bytes)) : null
    if (buffer[0] === 10) return decoder.decode(new Uint8Array(bytes))
    bytes.push(buffer[0])
  }
}

/** Echo goes off before the prompt is shown, so nothing typed the moment it appears can be echoed. */
function readSilent(prompt) {
  const lflag = tcgetattr(0).lflag
  tcsetattr(0, { lflag: lflag & ~ECHO })
  try {
    out(prompt)
    return readLine()
  } finally {
    tcsetattr(0, { lflag })
    out('\n')
  }
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
    out(`getty: cannot run ${shell}: ${error?.message ?? error}\n`)
  }
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

    let password = ''
    const settled = await custom('login_begin', tty, username.trim()) === 1
    if (!settled) {
      try {
        password = readSilent('Password: ') ?? ''
      } catch (error) {
        if (isInterrupt(error)) { out('\n'); continue }
        throw error
      }
    }

    const session = await loginSession(tty, username.trim(), password)
    if (!session.ok) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      out(`${session.message || 'Login incorrect'}\n`)
      continue
    }

    const motd = readFile('/etc/motd')
    if (motd) out(`\n${motd}\n`)

    try {
      await runShell(tty, session)
    } finally {
      await custom('login_end', tty)
    }
  }
}

try {
  await main()
} catch (error) {
  write(2, encoder.encode(`getty: ${error?.message ?? error}\n`))
  exit(1)
}
