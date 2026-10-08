/**
 * The machine's way onto the real network: a link to another ecmaOS machine started with `ecmaos --listen --gateway`, kept
 * up by the kernel, through which a program's `connect()` to an address that is not this machine reaches that address.
 *
 * `gateway up` logs in once (the same login `connect` and `mount -t ecmaos` use) and the connection stays; each outbound
 * socket is then one `net` channel on it. The host decides what is reachable (see the Node host's README); this side only
 * carries the bytes and turns a refusal into the errno a program would have got from a firewall or a dead host.
 */

import { datagram, datagramOf, openFlow, PeerError, resolveName } from '@ecmaos/peer'
import type { Channel, Connection } from '@ecmaos/peer'

import type { Shell } from '@ecmaos/types'

import type { Kernel } from '#kernel.ts'

import type { Outcome, OutcomeLine } from './outcome.ts'
import { DEFAULT_HOSTS, isIPv4, lookupHosts } from './hosts.ts'
import { dialPeer, parseRemoteSource, RemoteMountFailure } from './remote-mount.ts'

interface Link {
  connection: Connection
  host: string
  user: string
  since: number
  /** Flows open now */
  flows: number
}

const links = new WeakMap<Kernel, Link>()

/** Who is on the other end, or `undefined` when no gateway is up */
export function gatewayLink(kernel: Kernel): Pick<Link, 'host' | 'user' | 'since' | 'flows'> | undefined {
  const link = links.get(kernel)
  return link && { host: link.host, user: link.user, since: link.since, flows: link.flows }
}

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
  if (family === 4 && isIPv4(name)) return [name]
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

export type GatewayRequest =
  | { action: 'up', target: string, options: Record<string, string> }
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
    const link: Link = { connection, host: `${source.host}:${source.port}`, user: source.user, since: Date.now(), flows: 0 }
    links.set(kernel, link)
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
