import type { Channel } from './channel.ts'
import type { Connection } from './connection.ts'
import { PeerError } from './errors.ts'
import type { Value } from './codec.ts'

/**
 * The channel kind a network gateway serves: one channel is one outbound flow. The host does the connecting, so a
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
  proto: 'tcp'
  host: string
  port: number
}

export const MaxHostLength = 253

/** Checks what came over the wire; the host never trusts it further than this */
export function parseNetTarget(value: Value): NetTarget {
  if (!value || typeof value !== 'object' || value instanceof Uint8Array || Array.isArray(value)) throw new PeerError('protocol', 'bad net target')
  const { proto, host, port } = value
  if (proto !== 'tcp') throw new PeerError('unsupported', `${typeof proto === 'string' ? proto : 'that'} is not a protocol this gateway speaks`)
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
