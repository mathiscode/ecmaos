/**
 * Logging in to another ecmaOS machine (`ecmaos --listen`) from a program: the host is checked against
 * `~/.ssh/known_hosts` (and remembered the first time, if allowed), and you prove who you are with your own key, which
 * your login password unlocks. Shared by `connect` (a shell on it) and `nc -g` (the network through it).
 */
import { AuthChannel, clientAuth, Connection, publicKeyOf, webSocketTransport } from '@ecmaos/peer'

import { isTty, echoOff } from '../../../../../utils/src/commands-execve/lib/tty.mjs'
import { readFileBytes, writeFileBytes } from '../../../../../utils/src/commands-execve/lib/bytes.mjs'
import { readBackAndDelete, scratchPath } from './scratch.mjs'

const syscalls = globalThis.ecmaosSyscalls
const { read, write, custom, mkdir, env } = syscalls

export const DefaultPort = 30022

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const say = (fd, text) => write(fd, encoder.encode(text))
const err = text => say(2, text + '\n')

/** `[user@]host[:port]` or `ws(s)://host:port[/ecmaos]`: where to connect, as what, and the name the host is remembered by */
export function parseTarget(text, defaultUser) {
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

// - known hosts ------------------------------------------------------------------------------------

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

/** Prints `prompt` and reads one line from stdin, with echo off when `secret` and stdin is a terminal. */
export function readLine(prompt, secret) {
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

/**
 * Connects and logs in. `command` names the program for its messages. Resolves to the connection, ready for channels; throws
 * with a message ready to show.
 */
export async function loginPeer({ command, target, user, pair, fingerprint, acceptNew }) {
  const transport = await openSocket(target.url)
  const connection = new Connection(transport, { role: 'client', meta: { name: `ecmaos-${command}` } })
  try {
    await connection.ready
    const authentication = await connection.open(AuthChannel)
    await clientAuth(authentication, {
      user,
      pairingCode: pair,
      trust: async (key, printed) => {
        const known = knownKey(target.id)
        if (known) {
          if (known.x === key.x && known.y === key.y) return true
          err(`@@@ WARNING: THE HOST KEY FOR ${target.id} HAS CHANGED @@@\nSomething may be impersonating it, or the machine was reinstalled.\nIts key is now ${printed}; the one remembered in ${knownHostsFile()} is different.\nNothing was sent. Remove the old line from that file if you trust the change.`)
          return false
        }
        if (fingerprint) {
          if (fingerprint !== printed) { err(`${command}: the host key is ${printed}, not ${fingerprint}`); return false }
        } else if (!acceptNew) {
          if (!isTty(0)) { err(`${command}: ${target.id} is not a known host (its key is ${printed}); check it, then use --fingerprint or --accept-new`); return false }
          const answer = readLine(`The authenticity of ${target.id} cannot be established.\nIts key fingerprint is ${printed}.\nTrust it and continue connecting (yes/no)? `, false)
          if (answer !== 'yes') { err(`${command}: host key not trusted`); return false }
        }
        rememberHost(target.id, key)
        err(`Added ${target.id} (${printed}) to ${knownHostsFile()}.`)
        return true
      },
      sign: async data => {
        const password = readLine(`Password for ${env['USER'] ?? 'you'} (unlocks your key): `, true)
        const result = await ask('users_sign', `${command}-sign`, password, toBase64(data))
        if (result.error) throw new Error(result.error)
        const key = publicKeyOf(result.publicKey)
        if (!key) throw new Error('your key is not a P-384 key')
        return { key, signature: Uint8Array.from(atob(result.signature), ch => ch.charCodeAt(0)) }
      }
    })
    return connection
  } catch (error) {
    connection.close()
    throw error
  }
}
