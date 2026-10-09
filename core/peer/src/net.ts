import type { Channel } from './channel.ts'
import type { Connection } from './connection.ts'
import { PeerError } from './errors.ts'
import type { Value } from './codec.ts'

/**
 * The channel kind a network gateway serves: one channel is one outbound flow (TCP, or UDP to one peer) or one lookup. The host does the connecting, so a
 * machine with no sockets of its own (a browser tab) can reach the network through one that has them.
 *
 * Opening it carries the target as params. The host answers with a control message, `{ op: 'connected', address, port }`
 * when the flow is up, or closes the channel with the reason (`refused`, with a message ready to show) when it is not.
 * After that the channel's bytes are the flow's bytes in both directions, with flow control as for any channel. A side
 * that has no more to send says `{ op: 'eof' }` (the flow stays open for the other direction); closing the channel ends
 * the flow.
 */
export const NetChannel = 'net'

export interface NetTarget {
  /** `udp` is a flow of datagrams, one `{ op: 'd', data }` control message each (see {@link Datagram}), not a byte stream */
  proto: 'tcp' | 'udp'
  host: string
  port: number
}

export const MaxHostLength = 253

/** The most a UDP datagram can carry over IPv4 */
export const MaxDatagram = 65507

/** A datagram on a `udp` flow, in either direction: it is a control message, so it is not flow controlled and may be dropped */
export function datagram(data: Uint8Array): Value { return { op: 'd', data } }

/** The bytes of a datagram message, or `undefined` if the message is something else (or too big to be one) */
export function datagramOf(message: Value): Uint8Array | undefined {
  if (!message || typeof message !== 'object' || message instanceof Uint8Array || Array.isArray(message) || message['op'] !== 'd') return undefined
  const data = message['data']
  return data instanceof Uint8Array && data.length <= MaxDatagram ? data : undefined
}

/** Checks what came over the wire; the host never trusts it further than this */
export function parseNetTarget(value: Value): NetTarget {
  if (!value || typeof value !== 'object' || value instanceof Uint8Array || Array.isArray(value)) throw new PeerError('protocol', 'bad net target')
  const { proto, host, port } = value
  if (proto !== 'tcp' && proto !== 'udp') throw new PeerError('unsupported', `${typeof proto === 'string' ? proto : 'that'} is not a protocol this gateway speaks`)
  if (typeof host !== 'string' || host.length === 0 || host.length > MaxHostLength || /[\s\0/]/.test(host)) throw new PeerError('refused', 'bad host name')
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw new PeerError('refused', 'bad port')
  return { proto, host, port }
}

export interface OpenedFlow {
  channel: Channel
  /** The address the host actually connected to */
  address: string
  port: number
}

/**
 * Asks the other side to connect to `target` and waits until it has, or says why not. The channel it returns carries the
 * flow's bytes.
 */
export async function openFlow(connection: Connection, target: NetTarget, options: { timeout?: number } = {}): Promise<OpenedFlow> {
  const channel = await connection.open(NetChannel, { params: { ...target }, timeout: options.timeout ?? 20_000 })
  return await new Promise<OpenedFlow>((resolve, reject) => {
    const fail = (error?: PeerError) => reject(error ?? new PeerError('closed', 'the gateway closed the flow'))
    void channel.done.then(error => fail(error))
    channel.onMessage = message => {
      if (!message || typeof message !== 'object' || message instanceof Uint8Array || Array.isArray(message) || message['op'] !== 'connected') return
      channel.onMessage = undefined
      resolve({ channel, address: String(message['address'] ?? ''), port: Number(message['port'] ?? target.port) })
    }
  })
}

/** A name to resolve on the host. `family` is 4 or 6 (default 4: what a guest's `AF_INET` asks for). */
export interface NetLookup {
  proto: 'dns'
  name: string
  family?: 4 | 6
}

/** Checks a lookup request that came over the wire */
export function parseNetLookup(value: Value): Required<NetLookup> {
  if (!value || typeof value !== 'object' || value instanceof Uint8Array || Array.isArray(value)) throw new PeerError('protocol', 'bad net lookup')
  const { proto, name, family } = value
  if (proto !== 'dns') throw new PeerError('unsupported', 'not a lookup')
  if (typeof name !== 'string' || name.length === 0 || name.length > MaxHostLength || /[\s\0/]/.test(name)) throw new PeerError('refused', 'bad host name')
  if (family !== undefined && family !== 4 && family !== 6) throw new PeerError('refused', 'bad address family')
  return { proto, name, family: family ?? 4 }
}

/**
 * Asks the host to resolve `name` with its own resolver and returns the addresses it is willing to give (the policy may hold
 * some back, or refuse the name). The answer is one `{ op: 'resolved', addresses }` message, after which the host closes the
 * channel; a refusal closes it with the reason.
 */
export async function resolveName(connection: Connection, name: string, options: { family?: 4 | 6, timeout?: number } = {}): Promise<string[]> {
  const channel = await connection.open(NetChannel, { params: { proto: 'dns', name, ...(options.family ? { family: options.family } : {}) }, timeout: options.timeout ?? 20_000 })
  return await new Promise<string[]>((resolve, reject) => {
    void channel.done.then(error => reject(error ?? new PeerError('closed', 'the gateway closed without an answer')))
    channel.onMessage = message => {
      if (!message || typeof message !== 'object' || message instanceof Uint8Array || Array.isArray(message) || message['op'] !== 'resolved') return
      const list = message['addresses']
      channel.close()
      resolve(Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [])
    }
  })
}

/** Asks the host to listen: `port` here, the port on the host to open (`as`, default the same). */
export interface NetListen {
  proto: 'listen'
  port: number
  as?: number
  /** Listen for datagrams instead of connections: each arrives as one `{ op: 'd', data, peer }` message on the listener's channel, and a reply is the same message back */
  udp?: boolean
}

/** Checks a listen request that came over the wire */
export function parseNetListen(value: Value): { proto: 'listen', port: number, as: number, udp: boolean } {
  if (!value || typeof value !== 'object' || value instanceof Uint8Array || Array.isArray(value)) throw new PeerError('protocol', 'bad net listen')
  const { proto, port, as, udp } = value
  if (proto !== 'listen') throw new PeerError('unsupported', 'not a listen request')
  const valid = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 65535
  if (!valid(port)) throw new PeerError('refused', 'bad port')
  if (as !== undefined && !valid(as)) throw new PeerError('refused', 'bad port')
  if (udp !== undefined && typeof udp !== 'boolean') throw new PeerError('protocol', 'bad net listen')
  return { proto, port, as: as ?? port, udp: udp === true }
}

/** `address:port` for IPv4 and `[address]:port` for IPv6, the way a peer is named on the wire */
export function formatEndpoint(address: string, port: number): string { return address.includes(':') ? `[${address}]:${port}` : `${address}:${port}` }

/** The address and port of such a name, or `undefined` if it is not one */
export function parseEndpoint(text: string): { address: string, port: number } | undefined {
  const match = /^\[([0-9a-fA-F:.]+)\]:(\d{1,5})$/.exec(text) ?? /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(text)
  if (!match) return undefined
  const port = Number(match[2])
  return port <= 65535 ? { address: match[1]!, port } : undefined
}

/** A datagram that came from, or goes to, `peer` (`address:port`, `[address]:port` for IPv6) through a `udp` listener */
export function peerDatagram(data: Uint8Array, peer: string): Value { return { op: 'd', data, peer } }

/** The bytes and peer of such a message, or `undefined` if it is something else (or malformed) */
export function peerDatagramOf(message: Value): { data: Uint8Array, peer: string } | undefined {
  const data = datagramOf(message)
  const peer = message && typeof message === 'object' && !(message instanceof Uint8Array) && !Array.isArray(message) ? message['peer'] : undefined
  return data && typeof peer === 'string' && peer.length <= MaxHostLength + 8 ? { data, peer } : undefined
}

/** What the host opens towards the guest for each connection its listener accepts */
export interface NetAccept {
  proto: 'accept'
  /** The `id` the listener answered with */
  id: number
  /** Who connected, `address:port`, for the guest to show */
  peer: string
}

/** Checks an incoming connection announced over the wire */
export function parseNetAccept(value: Value): NetAccept {
  if (!value || typeof value !== 'object' || value instanceof Uint8Array || Array.isArray(value)) throw new PeerError('protocol', 'bad net accept')
  const { proto, id, peer } = value
  if (proto !== 'accept') throw new PeerError('unsupported', 'not an incoming connection')
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) throw new PeerError('protocol', 'bad listener id')
  if (typeof peer !== 'string' || peer.length > MaxHostLength + 8) throw new PeerError('protocol', 'bad peer')
  return { proto, id, peer }
}

export interface OpenedListener {
  /** Closing it stops listening (connections already accepted carry on until they end) */
  channel: Channel
  /** The id the host's incoming connections will name */
  id: number
  address: string
  port: number
}

/**
 * Asks the host to open a port and forward what connects to it. Resolves when it is listening, or rejects with the reason
 * (outside the ports the host allows, in use, too many). Each connection then arrives as a channel the host opens, which the
 * caller takes with `connection.accept(NetChannel, ...)` and recognises by {@link parseNetAccept}.
 */
export async function openListener(connection: Connection, request: { port: number, as?: number, udp?: boolean }, options: { timeout?: number } = {}): Promise<OpenedListener> {
  const channel = await connection.open(NetChannel, { params: { proto: 'listen', port: request.port, ...(request.as ? { as: request.as } : {}), ...(request.udp ? { udp: true } : {}) }, timeout: options.timeout ?? 20_000 })
  return await new Promise<OpenedListener>((resolve, reject) => {
    void channel.done.then(error => reject(error ?? new PeerError('closed', 'the gateway closed the listener')))
    channel.onMessage = message => {
      if (!message || typeof message !== 'object' || message instanceof Uint8Array || Array.isArray(message) || message['op'] !== 'listening') return
      channel.onMessage = undefined
      resolve({ channel, id: Number(message['id']), address: String(message['address'] ?? ''), port: Number(message['port']) })
    }
  })
}
