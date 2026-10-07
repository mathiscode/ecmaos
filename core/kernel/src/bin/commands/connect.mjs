/**
 * Log in to another ecmaOS machine (`ecmaos --listen`) and get a shell on it, like `ssh`.
 *
 * You prove who you are with your own key (`~/.ssh/id_ecdsa`, made the first time it is needed and unlocked by your
 * login password), and the machine proves who it is with its host key, which is remembered in `~/.ssh/known_hosts` the first time
 * you connect and must not change after that. The first time a key is used with a machine, `--pair CODE` enrols it
 * with the one-time code the machine prints.
 */
import { AuthChannel, clientAuth, Connection, publicKeyOf, webSocketTransport } from '@ecmaos/peer'

import { echoOff, isTty, terminalSize } from '../../../../utils/src/commands-execve/lib/tty.mjs'
import { readFileBytes, writeFileBytes } from '../../../../utils/src/commands-execve/lib/bytes.mjs'
import { getopt } from './lib/getopt.mjs'
import { readBackAndDelete, scratchPath } from './lib/scratch.mjs'

const syscalls = globalThis.ecmaosSyscalls
const { argv, exit, read, write, writeAll, custom, poll, POLLIN, POLLHUP, POLLERR, mkdir, onSignal, tcgetattr, tcsetattr, env } = syscalls

const DefaultPort = 30022
const SIGWINCH = 28
const ICANON = 0o2
const ECHO = 0o10
const ISIG = 0o1

const encoder = new TextEncoder()
const decoder = new TextDecoder()
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

function parseTarget(text, defaultUser) {
  if (/^wss?:\/\//.test(text)) {
    const url = new URL(text)
    const port = url.port || (url.protocol === 'wss:' ? '443' : '80')
    return { url: url.pathname === '/' ? `${url.origin}/ecmaos` : url.href, id: `${url.hostname}:${port}`, user: url.username || defaultUser, label: `${url.hostname}:${port}` }
  }
  const at = text.lastIndexOf('@')
  const user = at === -1 ? defaultUser : text.slice(0, at)
  const rest = at === -1 ? text : text.slice(at + 1)
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(rest)
  if (!match) return null
  const host = match[1]
  const port = match[2] ?? String(DefaultPort)
  return { url: `ws://${host}:${port}/ecmaos`, id: `${host}:${port}`, user, label: `${host}:${port}` }
}

// -- known hosts ------------------------------------------------------------------------------------

const home = () => env['HOME'] || '/root'
const sshDirectory = () => `${home()}/.ssh`
const knownHostsFile = () => `${sshDirectory()}/known_hosts`

function readKnownHosts() {
  try { return decoder.decode(readFileBytes(knownHostsFile())) } catch { return '' }
}

function knownKey(id) {
  for (const line of readKnownHosts().split('\n')) {
    const [host, algorithm, body] = line.trim().split(/\s+/)
    if (host !== id || algorithm !== 'ecdsa-p384' || !body) continue
    try { return publicKeyOf(JSON.parse(atob(body))) } catch { /* a line this cannot read is not a known host */ }
  }
  return null
}

function rememberHost(id, key) {
  try { mkdir(sshDirectory(), 0o700) } catch { /* already there */ }
  const existing = readKnownHosts()
  const line = `${id} ecdsa-p384 ${btoa(JSON.stringify({ kty: key.kty, crv: key.crv, x: key.x, y: key.y }))}\n`
  writeFileBytes(knownHostsFile(), encoder.encode((existing && !existing.endsWith('\n') ? existing + '\n' : existing) + line), 0o644)
}

// -- terminal ---------------------------------------------------------------------------------------

/** Prints `prompt` and reads one line from stdin, with echo off when `secret` and stdin is a terminal. */
function readLine(prompt, secret) {
  say(2, `\x1b[36m${prompt}\x1b[0m`)
  const restore = secret ? echoOff(0) : () => {}
  const bytes = []
  try {
    const buffer = new Uint8Array(256)
    while (true) {
      const n = read(0, buffer, -1)
      if (n <= 0) break
      bytes.push(...buffer.subarray(0, n))
      if (buffer[n - 1] === 10) break
    }
  } finally {
    restore()
  }
  if (secret && isTty(0)) say(2, '\n')
  return decoder.decode(new Uint8Array(bytes)).replace(/[\r\n]+$/, '')
}

/** Everything the remote terminal needs from the keys: no line editing, echo or signals here, they all happen on the other side */
function rawTerminal() {
  if (!isTty(0)) return () => {}
  const saved = tcgetattr(0)
  tcsetattr(0, { lflag: saved.lflag & ~(ICANON | ECHO | ISIG) })
  return () => tcsetattr(0, { lflag: saved.lflag })
}

// -- the connection ---------------------------------------------------------------------------------

async function ask(name, prefix, ...args) {
  const path = scratchPath(prefix)
  await custom(name, ...args, path)
  return JSON.parse(await readBackAndDelete(syscalls, path))
}

const toBase64 = bytes => { let text = ''; for (const byte of bytes) text += String.fromCharCode(byte); return btoa(text) }

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    // Wrapped now, before it opens, so nothing the host sends first is missed
    const transport = webSocketTransport(socket)
    socket.addEventListener('open', () => resolve(transport), { once: true })
    socket.addEventListener('error', () => reject(new Error(`could not connect to ${url}`)), { once: true })
  })
}

async function main() {
  const parsed = getopt(argv.slice(1), { flags: 'y', values: 'lpF', long: { login: 'l', pair: 'p', fingerprint: 'F', 'accept-new': 'y' } })
  if (parsed.error) { err(`connect: ${parsed.error}`); return 255 }
  const { opts, rest } = parsed
  if (opts.help) { err(usage); return 0 }
  if (rest.length !== 1) { err(usage); return 255 }

  const target = parseTarget(rest[0], opts.l ?? env['USER'] ?? 'root')
  if (!target) { err(`connect: cannot understand '${rest[0]}'`); return 255 }
  const user = opts.l ?? target.user

  let transport
  try { transport = await openSocket(target.url) } catch (error) { err(`connect: ${error.message}`); return 255 }
  const connection = new Connection(transport, { role: 'client', meta: { name: 'ecmaos-connect' } })

  try {
    await connection.ready
    const authentication = await connection.open(AuthChannel)
    await clientAuth(authentication, {
      user,
      pairingCode: opts.p,
      trust: async (key, fingerprint) => {
        const known = knownKey(target.id)
        if (known) {
          if (known.x === key.x && known.y === key.y) return true
          err(`@@@ WARNING: THE HOST KEY FOR ${target.id} HAS CHANGED @@@\nSomething may be impersonating it, or the machine was reinstalled.\nIts key is now ${fingerprint}; the one remembered in ${knownHostsFile()} is different.\nNothing was sent. Remove the old line from that file if you trust the change.`)
          return false
        }
        if (opts.F) {
          if (opts.F !== fingerprint) { err(`connect: the host key is ${fingerprint}, not ${opts.F}`); return false }
        } else if (!opts.y) {
          if (!isTty(0)) { err(`connect: ${target.id} is not a known host (its key is ${fingerprint}); check it, then use --fingerprint or --accept-new`); return false }
          const answer = readLine(`The authenticity of ${target.id} cannot be established.\nIts key fingerprint is ${fingerprint}.\nTrust it and continue connecting (yes/no)? `, false)
          if (answer !== 'yes') { err('connect: host key not trusted'); return false }
        }
        rememberHost(target.id, key)
        err(`Added ${target.id} (${fingerprint}) to ${knownHostsFile()}.`)
        return true
      },
      sign: async data => {
        const password = readLine(`Password for ${env['USER'] ?? 'you'} (unlocks your key): `, true)
        const result = await ask('users_sign', 'connect-sign', password, toBase64(data))
        if (result.error) throw new Error(result.error)
        const key = publicKeyOf(result.publicKey)
        if (!key) throw new Error('your key is not a P-384 key')
        return { key, signature: Uint8Array.from(atob(result.signature), ch => ch.charCodeAt(0)) }
      }
    })

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
