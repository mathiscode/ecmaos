import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'

import { AuthChannel, Connection, DeviceChannel, fingerprint, FsChannel, FsClient, FsShareChannel, MessageStream, PeerError, publicKeyOf, serveDevice, serveFs, serverAuth, webSocketTransport } from '@ecmaos/peer'
import type { Channel, DeviceSource, ExportFs, KeyPair, PublicKey, WebSocketLike } from '@ecmaos/peer'
import type { Kernel } from '@ecmaos/kernel/kernel'
import { RemoteFS } from '@ecmaos/kernel/lib/remote-fs'
import { DefaultLimits } from '@ecmaos/kernel/lib/remote-mount'

import { TerminalDriver } from './driver.ts'
import { loadHostKey } from './hostkey.ts'
import { createPairing } from './pairing.ts'
import type { Pairing } from './pairing.ts'

export const DefaultPort = 30022
export const Endpoint = '/ecmaos'

/** Pages allowed to open a connection from a browser. A connection that sends no Origin is not a browser and passes this check. */
export const DefaultOrigins = ['https://ecmaos.sh', 'http://localhost:*', 'http://127.0.0.1:*']

const MaxConnections = 16
const MaxUnauthenticated = 4
const AuthFailuresPerConnection = 3
const FailureDelay = 1000
const GlobalFailureWindow = 60_000
const GlobalFailureLimit = 10
/** A client this far behind on output is cut off rather than buffered for */
const MaxQueuedOutput = 8 << 20

export interface DaemonOptions {
  kernel: Kernel
  /** The data folder (for the host key); none for an ephemeral machine */
  dataDir?: string
  /** Defaults to 127.0.0.1. Only loopback addresses are accepted: nothing here is encrypted yet. */
  host?: string
  port?: number
  origins?: string[]
  /** Who a pairing code enrols; none for no code. Defaults to root. */
  pairUser?: string | false
  /** What a directory shared by a machine that logs in may hold before it is refused (it is copied to memory) */
  shareLimits?: { files: number, bytes: number }
  /** Host directories offered to the machines that log in, by name */
  exports?: Array<{ name: string, readOnly: boolean, backend: ExportFs }>
  /** Host devices offered to root on the machines that log in, by name; none unless listed */
  devices?: DeviceSource[]
  /** Makes what the kernel has written durable; called before a key enrolment is acknowledged */
  flush?: () => void
  log?: (message: string) => void
}

export interface Daemon {
  readonly port: number
  readonly host: string
  readonly fingerprint: string
  readonly hostKey: KeyPair
  /** The code printed for pairing, if any */
  readonly pairing?: Pairing
  /** Connections that have logged in */
  readonly sessions: number
  close(): Promise<void>
}

const Loopback = new Set(['127.0.0.1', '::1', 'localhost'])

/** `https://*.example.com` and `http://localhost:*` become patterns; anything else must match exactly */
function originMatcher(patterns: string[]) {
  const regexes = patterns.map(pattern => new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$'))
  return (origin: string) => regexes.some(regex => regex.test(origin))
}

function hostAllowed(header: string | undefined, port: number) {
  if (!header) return false
  // Only the names the daemon is reachable by: a page on another name pointing at 127.0.0.1 (DNS rebinding) is refused
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(header.toLowerCase())
}

/**
 * `ecmaosd`: lets a peer log in to this machine over a WebSocket, with the key it holds, and get a shell on a terminal of its own.
 *
 * Only a loopback address can be bound. The checks, in order: the request path, the `Host` header (DNS rebinding), the
 * `Origin` (a page that is not on the allow-list), the number of connections, then the login itself: a signature by an
 * authorized key (or a one-time pairing code and a new key), with refusals slowed and counted.
 */
export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const host = options.host ?? '127.0.0.1'
  if (!Loopback.has(host)) throw new Error(`ecmaosd only listens on a loopback address for now (not ${host}): nothing it sends is encrypted`)
  const log = options.log ?? (() => {})
  const kernel = options.kernel
  const hostKey = await loadHostKey(options.dataDir)
  const hostFingerprint = await fingerprint(hostKey.publicKey)
  const originAllowed = originMatcher(options.origins ?? DefaultOrigins)
  const pairing = options.pairUser === false ? undefined : createPairing(options.pairUser ?? 'root')

  const sockets = new WebSocketServer({ noServer: true, maxPayload: 2 << 20 })
  const live = new Set<Connection>()
  const failures: number[] = []
  let unauthenticated = 0
  let sessions = 0

  const refuse = (socket: Duplex, status: string) => { socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); socket.destroy() }

  const server: Server = createServer((_request, response) => { response.writeHead(404).end() })
  server.on('upgrade', (request: IncomingMessage, socket: Duplex) => {
    const address = server.address()
    const listening = typeof address === 'object' && address ? address.port : 0
    if (request.url !== Endpoint) return refuse(socket, '404 Not Found')
    if (!hostAllowed(request.headers.host, listening)) return refuse(socket, '403 Forbidden')
    const origin = request.headers.origin
    if (origin !== undefined && !originAllowed(origin)) { log(`refused a connection from the origin ${origin}`); return refuse(socket, '403 Forbidden') }
    if (live.size >= MaxConnections || unauthenticated >= MaxUnauthenticated) return refuse(socket, '503 Service Unavailable')
    sockets.handleUpgrade(request, socket, Buffer.alloc(0), ws => serve(ws as unknown as WebSocketLike))
  })

  const authorizedKeys = async (user: string): Promise<PublicKey[] | undefined> => {
    const keys = await kernel.users.getAuthorizedKeys(user)
    return keys?.map(key => publicKeyOf(key)).filter((key): key is PublicKey => key !== null)
  }

  /** Serves an export on the channel: the one the peer names, or the only one there is */
  function openExport(channel: Channel, user: string) {
    const params = channel.params && typeof channel.params === 'object' && !(channel.params instanceof Uint8Array) && !Array.isArray(channel.params) ? channel.params : {}
    const wanted = typeof params['export'] === 'string' ? params['export'] : ''
    const available = options.exports ?? []
    const chosen = wanted ? available.find(candidate => candidate.name === wanted) : available.length === 1 ? available[0] : undefined
    if (!chosen) throw new PeerError('refused', wanted ? `no export named ${wanted}` : available.length ? 'name an export' : 'nothing is exported here')
    log(`${user} mounted ${chosen.name}${chosen.readOnly ? ' (read-only)' : ''}`)
    serveFs(new MessageStream(channel), chosen.backend, { readOnly: chosen.readOnly, onError: (op, where, error) => log(`export ${chosen.name}: ${op} ${where ?? ''} failed: ${(error as { code?: string })?.code ?? error}`) })
  }

  /** Hands a host device to root on the machine that asked; the device decides what a user may do with it */
  async function openDevice(channel: Channel, user: string) {
    const account = Array.from(kernel.users.all.values()).find(candidate => candidate.username === user)
    if (!account || account.uid !== 0) throw new PeerError('auth', 'only root can use the devices of this machine')
    const params = channel.params && typeof channel.params === 'object' && !(channel.params instanceof Uint8Array) && !Array.isArray(channel.params) ? channel.params : {}
    const wanted = typeof params['device'] === 'string' ? params['device'] : ''
    const available = options.devices ?? []
    const chosen = wanted ? available.find(candidate => candidate.name === wanted) : available.length === 1 ? available[0] : undefined
    if (!chosen) throw new PeerError('refused', wanted ? `no device named ${wanted}` : available.length ? 'name a device' : 'no devices are offered here')
    let session
    try { session = await chosen.open() } catch (error) {
      throw new PeerError('refused', error instanceof Error ? error.message : `cannot open ${chosen.name}`)
    }
    log(`${user} attached device ${chosen.name}`)
    void channel.done.then(() => log(`device ${chosen.name} released`))
    serveDevice(channel, session)
  }

  /**
   * A machine that logged in offers a directory of its own: this one mounts it as /mnt/<name> for as long as the channel lasts. Only
   * root may do that, since mounting is a root act; the tree is copied to memory, so one past the limits is refused.
   */
  async function acceptShare(channel: Channel, user: string) {
    const account = Array.from(kernel.users.all.values()).find(candidate => candidate.username === user)
    if (!account || account.uid !== 0) throw new PeerError('auth', 'only root can share a filesystem to this machine')
    const params = channel.params && typeof channel.params === 'object' && !(channel.params instanceof Uint8Array) && !Array.isArray(channel.params) ? channel.params : {}
    const name = params['name']
    if (typeof name !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new PeerError('refused', 'a share needs a name of letters, digits, dots, dashes and underscores')
    const target = `/mnt/${name}`
    if (kernel.filesystem.mounts.has(target)) throw new PeerError('refused', `${target} is already mounted`)

    const stream = new MessageStream(channel)
    const remote = new RemoteFS(new FsClient(stream, 30_000), {
      limits: options.shareLimits ?? DefaultLimits,
      owner: { uid: 0, gid: 0 },
      onError: (operation, where, error) => log(`share ${name}: ${operation} ${where} failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    try {
      await remote.ready()
    } catch (error) {
      throw new PeerError('limit', error instanceof Error ? error.message : String(error))
    }
    await kernel.filesystem.fs.mkdir(target, { recursive: true })
    await kernel.filesystem.fsSync.mount(target, remote)
    log(`${user} shared ${target}${params['readOnly'] === true ? ' (read-only on their side)' : ''}`)
    const forget = () => {
      if (kernel.filesystem.mounts.get(target) !== remote) return
      try { kernel.filesystem.fsSync.umount(target) } catch { /* already gone */ }
      log(`${target} is no longer shared`)
    }
    void channel.done.then(forget)
  }

  function serve(socket: WebSocketLike) {
    const connection = new Connection(webSocketTransport(socket), { role: 'server', meta: { name: 'ecmaosd', version: kernel.version }, maxChannels: 16 })
    live.add(connection)
    unauthenticated++
    let authenticated: string | undefined
    let counted = true
    let failed = 0
    const settle = () => { if (counted) { counted = false; unauthenticated-- } }
    // Someone who connects and never logs in does not get to hold a slot
    const patience = setTimeout(() => { if (!authenticated) connection.close(new PeerError('timeout', 'no login')) }, 60_000)
    void connection.done.then(() => { clearTimeout(patience); settle(); live.delete(connection); if (authenticated) sessions-- })

    connection.accept(AuthChannel, async channel => {
      if (authenticated) throw new PeerError('refused', 'already logged in')
      const now = Date.now()
      while (failures.length && now - failures[0]! > GlobalFailureWindow) failures.shift()
      if (failures.length >= GlobalFailureLimit) throw new PeerError('limit', 'too many failed logins; try again later')
      try {
        const user = await serverAuth(channel, {
          hostKey,
          authorizedKeys,
          failureDelay: FailureDelay,
          pair: pairing ? async (name, code, key) => {
            if (!pairing.redeem(name, code)) return false
            await kernel.users.authorizeKey(name, key as JsonWebKey, `paired-${new Date().toISOString().slice(0, 10)}`)
            // The client is told it is enrolled next: that must not be true only in memory
            options.flush?.()
            log(`paired a key for ${name}`)
            return true
          } : undefined
        })
        authenticated = user
        sessions++
        settle()
        log(`${user} logged in`)
        connection.accept('tty', channel => openTerminal(kernel, user, channel))
        connection.accept(FsChannel, channel => openExport(channel, user))
        connection.accept(DeviceChannel, channel => openDevice(channel, user))
        connection.accept(FsShareChannel, channel => acceptShare(channel, user))
      } catch {
        failures.push(Date.now())
        if (++failed >= AuthFailuresPerConnection) connection.close(new PeerError('auth', 'too many failed logins'))
      }
    })
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? DefaultPort, host === 'localhost' ? '127.0.0.1' : host, () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : options.port ?? DefaultPort

  return {
    port, host, fingerprint: hostFingerprint, hostKey, pairing,
    get sessions() { return sessions },
    async close() {
      for (const connection of live) connection.close()
      sockets.close()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }
}

/** A shell for `user` on this channel: bytes in are keys, bytes out are what the terminal wrote, `resize` messages change its size */
function openTerminal(kernel: Kernel, user: string, channel: Channel) {
  const params = channel.params && typeof channel.params === 'object' && !(channel.params instanceof Uint8Array) && !Array.isArray(channel.params) ? channel.params : {}
  const size = (value: unknown, fallback: number) => typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 1000 ? value : fallback
  const encoder = new TextEncoder()
  let queued = 0
  let driver: TerminalDriver | undefined
  let session: Awaited<ReturnType<Kernel['openSession']>> | undefined
  let closed = false

  // Input that arrives while the session is still starting is held, in order, and handled once it exists
  const early: Uint8Array[] = []
  channel.onData = chunk => { if (driver) driver.feed(chunk); else early.push(chunk.slice()) }
  channel.onMessage = value => {
    if (!value || typeof value !== 'object' || value instanceof Uint8Array || Array.isArray(value) || value['op'] !== 'resize') return
    driver?.resize(size(value['cols'], 80), size(value['rows'], 24))
  }
  channel.onClose = () => { closed = true; driver?.dispose(); void session?.close() }

  return kernel.openSession({
    username: user,
    cols: size(params['cols'], 80),
    rows: size(params['rows'], 24),
    write: data => {
      const bytes = typeof data === 'string' ? encoder.encode(data) : data.slice()
      queued += bytes.length
      if (queued > MaxQueuedOutput) { channel.close(new PeerError('limit', 'the terminal output is not being read')); return }
      void channel.write(bytes).then(() => { queued -= bytes.length }, () => {})
    },
    onEnd: () => channel.close()
  }).then(opened => {
    session = opened
    if (closed) return void opened.close()
    driver = new TerminalDriver(opened.terminal as never, true)
    for (const chunk of early.splice(0)) driver.feed(chunk)
  })
}
