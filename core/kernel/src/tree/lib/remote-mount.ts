import { AuthChannel, clientAuth, Connection, FsChannel, FsClient, MessageStream, publicKeyOf, webSocketTransport } from '@ecmaos/peer'
import type { PublicKey, WebSocketLike } from '@ecmaos/peer'

import type { Shell } from '@ecmaos/types'

import type { Kernel } from '#kernel.ts'

import { findKnownHost, KNOWN_HOSTS_FILE, knownHostLine } from './known-hosts.ts'
import { RemoteFS } from './remote-fs.ts'

export const DefaultPort = 30022
/** What a mount refuses to copy into memory unless told otherwise */
export const DefaultLimits = { files: 5000, bytes: 50 << 20 }

/** A failure with a message ready to show */
export class RemoteMountFailure extends Error {}

export interface RemoteSource {
  user: string
  host: string
  port: number
  /** The export's name on the other machine; empty for its only one */
  name: string
  /** Reach it with `wss://` (a certificate checked by the platform) instead of `ws://` */
  tls: boolean
}

/** `[wss://][user@]host[:port][/export]` */
export function parseRemoteSource(text: string, defaultUser: string): RemoteSource | null {
  const tls = /^wss:\/\//.test(text)
  const source = text.replace(/^wss?:\/\//, '')
  const match = /^(?:([^@/\s]+)@)?(\[[^\]]+\]|[^:/\s@]+)(?::(\d+))?(?:\/(.*))?$/.exec(source)
  if (!match) return null
  const port = match[3] ? Number(match[3]) : DefaultPort
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { user: match[1] ?? defaultUser, host: match[2]!, port, name: match[4] ?? '', tls }
}

/** Sizes such as `50M`, `2G`, `65536` */
export function parseSize(text: string): number | null {
  const match = /^(\d+)([kKmMgG]?)$/.exec(text)
  if (!match) return null
  return Number(match[1]) * ({ '': 1, k: 1024, m: 1048576, g: 1073741824 }[match[2]!.toLowerCase() as '' | 'k' | 'm' | 'g'])
}

export interface DialOptions {
  source: RemoteSource
  /** The password of the local account whose key signs the login (it unlocks that key) */
  password: string
  pairingCode?: string
  /** Accept this host key fingerprint even if the host is not known yet */
  fingerprint?: string
  /** Remember a host seen for the first time */
  acceptNew?: boolean
}

/** Connects to a machine started with `ecmaos --listen` and logs in with the local user's key */
export async function dialPeer(kernel: Kernel, shell: Shell, options: DialOptions): Promise<Connection> {
  const { source } = options
  const id = `${source.host}:${source.port}`
  const uid = shell.credentials.uid
  const home = shell.env.get('HOME') || kernel.users.get(uid)?.home || '/root'
  const knownHostsFile = `${home}/${KNOWN_HOSTS_FILE}`
  const fs = kernel.filesystem.fs

  const socket = new WebSocket(`${source.tls ? 'wss' : 'ws'}://${source.host}:${source.port}/ecmaos`)
  // Wrapped before it opens, so nothing the host sends first is missed
  const transport = webSocketTransport(socket as unknown as WebSocketLike)
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new RemoteMountFailure(`could not connect to ${id}`)), { once: true })
  })

  const connection = new Connection(transport, { role: 'client', meta: { name: 'ecmaos-mount' } })
  try {
    await connection.ready
    const channel = await connection.open(AuthChannel)
    await clientAuth(channel, {
      user: source.user,
      pairingCode: options.pairingCode,
      trust: async (key: PublicKey, fingerprint: string) => {
        const known = await fs.exists(knownHostsFile) ? findKnownHost(await fs.readFile(knownHostsFile, 'utf-8'), id) : null
        if (known) {
          if (known.x === key.x && known.y === key.y) return true
          throw new RemoteMountFailure(`the host key for ${id} has changed (now ${fingerprint}); remove its line from ${knownHostsFile} if you trust the change`)
        }
        if (options.fingerprint ? options.fingerprint !== fingerprint : !options.acceptNew) {
          throw new RemoteMountFailure(`${id} is not a known host (its key is ${fingerprint}); connect to it once, or mount with -o fingerprint=${fingerprint}`)
        }
        await fs.mkdir(`${home}/.ssh`, { recursive: true, mode: 0o700 })
        const existing = await fs.exists(knownHostsFile) ? await fs.readFile(knownHostsFile, 'utf-8') : ''
        await fs.writeFile(knownHostsFile, (existing && !existing.endsWith('\n') ? existing + '\n' : existing) + knownHostLine(id, key), { mode: 0o644 })
        return true
      },
      sign: async data => {
        const { publicKey, signature } = await kernel.users.signWithKey(uid, options.password, data)
        const key = publicKeyOf(publicKey)
        if (!key) throw new RemoteMountFailure('your key is not a P-384 key')
        return { key, signature }
      }
    })
    return connection
  } catch (error) {
    connection.close()
    throw error
  }
}

export interface RemoteMountOptions extends DialOptions {
  limits: { files: number, bytes: number }
  owner: { uid: number, gid: number }
  timeout?: number
  onError?: (operation: string, path: string, error: unknown) => void
}

/** Logs in, opens the export and copies it (subject to the limits); the result is ready to mount */
export async function openRemoteFs(kernel: Kernel, shell: Shell, options: RemoteMountOptions): Promise<RemoteFS> {
  const connection = await dialPeer(kernel, shell, options)
  try {
    const channel = await connection.open(FsChannel, { params: { export: options.source.name }, timeout: 20_000 })
    const remote = new RemoteFS(new FsClient(new MessageStream(channel), options.timeout ?? 30_000), {
      limits: options.limits, owner: options.owner, onError: options.onError
    })
    remote.closeRemote = () => connection.close()
    await remote.ready()
    return remote
  } catch (error) {
    connection.close()
    throw error
  }
}
