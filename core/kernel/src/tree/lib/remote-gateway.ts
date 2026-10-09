/**
 * The machine's way onto the real network: a link to another ecmaOS machine started with `ecmaos --listen --gateway`, kept
 * up by the kernel, through which a program's `connect()` to an address that is not this machine reaches that address.
 *
 * `gateway up` logs in once (the same login `connect` and `mount -t ecmaos` use) and the connection stays; each outbound
 * socket is then one `net` channel on it. The host decides what is reachable (see the Node host's README); this side only
 * carries the bytes and turns a refusal into the errno a program would have got from a firewall or a dead host.
 */

import { datagram, datagramOf, formatEndpoint, NetChannel, openFlow, openListener, parseNetAccept, peerDatagram, peerDatagramOf, PeerError, resolveName } from '@ecmaos/peer'
import type { Channel, Connection } from '@ecmaos/peer'

import type { Shell } from '@ecmaos/types'

import type { Kernel } from '#kernel.ts'

import type { Outcome, OutcomeLine } from './outcome.ts'
import { DEFAULT_HOSTS, lookupHosts } from './hosts.ts'
import { canonicalIp, isIPv6 } from './ip.ts'
import { dialPeer, parseRemoteSource, RemoteMountFailure } from './remote-mount.ts'

/** A port opened on the gateway for this machine: what connects there arrives at `local` on this machine's loopback */
interface Exposure {
  /** Where the host opened it (`address:port` as it answered) */
  address: string
  port: number
  local: number
  listener: Channel
  udp: boolean
  /** Connections (or, for UDP, peers) forwarded so far, and open now (UDP has none) */
  total: number
  open: number
}

interface Link {
  connection: Connection
  exposures: Map<number, Exposure>
  host: string
  user: string
  since: number
  /** Flows open now */
  flows: number
}

const links = new WeakMap<Kernel, Link>()

/** Who is on the other end, or `undefined` when no gateway is up */
export function gatewayLink(kernel: Kernel): (Pick<Link, 'host' | 'user' | 'since' | 'flows'> & { exposed: Array<{ address: string, port: number, local: number, total: number, open: number, udp: boolean, listening: boolean }> }) | undefined {
  const link = links.get(kernel)
  return link && { host: link.host, user: link.user, since: link.since, flows: link.flows, exposed: [...link.exposures.values()].map(({ address, port, local, total, open, udp }) => ({ address, port, local, total, open, udp, listening: localProbe?.(local, udp) ?? true })) }
}

/**
 * How an incoming connection is handed to a program listening on this machine's loopback. Registered by the syscall layer
 * (which owns the loopback listeners), so this file does not import it. Returns false when nothing is listening on `port`.
 */
export type InboundSink = (kernel: Kernel, port: number, streams: { rx: ReadableStream<Uint8Array>, tx: WritableStream<Uint8Array> }, peer: string, ended: () => void) => boolean
let inboundSink: InboundSink | undefined
export function setInboundSink(sink: InboundSink) { inboundSink = sink }

/** The same for a datagram from `peer` (`address:port`): `reply` carries one back. Returns false when no program has `port` bound. */
export type DatagramSink = (port: number, data: Uint8Array, peer: string, reply: (data: Uint8Array) => void) => boolean
let datagramSink: DatagramSink | undefined
export function setDatagramSink(sink: DatagramSink) { datagramSink = sink }

/** Whether a program on this machine is listening on `port` (TCP) or has it bound (UDP). Registered by the syscall layer, which owns both. */
export type LocalProbe = (port: number, udp: boolean) => boolean
let localProbe: LocalProbe | undefined
export function setLocalProbe(probe: LocalProbe) { localProbe = probe }

/** A failure carrying the errno the program's `connect()` should see */
export class GatewayFailure extends Error {
  constructor(readonly errno: string, message: string) { super(message) }
}

/** What an outbound flow turns into for a program: a read stream, a write stream, and the way to end it */
export interface GatewayFlow {
  rx: ReadableStream<Uint8Array>
  tx: WritableStream<Uint8Array>
  address: string
  close(): void
}

/** The errno for why the host did not connect. A policy refusal is what a firewall's "administratively prohibited" gives. */
export function errnoFor(error: unknown): GatewayFailure {
  if (error instanceof PeerError) {
    if (error.code === 'timeout') return new GatewayFailure('ETIMEDOUT', error.message)
    if (error.code === 'limit') return new GatewayFailure('ENOBUFS', error.message)
    // the host puts the system's own code last when the connection itself failed: `93.184.216.34:80: ECONNREFUSED`
    const system = /:\s(E[A-Z]+)$/.exec(error.message)?.[1]
    if (system === 'ECONNREFUSED' || system === 'ETIMEDOUT' || system === 'EHOSTUNREACH' || system === 'ENETUNREACH' || system === 'ECONNRESET') return new GatewayFailure(system, error.message)
    if (error.code === 'refused') return new GatewayFailure('EACCES', error.message)
    return new GatewayFailure('ECONNREFUSED', error.message)
  }
  return new GatewayFailure('ECONNREFUSED', error instanceof Error ? error.message : String(error))
}

/** Streams over a flow's channel. Reading is paced by whoever consumes the stream; closing the writer is the half-close. */
export function streamsOf(channel: Channel): { rx: ReadableStream<Uint8Array>, tx: WritableStream<Uint8Array> } {
  channel.manualCredit = true
  let ended = false
  const rx = new ReadableStream<Uint8Array>({
    start(controller) {
      const end = () => { if (ended) return; ended = true; try { controller.close() } catch { /* already closed */ } }
      channel.onData = data => { if (!ended) controller.enqueue(data) }
      channel.onMessage = message => {
        if (message && typeof message === 'object' && !(message instanceof Uint8Array) && !Array.isArray(message) && message['op'] === 'eof') end()
      }
      void channel.done.then(end)
    },
    // asked for more only once the consumer has made room, so this is where the host is allowed to send more
    pull() { channel.grant(channel.outstanding) },
    cancel() { channel.close() }
  }, { highWaterMark: 1 })
  const tx = new WritableStream<Uint8Array>({
    async write(chunk) { await channel.write(chunk) },
    close() { try { channel.send({ op: 'eof' }) } catch { /* the flow already ended */ } },
    abort() { channel.close() }
  })
  return { rx, tx }
}

/**
 * A UDP flow as streams, the shape a program's socket is built from: every datagram is a 2-byte big-endian length then its
 * bytes (the preview1 shim frames and unframes them). Datagrams arriving faster than the program reads are dropped past a
 * small queue, which UDP allows; closing the write side ends the flow.
 */
export function datagramStreamsOf(channel: Channel): { rx: ReadableStream<Uint8Array>, tx: WritableStream<Uint8Array> } {
  const rx = new ReadableStream<Uint8Array>({
    start(controller) {
      let ended = false
      const end = () => { if (ended) return; ended = true; try { controller.close() } catch { /* already closed */ } }
      channel.onMessage = message => {
        const data = datagramOf(message)
        if (!data || ended || (controller.desiredSize ?? 1) <= 0) return
        const frame = new Uint8Array(2 + data.length)
        frame[0] = data.length >> 8
        frame[1] = data.length & 0xff
        frame.set(data, 2)
        controller.enqueue(frame)
      }
      void channel.done.then(end)
    },
    cancel() { channel.close() }
  }, { highWaterMark: 64 })
  let pending = new Uint8Array(0)
  const tx = new WritableStream<Uint8Array>({
    write(chunk) {
      const joined = new Uint8Array(pending.length + chunk.length)
      joined.set(pending)
      joined.set(chunk, pending.length)
      let at = 0
      while (joined.length - at >= 2) {
        const size = (joined[at]! << 8) | joined[at + 1]!
        if (joined.length - at - 2 < size) break
        try { channel.send(datagram(joined.slice(at + 2, at + 2 + size))) } catch { /* the flow already ended */ }
        at += 2 + size
      }
      pending = joined.slice(at)
    },
    close() { channel.close() },
    abort() { channel.close() }
  })
  return { rx, tx }
}

/** Opens a TCP flow (or, with `proto` udp, a datagram flow) to `host:port` through the gateway, or throws a {@link GatewayFailure} saying which errno to give */
export async function openGatewayFlow(kernel: Kernel, host: string, port: number, proto: 'tcp' | 'udp' = 'tcp'): Promise<GatewayFlow> {
  const link = links.get(kernel)
  if (!link) throw new GatewayFailure('ENETUNREACH', 'no gateway is up (see gateway up)')
  let opened
  try { opened = await openFlow(link.connection, { proto, host, port }, { timeout: 20_000 }) } catch (error) { throw errnoFor(error) }
  link.flows++
  const { channel } = opened
  void channel.done.then(() => { link.flows-- })
  return { ...(proto === 'udp' ? datagramStreamsOf(channel) : streamsOf(channel)), address: opened.address, close: () => channel.close() }
}

/** Why a name did not resolve, in the terms of `getaddrinfo`: no such name, or no answer to be had (no gateway, or it failed) */
export class LookupFailure extends Error {
  constructor(readonly kind: 'NONAME' | 'AGAIN', message: string) { super(message) }
}

/**
 * The addresses for `name`, the way a program's `getaddrinfo` should see them: an address literal is itself, then `/etc/hosts`,
 * then the gateway's resolver. With no gateway up that is a temporary failure ("no nameserver"), as on a machine that cannot
 * reach one. A name the gateway cannot or will not give is no such name, with its reason.
 */
export async function resolveHostname(kernel: Kernel, name: string, family: 4 | 6 = 4): Promise<string[]> {
  const literal = canonicalIp(name)
  if (literal !== undefined && isIPv6(literal) === (family === 6)) return [literal]
  if (literal !== undefined) return [] // an address of the other family has no address of this one
  const hosts = await kernel.filesystem.fs.exists('/etc/hosts') ? await kernel.filesystem.fs.readFile('/etc/hosts', 'utf-8') : DEFAULT_HOSTS
  const local = lookupHosts(hosts, name, family)
  if (local.length > 0) return local
  const link = links.get(kernel)
  if (!link) throw new LookupFailure('AGAIN', 'no gateway is up (see gateway up)')
  try {
    const addresses = await resolveName(link.connection, name, { family, timeout: 20_000 })
    if (addresses.length === 0) throw new LookupFailure('NONAME', `${name}: no address`)
    return addresses
  } catch (error) {
    if (error instanceof LookupFailure) throw error
    if (error instanceof PeerError && (error.code === 'timeout' || error.code === 'closed')) throw new LookupFailure('AGAIN', error.message)
    throw new LookupFailure('NONAME', error instanceof Error ? error.message : String(error))
  }
}

/** Takes the connections the gateway's host forwards for a port this machine exposed, and gives each to the local listener */
function acceptInbound(kernel: Kernel, link: Link, channel: Channel): void {
  const target = parseNetAccept(channel.params)
  const exposure = link.exposures.get(target.id)
  if (!exposure) throw new PeerError('refused', 'no such listener')
  const streams = streamsOf(channel)
  if (!inboundSink?.(kernel, exposure.local, streams, target.peer, () => channel.close())) {
    throw new PeerError('refused', `nothing is listening on port ${exposure.local}`)
  }
  exposure.total++
  exposure.open++
  void channel.done.then(() => { exposure.open-- })
}

/** Opens a port on the gateway's host that forwards to `local` on this machine; throws a {@link GatewayFailure} with the host's reason */
export async function exposePort(kernel: Kernel, local: number, as?: number, udp = false): Promise<{ address: string, port: number }> {
  const link = links.get(kernel)
  if (!link) throw new GatewayFailure('ENETUNREACH', 'no gateway is up (see gateway up)')
  let opened
  try { opened = await openListener(link.connection, { port: local, as, udp }, { timeout: 20_000 }) } catch (error) {
    throw new GatewayFailure(error instanceof PeerError && error.code === 'refused' ? 'EACCES' : 'ECONNREFUSED', error instanceof Error ? error.message : String(error))
  }
  const exposure: Exposure = { address: opened.address, port: opened.port, local, listener: opened.channel, udp, total: 0, open: 0 }
  if (udp) {
    const seen = new Set<string>()
    opened.channel.onMessage = message => {
      const got = peerDatagramOf(message)
      if (!got) return
      if (!datagramSink?.(local, got.data, got.peer, data => { try { opened.channel.send(peerDatagram(data, got.peer)) } catch { /* the link is going away */ } })) return
      if (!seen.has(got.peer) && seen.size < 1024) { seen.add(got.peer); exposure.total++ }
    }
  }
  link.exposures.set(opened.id, exposure)
  void opened.channel.done.then(() => { if (link.exposures.get(opened.id) === exposure) link.exposures.delete(opened.id) })
  return { address: opened.address, port: opened.port }
}

export type GatewayRequest =
  | { action: 'up', target: string, options: Record<string, string> }
  | { action: 'expose', port: number, as?: number, udp?: boolean }
  | { action: 'unexpose', port: number }
  | { action: 'down' }
  | { action: 'status' }

/** `gateway`: what the command asks for, as lines to print and an exit code */
export async function manageGateway(kernel: Kernel, shell: Shell, request: GatewayRequest): Promise<Outcome> {
  const lines: OutcomeLine[] = []
  const out = (text: string) => lines.push({ stream: 'out', text })
  const err = (text: string) => lines.push({ stream: 'err', text })

  if (request.action === 'status') {
    const link = gatewayLink(kernel)
    out(link ? `Gateway: ${link.user}@${link.host}, up since ${new Date(link.since).toISOString()}, ${link.flows} flow${link.flows === 1 ? '' : 's'} open` : 'No gateway is up.')
    for (const item of link?.exposed ?? []) out((item.udp ? `Exposed: udp ${formatEndpoint(item.address, item.port)} -> port ${item.local} here (${item.total} peer${item.total === 1 ? '' : 's'} so far)` : `Exposed: ${formatEndpoint(item.address, item.port)} -> port ${item.local} here (${item.open} open, ${item.total} so far)`) + (item.listening ? '' : ' - nothing is listening on it here (connections are dropped until a program is)'))
    return { code: link ? 0 : 1, lines }
  }

  if (request.action === 'down') {
    const link = links.get(kernel)
    if (!link) { err('gateway: no gateway is up'); return { code: 1, lines } }
    links.delete(kernel)
    link.connection.close()
    out(`Gateway ${link.host} closed`)
    return { code: 0, lines }
  }

  if (request.action === 'expose') {
    try {
      const where = await exposePort(kernel, request.port, request.as, request.udp)
      out(`${request.udp ? 'UDP port' : 'Port'} ${request.port} is reachable at ${formatEndpoint(where.address, where.port)} on the gateway host`)
      return { code: 0, lines }
    } catch (error) {
      err(`gateway: ${error instanceof Error ? error.message : String(error)}`)
      return { code: 1, lines }
    }
  }

  if (request.action === 'unexpose') {
    const link = links.get(kernel)
    const found = link && [...link.exposures.entries()].find(([, item]) => item.port === request.port || item.local === request.port)
    if (!found) { err(`gateway: port ${request.port} is not exposed`); return { code: 1, lines } }
    found[1].listener.close()
    link!.exposures.delete(found[0])
    out(`Stopped forwarding ${found[1].address}:${found[1].port}`)
    return { code: 0, lines }
  }

  try {
    if (links.has(kernel)) throw new RemoteMountFailure('a gateway is already up (gateway down first)')
    const source = parseRemoteSource(request.target, shell.env.get('USER') || 'root')
    if (!source || source.name) throw new RemoteMountFailure('the gateway is [user@]host[:port]')
    const options = request.options
    if (!options['password']) throw new RemoteMountFailure('a password is needed to unlock your key')
    const connection = await dialPeer(kernel, shell, {
      source,
      password: options['password'],
      pairingCode: options['pair'],
      fingerprint: options['fingerprint'],
      acceptNew: options['accept-new'] === 'yes' || options['accept-new'] === 'true'
    })
    const link: Link = { connection, exposures: new Map(), host: `${source.host}:${source.port}`, user: source.user, since: Date.now(), flows: 0 }
    links.set(kernel, link)
    // what the host forwards for a port this machine exposed comes as channels it opens
    connection.accept(NetChannel, channel => acceptInbound(kernel, link, channel))
    // the other side going away takes the route with it
    void connection.done.then(() => { if (links.get(kernel) === link) links.delete(kernel) })
    out(`Gateway ${link.host} is up as ${link.user}`)
    return { code: 0, lines }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const known = error instanceof RemoteMountFailure || error instanceof PeerError || (error instanceof Error && 'code' in error)
    err(`gateway: ${known ? message : `failed: ${message}`}`)
    return { code: 1, lines }
  }
}
