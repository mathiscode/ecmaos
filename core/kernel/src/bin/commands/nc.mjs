/**
 * Real `execve`'d `nc` -- migrated off `Kernel`'s legacy in-process shim (`core/utils/src/commands/
 * nc.ts`). Like `sockets`, it lives in the kernel because a connection is a live main-thread object
 * (`kernel.sockets`); unlike `sockets` it needs a *data* path, not just a control one. `sockets_connect`
 * (`#lib/main-thread-syscalls.ts`) connects and installs the socket in this process as two real file
 * descriptors -- `rx`, which yields what the peer sends, and `tx`, which sends what is written --
 * so `nc` is what a real netcat is: `poll` the terminal (or a pipe) and the socket together and copy
 * bytes between them, no event loop and no kernel handle needed.
 *
 * Semantics kept from the original: the connection is a `kernel.sockets` entry (so `sockets list`
 * sees it), end of input closes it (after flushing what was written), and the exit status is 0 for a
 * normal close. `^C` is now the
 * line discipline's `SIGINT` killing the process, which closes the socket with it.
 */

import { readBackAndDelete, scratchPath } from './lib/scratch.mjs'

const syscalls = globalThis.ecmaosSyscalls
const { argv, exit, read, writeAll, close, custom, poll, POLLIN, POLLHUP, POLLERR } = syscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(text + '\n'))

const usage = `Usage: nc [OPTIONS] <host> [port]
       nc [OPTIONS] -u <url>

Netcat - network utility for reading from and writing to network connections.

Options:
  -u, --url <url>    Direct URL (ws://, wss://, or https://)
  -p, --port <port> Port number (for WebSocket, defaults to 80/443)
  --help             display this help and exit

Examples:
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
 * Copies bytes between the input (terminal or pipe) and the socket until the peer closes. At end of
 * input it closes `tx`, which flushes what was written and then ends the connection (a socket has no
 * half-close, so that is a normal close), and keeps reading until the peer's side ends. Synchronous
 * on purpose: `poll` and `read` block this worker in the kernel, so nothing here may wait on an
 * async syscall.
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
