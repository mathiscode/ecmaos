/**
 * Connects to a host and port and pipes data between the socket and the terminal or a pipe, like netcat. The
 * connection shows in `sockets list`. End of input flushes and closes (exit 0); `^C` kills the process and closes the
 * socket.
 */

import { openFlow } from '@ecmaos/peer'

import { readBackAndDelete, scratchPath } from './lib/scratch.mjs'
import { loginPeer, parseTarget } from './lib/peer-login.mjs'

const syscalls = globalThis.ecmaosSyscalls
const { argv, exit, read, writeAll, close, custom, poll, POLLIN, POLLHUP, POLLERR, env } = syscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(text + '\n'))

const usage = `Usage: nc [OPTIONS] <host> [port]
       nc [OPTIONS] -u <url>
       nc -g [USER@]GATEWAY[:PORT] [OPTIONS] <host> <port>

Netcat - network utility for reading from and writing to network connections.

Options:
  -u, --url <url>    Direct URL (ws://, wss://, or https://)
  -p, --port <port> Port number (for WebSocket, defaults to 80/443)
  -g, --gateway ADDR Reach host:port (plain TCP) through an ecmaOS machine started with
                     \`ecmaos --listen --gateway\`, logging in to it with your key
  --pair CODE        with -g: enrol your key with this one-time pairing code first
  -F, --fingerprint FP  with -g: accept the gateway only if its key has this fingerprint
  -y, --accept-new   with -g: remember a gateway seen for the first time without asking
  --help             display this help and exit

Examples:
  nc -g root@box:30022 example.com 80
  nc echo.websocket.org
  nc -p 443 echo.websocket.org
  nc -u wss://echo.websocket.org
  nc -u https://example.com:443`

function parseUrl(args) {
  let url
  let host
  let port
  let useUrlFlag = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined) continue

    if (arg === '-u' || arg === '--url') {
      useUrlFlag = true
      if (i + 1 < args.length) {
        i++
        url = args[i]
      } else {
        return null
      }
    } else if (arg === '-p' || arg === '--port') {
      if (i + 1 < args.length) {
        i++
        const portStr = args[i]
        if (portStr !== undefined) {
          port = parseInt(portStr, 10)
          if (isNaN(port)) return null
        }
      } else {
        return null
      }
    } else if (!arg.startsWith('-')) {
      if (!host) {
        host = arg
      } else if (!port) {
        port = parseInt(arg, 10)
        if (isNaN(port)) return null
      }
    }
  }

  if (useUrlFlag) {
    if (!url) return null
    const useWebSocket = url.startsWith('ws://') || url.startsWith('wss://')
    const useWebTransport = url.startsWith('https://') && 'WebTransport' in globalThis
    return { url, useWebSocket, useWebTransport }
  }

  if (!host) return null

  if (host.startsWith('http://') || host.startsWith('https://') || host.startsWith('ws://') || host.startsWith('wss://')) {
    const useWebSocket = host.startsWith('ws://') || host.startsWith('wss://')
    const useWebTransport = host.startsWith('https://') && 'WebTransport' in globalThis
    return { url: host, useWebSocket, useWebTransport }
  }

  if (port === undefined) port = 80

  const protocol = port === 443 ? 'wss' : 'ws'
  let constructedUrl
  if (port === 80 && protocol === 'ws') {
    constructedUrl = `${protocol}://${host}`
  } else if (port === 443 && protocol === 'wss') {
    constructedUrl = `${protocol}://${host}`
  } else {
    constructedUrl = `${protocol}://${host}:${port}`
  }
  return { url: constructedUrl, useWebSocket: true, useWebTransport: false }
}

/** Calls a scratch-file syscall and returns its parsed JSON. */
async function ask(name, prefix, ...args) {
  const path = scratchPath(prefix)
  await custom(name, ...args, path)
  return JSON.parse(await readBackAndDelete(syscalls, path))
}

/**
 * Copies bytes between the input and the socket until the peer closes. At end of input it closes `tx` (a socket has
 * no half-close) and keeps reading until the peer ends. Synchronous, since `poll` and `read` block the worker.
 */
function pump(rx, tx) {
  const buffer = new Uint8Array(65536)
  let inputOpen = true

  while (true) {
    const fds = [{ fd: rx, events: POLLIN }]
    if (inputOpen) fds.push({ fd: 0, events: POLLIN })
    const revents = poll(fds)

    if (revents[0] & (POLLIN | POLLHUP | POLLERR)) {
      const n = read(rx, buffer, -1)
      if (n <= 0) return
      writeAll(1, buffer.subarray(0, n))
    }

    if (inputOpen && revents[1] & (POLLIN | POLLHUP | POLLERR)) {
      const n = read(0, buffer, -1)
      if (n <= 0) {
        inputOpen = false
        close(tx)
        continue
      }
      writeAll(tx, buffer.subarray(0, n))
    }
  }
}

/**
 * Takes the gateway options out of `args` (what is left is the usual arguments), or returns undefined when there are
 * none
 */
function takeGateway(args) {
  const found = {}
  for (let i = 0; i < args.length;) {
    const arg = args[i]
    const value = flag => { const at = args.indexOf(arg); const next = args[at + 1]; args.splice(at, 2); return next ?? (found.error = `option ${flag} requires an argument`) }
    if (arg === '-g' || arg === '--gateway') found.address = value(arg)
    else if (arg === '--pair') found.pair = value(arg)
    else if (arg === '-F' || arg === '--fingerprint') found.fingerprint = value(arg)
    else if (arg === '-y' || arg === '--accept-new') { found.acceptNew = true; args.splice(i, 1) }
    else i++
  }
  if (!found.address && !found.error) {
    if (found.pair || found.fingerprint || found.acceptNew) found.error = '--pair, -F and -y only go with -g'
    else return undefined
  }
  const positional = args.filter(arg => !arg.startsWith('-'))
  if (!found.error && positional.length !== 2) found.error = 'with -g, give the host and the port to reach'
  if (!found.error) {
    const port = Number(positional[1])
    if (!Number.isInteger(port) || port < 1 || port > 65535) found.error = `bad port '${positional[1]}'`
    found.host = positional[0]
    found.port = port
  }
  return found
}

/** `nc -g`: a TCP flow to host:port, made by the gateway, with this program's input and output on the end of it */
async function throughGateway({ address, host, port, pair, fingerprint, acceptNew }) {
  const target = parseTarget(address, env['USER'] ?? 'root')
  if (!target) { err(`nc: cannot understand '${address}'`); return 1 }
  let connection
  try {
    connection = await loginPeer({ command: 'nc', target, user: target.user, pair, fingerprint, acceptNew })
  } catch (error) {
    err(`nc: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  try {
    let flow
    try { flow = await openFlow(connection, { proto: 'tcp', host, port }) } catch (error) {
      err(`nc: ${error?.message ?? error}`)
      return 1
    }
    const { channel } = flow
    let remoteEnded = false
    channel.onData = data => { try { writeAll(1, data) } catch { /* our own output went away */ } }
    channel.onMessage = message => { if (message && message.op === 'eof') remoteEnded = true }
    const buffer = new Uint8Array(65536)
    let inputOpen = true
    // Waiting in `poll` holds up this worker, so it waits a moment at a time: the socket's events need the turns in
    // between.
    // Like netcat, it ends when the far end does; end of input only tells the far end that nothing more is coming.
    while (!channel.closed && !remoteEnded) {
      if (inputOpen) {
        const revents = poll([{ fd: 0, events: POLLIN }], 20)
        if (revents[0] & (POLLIN | POLLHUP | POLLERR)) {
          const count = read(0, buffer, -1)
          if (count <= 0) { inputOpen = false; try { channel.send({ op: 'eof' }) } catch { /* it already ended */ } } else await channel.write(buffer.slice(0, count))
        }
      }
      await new Promise(resolve => setTimeout(resolve, inputOpen ? 0 : 20))
    }
    const failure = channel.closed ? channel.error : undefined
    channel.close()
    if (failure && failure.code !== 'closed') { err(`nc: ${failure.message}`); return 1 }
    return 0
  } finally {
    connection.close()
  }
}

async function main() {
  const args = argv.slice(1)

  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    err(usage)
    return 0
  }

  if (args.length === 0) {
    err('nc: missing host or URL argument')
    err('Try "nc --help" for more information.')
    return 1
  }

  const gateway = takeGateway(args)
  if (gateway?.error) { err(`nc: ${gateway.error}`); return 1 }
  if (gateway) return throughGateway(gateway)

  const options = parseUrl(args)
  if (!options) {
    err('nc: invalid arguments')
    err('Try "nc --help" for more information.')
    return 1
  }

  if (!options.useWebTransport && !options.useWebSocket) {
    err('nc: unsupported URL scheme. Use ws://, wss://, or https://')
    return 1
  }

  const type = options.useWebTransport ? 'webtransport' : 'websocket'
  const connected = await ask('sockets_connect', 'nc-connect', options.url, type, '')
  if (connected.error) {
    err(options.useWebTransport ? `WebTransport error: ${connected.error}` : `Failed to create WebSocket: ${connected.error}`)
    return 1
  }

  pump(connected.rx, connected.tx)
  close(connected.rx)

  if (options.useWebTransport) return 0

  const result = await ask('sockets_result', 'nc-result', connected.id)
  const { code, reason, opened, messages } = result
  if (code !== 1000 && code !== 1001 && code !== 1005 && code !== 1006 && reason) err(`Connection closed: ${reason}`)
  return code === 1000 || code === 1001 || code === 1005 || (code === 1006 && opened && messages > 0) ? 0 : 1
}

try {
  exit(await main())
} catch (error) {
  err(`nc: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
