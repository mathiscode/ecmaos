/**
 * Log in to another ecmaOS machine (`ecmaos --listen`) and get a shell on it, like `ssh`.
 *
 * You prove who you are with your own key (`~/.ssh/id_ecdsa`, made the first time it is needed and unlocked by your
 * login password), and the machine proves who it is with its host key, which is remembered in `~/.ssh/known_hosts` the first time
 * you connect and must not change after that. The first time a key is used with a machine, `--pair CODE` enrols it
 * with the one-time code the machine prints.
 */
import { isTty, terminalSize } from '../../../../utils/src/commands-execve/lib/tty.mjs'
import { getopt } from './lib/getopt.mjs'
import { loginPeer, parseTarget } from './lib/peer-login.mjs'

const syscalls = globalThis.ecmaosSyscalls
const { argv, exit, read, write, writeAll, poll, POLLIN, POLLHUP, POLLERR, onSignal, tcgetattr, tcsetattr, env } = syscalls

const SIGWINCH = 28
const ICANON = 0o2
const ECHO = 0o10
const ISIG = 0o1

const encoder = new TextEncoder()
const say = (fd, text) => write(fd, encoder.encode(text))
const err = text => say(2, text + '\n')

const usage = `Usage: connect [OPTIONS] [USER@]HOST[:PORT]
       connect [OPTIONS] ws://HOST:PORT[/ecmaos]

Log in to an ecmaOS machine started with \`ecmaos --listen\` and get a shell on it.

Options:
  -l, --login USER        the user to log in as (default: you)
  -p, --pair CODE         enrol your key with this one-time pairing code, then log in
  -F, --fingerprint FP    accept the host only if its key has this fingerprint (SHA256:...)
  -y, --accept-new        remember a host seen for the first time without asking
  --help                  display this help and exit

The host's key is remembered in ~/.ssh/known_hosts and a different key later is refused.`

// - terminal ---------------------------------------------------------------------------------------

/** Everything the remote terminal needs from the keys: no line editing, echo or signals here, they all happen on the other side */
function rawTerminal() {
  if (!isTty(0)) return () => {}
  const saved = tcgetattr(0)
  tcsetattr(0, { lflag: saved.lflag & ~(ICANON | ECHO | ISIG) })
  return () => tcsetattr(0, { lflag: saved.lflag })
}

// - the connection ---------------------------------------------------------------------------------

async function main() {
  const parsed = getopt(argv.slice(1), { flags: 'y', values: 'lpF', long: { login: 'l', pair: 'p', fingerprint: 'F', 'accept-new': 'y' } })
  if (parsed.error) { err(`connect: ${parsed.error}`); return 255 }
  const { opts, rest } = parsed
  if (opts.help) { err(usage); return 0 }
  if (rest.length !== 1) { err(usage); return 255 }

  const target = parseTarget(rest[0], opts.l ?? env['USER'] ?? 'root')
  if (!target) { err(`connect: cannot understand '${rest[0]}'`); return 255 }
  const user = opts.l ?? target.user

  let connection
  try {
    connection = await loginPeer({ command: 'connect', target, user, pair: opts.p, fingerprint: opts.F, acceptNew: !!opts.y })
  } catch (error) {
    err(`connect: ${error instanceof Error ? error.message : String(error)}`)
    return 255
  }

  try {
    const { rows, cols } = terminalSize(0)
    const channel = await connection.open('tty', { params: { cols, rows }, timeout: 20_000 })
    return await shell(channel)
  } catch (error) {
    err(`connect: ${error instanceof Error ? error.message : String(error)}`)
    return 255
  } finally {
    connection.close()
  }
}

/** Runs the terminal session: keys go out, output comes back, until either side ends it */
async function shell(channel) {
  const restore = rawTerminal()
  channel.onData = data => { try { writeAll(1, data) } catch { /* our own terminal went away */ } }
  onSignal(SIGWINCH, () => {
    const { rows, cols } = terminalSize(0)
    try { channel.send({ op: 'resize', cols, rows }) } catch { /* the session already ended */ }
  })
  const buffer = new Uint8Array(65536)
  try {
    while (!channel.closed) {
      // Waiting in `poll` holds up this worker, so it waits a moment at a time: the socket's events need the turns in between
      const revents = poll([{ fd: 0, events: POLLIN }], 20)
      if (revents[0] & (POLLIN | POLLHUP | POLLERR)) {
        const count = read(0, buffer, -1)
        if (count <= 0) { channel.close(); break }
        await channel.write(buffer.slice(0, count))
      }
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  } finally {
    restore()
  }
  const error = await channel.done
  if (error && error.code !== 'closed') { err(`\nconnect: ${error.message}`); return 255 }
  say(2, '\nConnection closed.\n')
  return 0
}

try {
  exit(await main())
} catch (error) {
  err(`connect: ${error instanceof Error ? error.message : String(error)}`)
  exit(255)
}
