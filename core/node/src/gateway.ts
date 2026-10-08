import dns from 'node:dns'
import net, { BlockList, isIP } from 'node:net'
import type { Socket } from 'node:net'

import { NetChannel, parseNetLookup, parseNetTarget, PeerError } from '@ecmaos/peer'
import type { Channel, Connection } from '@ecmaos/peer'

/**
 * The network gateway: lets a machine that logs in to this host reach the network through it, one outbound flow per `net`
 * channel. A gateway is an open proxy for everyone who can log in, so it is off unless asked for, closed by default
 * (nothing on this host's own surroundings can be reached), and says in its log who went where.
 */

/** Where nothing may be reached unless a rule names the address: this host, its neighbours, metadata services, multicast */
const Blocked = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]
] as const) Blocked.addSubnet(address, prefix, 'ipv4')
for (const [address, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) Blocked.addSubnet(address, prefix, 'ipv6')

export interface Rule {
  /** The rule as written, for messages */
  text: string
  /** A host name pattern (`*` matches anything), matched against the name asked for */
  name?: RegExp
  /** An address or network, matched against what the name resolved to */
  addresses?: BlockList
  ports?: Array<[number, number]>
}

const portsOf = (text: string): Array<[number, number]> | undefined => {
  const ranges: Array<[number, number]> = []
  for (const part of text.split(',')) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part)
    const low = match ? Number(match[1]) : NaN
    const high = match ? Number(match[2] ?? match[1]) : NaN
    if (!match || low < 1 || high > 65535 || low > high) throw new Error(`bad port list '${text}'`)
    ranges.push([low, high])
  }
  return ranges
}

/** `TARGET[:PORTS]`: TARGET is a host name pattern, an address, or an address/prefix (in brackets for IPv6 with ports) */
export function parseRule(text: string): Rule {
  let target = text.trim()
  let ports: Array<[number, number]> | undefined
  if (target.startsWith('[')) {
    const end = target.indexOf(']')
    if (end === -1) throw new Error(`bad rule '${text}'`)
    const rest = target.slice(end + 1)
    if (rest) {
      if (!rest.startsWith(':')) throw new Error(`bad rule '${text}'`)
      ports = portsOf(rest.slice(1))
    }
    target = target.slice(1, end)
  } else {
    const colon = target.lastIndexOf(':')
    if (colon !== -1 && target.indexOf(':') === colon && /^[\d,-]+$/.test(target.slice(colon + 1))) {
      ports = portsOf(target.slice(colon + 1))
      target = target.slice(0, colon)
    }
  }
  if (!target) throw new Error(`bad rule '${text}'`)

  const [base, prefix] = target.split('/') as [string, string | undefined]
  const family = isIP(base)
  if (family) {
    const bits = prefix === undefined ? (family === 4 ? 32 : 128) : Number(prefix)
    if (!Number.isInteger(bits) || bits < 0 || bits > (family === 4 ? 32 : 128)) throw new Error(`bad prefix in '${text}'`)
    const addresses = new BlockList()
    addresses.addSubnet(base, bits, family === 4 ? 'ipv4' : 'ipv6')
    return { text, addresses, ports }
  }
  if (prefix !== undefined || !/^[A-Za-z0-9*._-]+$/.test(target)) throw new Error(`bad rule '${text}'`)
  const pattern = target.toLowerCase().replace(/\.$/, '').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return { text, name: new RegExp(`^${pattern}$`), ports }
}

const inPorts = (rule: Rule, port: number) => !rule.ports || rule.ports.some(([low, high]) => port >= low && port <= high)
const family = (address: string) => isIP(address) === 6 ? 'ipv6' : 'ipv4'

/** `::ffff:10.0.0.1` is the IPv4 address inside it: blocking one must block the other */
const plain = (address: string) => /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1] ?? address

function ruleMatches(rule: Rule, host: string, addresses: string[], port: number): boolean {
  if (!inPorts(rule, port)) return false
  if (rule.name) return rule.name.test(host)
  return addresses.some(address => rule.addresses!.check(plain(address), family(plain(address))))
}

export interface GatewayOptions {
  /** Guest users who may use it (default: root) */
  users?: string[]
  /** If any are given, only destinations one of them matches are reachable; they are also what lets a blocked address through */
  allow?: Rule[]
  /** Never reachable, whatever else says so */
  deny?: Rule[]
  /** Most flows at once, per connection (default 32) */
  maxFlows?: number
  /** Close a flow that has carried nothing in either direction for this long, ms (default 5 minutes) */
  idleMs?: number
  /** Where a name resolves; replaced in tests */
  resolve?: (host: string) => Promise<string[]>
  /** Where a name resolves for a given family (lookups for the guest); replaced in tests. Defaults to `resolve` for IPv4. */
  resolveFamily?: (host: string, family: 4 | 6) => Promise<string[]>
  /** How a flow is connected; replaced in tests */
  connect?: (address: string, port: number) => Socket
  log?: (text: string) => void
}

const defaultResolveFamily = async (host: string, family: 4 | 6) => (await dns.promises.lookup(host, { all: true, family })).map(entry => entry.address)

const defaultResolve = async (host: string) => (await dns.promises.lookup(host, { all: true })).map(entry => entry.address)

export class Gateway {
  readonly users: string[]
  private readonly _allow: Rule[]
  private readonly _deny: Rule[]
  private readonly _maxFlows: number
  private readonly _idleMs: number
  private readonly _resolve: (host: string) => Promise<string[]>
  private readonly _resolveFamily: (host: string, family: 4 | 6) => Promise<string[]>
  private readonly _connect: (address: string, port: number) => Socket
  private readonly _log: (text: string) => void
  private readonly _flows = new WeakMap<Connection, number>()

  constructor(options: GatewayOptions = {}) {
    this.users = options.users ?? ['root']
    this._allow = options.allow ?? []
    this._deny = options.deny ?? []
    this._maxFlows = options.maxFlows ?? 32
    this._idleMs = options.idleMs ?? 5 * 60_000
    this._resolve = options.resolve ?? defaultResolve
    this._resolveFamily = options.resolveFamily ?? (options.resolve ? async (host, family) => (await options.resolve!(host)).filter(address => isIP(address) === family) : defaultResolveFamily)
    this._connect = options.connect ?? ((address, port) => net.connect({ host: address, port, allowHalfOpen: true }))
    this._log = options.log ?? (() => {})
  }

  /**
   * The address to connect to for `host:port`, or why not. Every address the name resolves to is checked, and the
   * connection goes to a checked address itself, so a name that answers differently the second time cannot get past it.
   */
  async check(host: string, port: number): Promise<string> {
    const name = host.toLowerCase().replace(/\.$/, '')
    let addresses: string[]
    if (isIP(name)) addresses = [name]
    else {
      try { addresses = await this._resolve(name) } catch { throw new PeerError('refused', `could not resolve ${host}`) }
      if (addresses.length === 0) throw new PeerError('refused', `could not resolve ${host}`)
    }

    const denied = this._deny.find(rule => ruleMatches(rule, name, addresses, port))
    if (denied) throw new PeerError('refused', `${host}:${port} is denied by the gateway (${denied.text})`)

    // A blocked address is reachable only when a rule names an address range that holds it, not by a name that points there
    for (const address of addresses) {
      if (!Blocked.check(plain(address), family(plain(address)))) continue
      const named = this._allow.some(rule => !rule.name && inPorts(rule, port) && rule.addresses!.check(plain(address), family(plain(address))))
      if (!named) throw new PeerError('refused', `${host} is ${address}, which this gateway does not reach`)
    }

    if (this._allow.length > 0 && !this._allow.some(rule => ruleMatches(rule, name, addresses, port))) {
      throw new PeerError('refused', `${host}:${port} is not allowed by the gateway`)
    }
    return addresses[0]!
  }

  /**
   * The addresses of `host` this gateway is willing to hand to a guest. The guest then connects by address, and that is
   * checked again, so this is about not exposing this host's surroundings through names: an address in a blocked range is
   * left out unless a rule names an address range that holds it (a name rule never opens one), as is anything a deny rule
   * without ports covers. With allow rules, the name or one of its addresses must match one of them (ports are not known yet).
   */
  async lookup(host: string, family: 4 | 6): Promise<string[]> {
    const name = host.toLowerCase().replace(/\.$/, '')
    let addresses: string[]
    if (isIP(name)) addresses = isIP(name) === family ? [name] : []
    else {
      try { addresses = await this._resolveFamily(name, family) } catch { throw new PeerError('refused', `could not resolve ${host}`) }
    }
    if (addresses.length === 0) throw new PeerError('refused', `could not resolve ${host}`)

    const everywhere = (rule: Rule) => !rule.ports
    if (this._deny.some(rule => everywhere(rule) && ruleMatches(rule, name, addresses, 0))) throw new PeerError('refused', `${host} is denied by the gateway`)
    if (this._allow.length > 0 && !this._allow.some(rule => ruleMatches({ ...rule, ports: undefined }, name, addresses, 0))) throw new PeerError('refused', `${host} is not allowed by the gateway`)

    const reachable = addresses.filter(address => {
      const bare = plain(address)
      if (this._deny.some(rule => everywhere(rule) && !rule.name && rule.addresses!.check(bare, family === 4 ? 'ipv4' : 'ipv6'))) return false
      if (!Blocked.check(bare, family === 4 ? 'ipv4' : 'ipv6')) return true
      return this._allow.some(rule => !rule.name && rule.addresses!.check(bare, family === 4 ? 'ipv4' : 'ipv6'))
    })
    if (reachable.length === 0) throw new PeerError('refused', `${host} is ${addresses[0]}, which this gateway does not reach`)
    return reachable
  }

  /** Answers one lookup channel: the addresses in one message, then the channel closes */
  private async answer(channel: Channel, user: string): Promise<void> {
    const request = parseNetLookup(channel.params)
    try {
      const addresses = await this.lookup(request.name, request.family)
      this._log(`${user} lookup ${request.name} -> ${addresses.join(', ')}`)
      channel.send({ op: 'resolved', addresses })
      channel.close()
    } catch (error) {
      this._log(`${user} lookup ${request.name} refused: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  }

  /** Serves one `net` channel for `user`. Throwing refuses it. */
  async serve(connection: Connection, channel: Channel, user: string): Promise<void> {
    if (!this.users.includes(user)) throw new PeerError('refused', `${user} may not use this gateway`)
    if (channel.params && typeof channel.params === 'object' && !Array.isArray(channel.params) && !(channel.params instanceof Uint8Array) && channel.params['proto'] === 'dns') return this.answer(channel, user)
    const target = parseNetTarget(channel.params)
    const open = this._flows.get(connection) ?? 0
    if (open >= this._maxFlows) throw new PeerError('limit', `too many flows (${this._maxFlows})`)

    let address: string
    try { address = await this.check(target.host, target.port) } catch (error) {
      this._log(`${user} -> ${target.host}:${target.port} refused: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }

    this._flows.set(connection, open + 1)
    channel.manualCredit = true
    const socket = this._connect(address, target.port)
    let sent = 0
    let received = 0
    let finished = false
    const finish = (error?: PeerError) => {
      if (finished) return
      finished = true
      this._flows.set(connection, (this._flows.get(connection) ?? 1) - 1)
      this._log(`${user} -> ${target.host}:${target.port} closed (${received} bytes out, ${sent} in)`)
      clearTimeout(timer)
      socket.destroy()
      channel.close(error)
    }
    let timer = setTimeout(() => finish(new PeerError('timeout', 'idle')), this._idleMs)
    const alive = () => { clearTimeout(timer); timer = setTimeout(() => finish(new PeerError('timeout', 'idle')), this._idleMs) }

    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('error', error => reject(new PeerError('refused', `${target.host}:${target.port}: ${(error as NodeJS.ErrnoException).code ?? error.message}`)))
    }).catch(error => {
      this._log(`${user} -> ${target.host}:${target.port} failed: ${error.message}`)
      this._flows.set(connection, (this._flows.get(connection) ?? 1) - 1)
      finished = true
      clearTimeout(timer)
      socket.destroy()
      throw error
    })
    this._log(`${user} -> ${target.host}:${target.port} (${address}) opened`)
    socket.on('error', () => finish())

    channel.send({ op: 'connected', address, port: target.port })
    channel.onMessage = message => {
      if (message && typeof message === 'object' && !(message instanceof Uint8Array) && !Array.isArray(message) && message['op'] === 'eof') socket.end()
    }
    channel.onData = data => {
      received += data.length
      alive()
      socket.write(data, () => channel.grant(data.length))
    }
    socket.on('data', chunk => {
      sent += chunk.length
      alive()
      socket.pause()
      channel.write(chunk).then(() => socket.resume(), () => finish())
    })
    socket.on('end', () => { try { channel.send({ op: 'eof' }) } catch { /* already closed */ } })
    socket.on('close', () => finish())
    void channel.done.then(() => finish())
  }

  /** Registers this gateway's `net` channel on a connection whose login has been checked */
  attach(connection: Connection, user: string): void {
    connection.accept(NetChannel, channel => this.serve(connection, channel, user))
  }
}
