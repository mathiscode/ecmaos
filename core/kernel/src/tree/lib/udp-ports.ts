/**
 * Bound UDP sockets. A program that `bind()`s a datagram socket gets a pair of streams (attached as descriptors by the syscall layer)
 * carrying addressed datagrams: each is a 2-byte big-endian length, the IPv4 address (4 bytes), the port (2 bytes), then the
 * payload. What it receives comes from three places, and what it sends goes to the same three:
 *
 *  - peers that reached a port this machine exposed through the gateway (`gateway expose -u`); a reply goes back the way the
 *    datagram came, and only to a peer that has sent something;
 *  - other programs on this machine, by loopback port;
 *  - anywhere else, through a gateway flow per destination (so the gateway's rules decide, as for any outbound datagram).
 *
 * Datagrams arriving faster than the program reads are dropped past a small queue, which UDP allows.
 */
import type { GatewayFlow } from './remote-gateway.ts'

export const FrameHeader = 8
const MaxFlows = 16
const MaxRoutes = 256
const QueueLimit = 256

/** Where outbound datagrams from a bound socket go; supplied by the syscall layer so this file knows nothing of the kernel */
export interface UdpDeps {
  /** A datagram flow to `host:port` through the gateway; rejects when none is up or the gateway refuses */
  open(host: string, port: number): Promise<GatewayFlow>
}

const ports = new Map<number, UdpPort>()

/** The bound socket holding `port`, if any */
export function udpPortAt(port: number): UdpPort | undefined { return ports.get(port) }

/** `0` picks the next free ephemeral port; a taken port returns `undefined` */
export function bindUdpPort(port: number, deps: UdpDeps): UdpPort | undefined {
  let chosen = port
  if (!chosen) {
    for (chosen = 49152; chosen <= 65535 && ports.has(chosen); chosen++) { /* next */ }
    if (chosen > 65535) return undefined
  } else if (ports.has(chosen)) return undefined
  const bound = new UdpPort(chosen, deps)
  ports.set(chosen, bound)
  return bound
}

export function frameOf(address: string, port: number, data: Uint8Array): Uint8Array {
  const parts = address.split('.').map(Number)
  const frame = new Uint8Array(FrameHeader + data.length)
  frame[0] = data.length >> 8
  frame[1] = data.length & 0xff
  for (let i = 0; i < 4; i++) frame[2 + i] = parts[i] ?? 0
  frame[6] = port >> 8
  frame[7] = port & 0xff
  frame.set(data, FrameHeader)
  return frame
}

export class UdpPort {
  readonly rx: ReadableStream<Uint8Array>
  readonly tx: WritableStream<Uint8Array>
  private controller!: ReadableStreamDefaultController<Uint8Array>
  private closed = false
  /** Peers that came in through the gateway, each with the way to answer it (insertion order is recency) */
  private readonly routes = new Map<string, (data: Uint8Array) => void>()
  private readonly flows = new Map<string, Promise<{ flow: GatewayFlow, write: WritableStreamDefaultWriter<Uint8Array> } | undefined>>()

  constructor(readonly port: number, private readonly deps: UdpDeps) {
    this.rx = new ReadableStream<Uint8Array>({ start: controller => { this.controller = controller } }, { highWaterMark: QueueLimit })
    let pending = new Uint8Array(0)
    this.tx = new WritableStream<Uint8Array>({
      write: chunk => {
        const joined = new Uint8Array(pending.length + chunk.length)
        joined.set(pending)
        joined.set(chunk, pending.length)
        let at = 0
        while (joined.length - at >= FrameHeader) {
          const size = (joined[at]! << 8) | joined[at + 1]!
          if (joined.length - at - FrameHeader < size) break
          const address = `${joined[at + 2]}.${joined[at + 3]}.${joined[at + 4]}.${joined[at + 5]}`
          this.send(address, (joined[at + 6]! << 8) | joined[at + 7]!, joined.slice(at + FrameHeader, at + FrameHeader + size))
          at += FrameHeader + size
        }
        pending = joined.slice(at)
      },
      close: () => this.close(),
      abort: () => this.close()
    })
  }

  /** A datagram for the program, from `address:port` */
  deliver(address: string, port: number, data: Uint8Array): void {
    if (this.closed || (this.controller.desiredSize ?? 1) <= 0) return
    this.controller.enqueue(frameOf(address, port, data))
  }

  /** A peer that reached us through the gateway; `reply` carries a datagram back to it */
  hear(peer: string, reply: (data: Uint8Array) => void): void {
    this.routes.delete(peer)
    if (this.routes.size >= MaxRoutes) this.routes.delete(this.routes.keys().next().value as string)
    this.routes.set(peer, reply)
  }

  /** The program sent a datagram */
  private send(address: string, port: number, data: Uint8Array): void {
    if (this.closed) return
    const key = `${address}:${port}`
    const route = this.routes.get(key)
    if (route) { route(data); return }
    if (address === '127.0.0.1' || address === '0.0.0.0') {
      ports.get(port)?.deliver('127.0.0.1', this.port, data) // nothing there: dropped, as a datagram to a closed port is
      return
    }
    void this.flowTo(address, port).then(entry => {
      if (!entry || this.closed) return
      const frame = new Uint8Array(2 + data.length)
      frame[0] = data.length >> 8
      frame[1] = data.length & 0xff
      frame.set(data, 2)
      void entry.write.write(frame).catch(() => { /* the flow ended */ })
    })
  }

  private flowTo(address: string, port: number) {
    const key = `${address}:${port}`
    let flow = this.flows.get(key)
    if (flow) return flow
    if (this.flows.size >= MaxFlows) return Promise.resolve(undefined)
    flow = this.deps.open(address, port).then(opened => {
      if (this.closed) { opened.close(); return undefined }
      void this.pump(opened, address, port).finally(() => { this.flows.delete(key) })
      return { flow: opened, write: opened.tx.getWriter() }
    }, () => { this.flows.delete(key); return undefined })
    this.flows.set(key, flow)
    return flow
  }

  /** Unframe what a gateway flow brings back and hand it to the program as coming from its destination */
  private async pump(flow: GatewayFlow, address: string, port: number): Promise<void> {
    const reader = flow.rx.getReader()
    let pending = new Uint8Array(0)
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        const joined = new Uint8Array(pending.length + value.length)
        joined.set(pending)
        joined.set(value, pending.length)
        let at = 0
        while (joined.length - at >= 2) {
          const size = (joined[at]! << 8) | joined[at + 1]!
          if (joined.length - at - 2 < size) break
          this.deliver(address, port, joined.slice(at + 2, at + 2 + size))
          at += 2 + size
        }
        pending = joined.slice(at)
      }
    } catch { /* the flow ended */ }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (ports.get(this.port) === this) ports.delete(this.port)
    this.routes.clear()
    for (const entry of this.flows.values()) void entry.then(opened => opened?.flow.close())
    this.flows.clear()
    try { this.controller.close() } catch { /* already closed */ }
  }
}
