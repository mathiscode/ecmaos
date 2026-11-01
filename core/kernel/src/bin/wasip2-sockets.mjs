/**
 * `wasi:sockets` 0.2 for `wasip2.mjs`: tcp, udp and ip-name-lookup on the kernel's socket calls, the ones `wali-host.mjs`
 * makes `SYS_socket`, `SYS_connect` and the rest out of. A connection is a real descriptor, so a stream over it reads,
 * writes and polls like any other. 127.0.0.1, `::1` and a Unix-style listener in another program are reached through the
 * kernel (`sock_connect`); any other address goes through the gateway when `gateway up` made one (`sock_connect_out`).
 * start-connect and start-bind finish at once, and `finish-*` returns or throws what they found.
 */
import { syscall_raw, returned } from '@zenfs/linux/uapi/base'
import { callMainThread } from './wasi-common.mjs'

const AF_INET = 2, AF_INET6 = 10
const SOCK_STREAM = 1, SOCK_DGRAM = 2
const MSG_DONTWAIT = 0x40
const RECVFROM_HEADER = 24

/** Linux errno -> `wasi:sockets/network` error-code */
const NETWORK_ERROR = {
  13: 'access-denied', 11: 'would-block', 22: 'invalid-argument', 12: 'out-of-memory', 24: 'new-socket-limit',
  98: 'address-in-use', 99: 'address-not-bindable', 111: 'connection-refused', 104: 'connection-reset', 103: 'connection-aborted',
  101: 'remote-unreachable', 113: 'remote-unreachable', 110: 'timeout', 107: 'invalid-state', 97: 'not-supported',
  90: 'datagram-too-large', 106: 'invalid-state', 114: 'concurrency-conflict', 115: 'concurrency-conflict', 32: 'connection-reset',
}

/** Throws the 0.2 error-code for a negative errno a socket call answered with; returns the value otherwise */
const checked = value => {
  if (typeof value === 'number' && value < 0) throw NETWORK_ERROR[-value] ?? 'unknown'
  return value
}

const decoder = new TextDecoder()

// IP addresses: variants of the address bytes
const ipv4 = text => ({ tag: 'ipv4', val: text.split('.').map(Number) })
const ipv6 = text => {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(text)
  const bytes = mapped ? [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, ...mapped[1].split('.').map(Number)] : parseIpv6(text)
  const words = []
  for (let i = 0; i < 16; i += 2) words.push((bytes[i] << 8) | bytes[i + 1])
  return { tag: 'ipv6', val: words }
}
const ipFrom = text => text.includes(':') ? ipv6(text) : ipv4(text)

function parseIpv6(text) {
  const [head, tail] = text.split('::')
  const words = part => part ? part.split(':').map(word => parseInt(word, 16)) : []
  const left = words(head), right = tail === undefined ? [] : words(tail)
  const all = tail === undefined ? left : [...left, ...new Array(8 - left.length - right.length).fill(0), ...right]
  return all.flatMap(word => [word >> 8, word & 0xff])
}

const textOf = address => address.tag === 'ipv4'
  ? address.val.join('.')
  : address.val.map(word => word.toString(16)).join(':').replace(/(^|:)0(:0)+(:|$)/, '::').replace(/:{3,}/, '::')

const isLoopback = address => address.tag === 'ipv4'
  ? address.val[0] === 127 || address.val.every(byte => byte === 0)
  : address.val.slice(0, 7).every(word => word === 0) && (address.val[7] === 1 || address.val[7] === 0)
const isAny = address => address.val.every(part => part === 0)

const socketAddress = (address, port) => address.tag === 'ipv4'
  ? { tag: 'ipv4', val: { port, address: address.val } }
  : { tag: 'ipv6', val: { port, flowInfo: 0, address: address.val, scopeId: 0 } }

const familyOf = address => address.tag === 'ipv4' ? 'ipv4' : 'ipv6'

/** The listener name a connection to `address`:`port` reaches inside this machine, or undefined for one beyond it */
function listenerKey(address, port) {
  if (!isLoopback(address)) return undefined
  return address.tag === 'ipv4' ? `inet:127.0.0.1:${port}` : `inet6:${port}`
}

export function createSockets({ Pollable, InputStream, OutputStream, readSource, writeSink, POLLIN, POLLOUT }) {
  class Network {}
  const network = new Network()

  const fresh = (family, type) => {
    const fd = checked(syscall_raw('sock_open', 0, type === SOCK_DGRAM ? 1 : 0))
    // the kernel checks an address against the family it was told the socket has
    syscall_raw('sock_set', fd, JSON.stringify({ family: family === 'ipv4' ? AF_INET : AF_INET6, type }))
    return { fd, family, type, v6only: false, local: undefined, peer: undefined, state: 'unbound', error: undefined, listening: false, backlog: 128 }
  }

  /** The family the kernel claims the address under: an IPv6 socket takes IPv4 too unless v6-only */
  const claimFamily = socket => socket.family === 'ipv4' ? 'inet' : socket.v6only ? 'inet6' : 'inet46'

  const bind = (socket, address, port) => {
    if (familyOf(address) !== socket.family) throw 'invalid-argument'
    if (socket.state !== 'unbound') throw 'invalid-state'
    const bound = checked(syscall_raw('sock_bind', socket.fd, claimFamily(socket), textOf(address), port))
    socket.local = { address, port: bound }
    socket.state = 'bound'
  }

  class TcpSocket {
    constructor(family, socket = fresh(family, SOCK_STREAM)) { this.socket = socket }
    startBind(_network, local) {
      this.bindResult = (() => {
        try { bind(this.socket, { tag: local.tag, val: local.val.address }, local.val.port) } catch (error) { return error }
        return undefined
      })()
      this.bindStarted = true
    }
    finishBind() {
      if (!this.bindStarted) throw 'not-in-progress'
      this.bindStarted = false
      if (this.bindResult) throw this.bindResult
    }
    startConnect(_network, remote) {
      const { address, port } = remote.val
      const socket = this.socket
      const target = { tag: remote.tag, val: address }
      this.connectResult = (() => {
        if (socket.state === 'connected' || socket.state === 'listening') return 'invalid-state'
        if (isAny(target) || port === 0) return 'invalid-argument'
        if (socket.family === 'ipv4' && target.tag === 'ipv6' || socket.family === 'ipv6' && target.tag === 'ipv4' && socket.v6only) return 'invalid-argument'
        const key = listenerKey(target, port)
        const value = key ? syscall_raw('sock_connect', socket.fd, key) : syscall_raw('sock_connect_out', socket.fd, textOf(target), port)
        if (value < 0) return NETWORK_ERROR[-value] ?? 'unknown'
        socket.peer = { address: target, port }
        socket.state = 'connected'
        return undefined
      })()
      this.connectStarted = true
    }
    finishConnect() {
      if (!this.connectStarted) throw 'not-in-progress'
      this.connectStarted = false
      if (this.connectResult) throw this.connectResult
      const fd = this.socket.fd
      return [new InputStream(readSource(fd), fd), new OutputStream(writeSink(fd), fd)]
    }
    startListen() {
      const socket = this.socket
      if (socket.state === 'listening' || socket.state === 'connected') throw 'invalid-state'
      this.listenStarted = true
    }
    finishListen() {
      if (!this.listenStarted) throw 'not-in-progress'
      this.listenStarted = false
      const socket = this.socket
      // an Internet socket listening without a bind gets an ephemeral port, as on Linux
      if (socket.state === 'unbound') {
        const port = checked(syscall_raw('sock_bind', socket.fd, claimFamily(socket), '', 0))
        socket.local = { address: socket.family === 'ipv4' ? ipv4('0.0.0.0') : ipv6('::'), port }
        socket.state = 'bound'
      }
      checked(syscall_raw('sock_listen', socket.fd, socket.backlog))
      socket.state = 'listening'
    }
    accept() {
      const socket = this.socket
      if (socket.state !== 'listening') throw 'invalid-state'
      const made = syscall_raw('sock_accept', socket.fd, 1)
      if (made < 0) throw NETWORK_ERROR[-made] ?? 'unknown'
      const child = new TcpSocket(socket.family, { ...socket, fd: made, state: 'connected' })
      const info = syscall_raw('sock_info', made)
      if (info >= 0) {
        const peer = JSON.parse(decoder.decode(returned.slice(0, info))).peer
        if (peer?.addr) child.socket.peer = { address: ipFrom(peer.addr), port: peer.port }
      }
      return [child, new InputStream(readSource(made), made), new OutputStream(writeSink(made), made)]
    }
    localAddress() {
      const { local } = this.socket
      if (!local) throw 'invalid-state'
      return socketAddress(local.address, local.port)
    }
    remoteAddress() {
      const { peer } = this.socket
      if (!peer) throw 'invalid-state'
      return socketAddress(peer.address, peer.port)
    }
    isListening() { return this.socket.state === 'listening' }
    addressFamily() { return this.socket.family }
    setListenBacklogSize(size) {
      if (size === 0n) throw 'invalid-argument'
      if (this.socket.state === 'listening') throw 'not-supported'
      this.socket.backlog = Number(size)
    }
    keepAliveEnabled() { return false }
    setKeepAliveEnabled() {}
    keepAliveIdleTime() { return 7200000000000n }
    setKeepAliveIdleTime() {}
    keepAliveInterval() { return 75000000000n }
    setKeepAliveInterval() {}
    keepAliveCount() { return 9 }
    setKeepAliveCount() {}
    hopLimit() { return this.socket.hopLimit ?? 64 }
    setHopLimit(value) {
      if (value === 0) throw 'invalid-argument'
      this.socket.hopLimit = value
    }
    receiveBufferSize() { return this.socket.receiveBuffer ?? 65536n }
    setReceiveBufferSize(value) { this.socket.receiveBuffer = value }
    sendBufferSize() { return this.socket.sendBuffer ?? 65536n }
    setSendBufferSize(value) { this.socket.sendBuffer = value }
    subscribe() {
      const socket = this.socket
      // a listener is ready when a connection is queued; the rest of the operations here finish at once
      return socket.state === 'listening' ? new Pollable({ fd: socket.fd, events: POLLIN }) : new Pollable()
    }
    shutdown(how) {
      if (this.socket.state !== 'connected') throw 'invalid-state'
      checked(syscall_raw('sock_shutdown', this.socket.fd, how === 'receive' ? 0 : how === 'send' ? 1 : 2))
    }
    [Symbol.dispose]() { /* the descriptor closes with the process */ }
  }

  class UdpSocket {
    constructor(family) { this.socket = fresh(family, SOCK_DGRAM) }
    startBind(_network, local) {
      this.bindResult = (() => {
        try { bind(this.socket, { tag: local.tag, val: local.val.address }, local.val.port) } catch (error) { return error }
        return undefined
      })()
      this.bindStarted = true
    }
    finishBind() {
      if (!this.bindStarted) throw 'not-in-progress'
      this.bindStarted = false
      if (this.bindResult) throw this.bindResult
    }
    stream(remote) {
      const socket = this.socket
      if (socket.state === 'unbound') {
        // an unbound socket that sends claims an ephemeral port, as on Linux
        const port = checked(syscall_raw('sock_bind', socket.fd, claimFamily(socket), '', 0))
        socket.local = { address: socket.family === 'ipv4' ? ipv4('0.0.0.0') : ipv6('::'), port }
        socket.state = 'bound'
      }
      if (remote) {
        const address = { tag: remote.tag, val: remote.val.address }
        checked(syscall_raw('sock_peer', socket.fd, textOf(address), remote.val.port))
        socket.peer = { address, port: remote.val.port }
      } else {
        syscall_raw('sock_peer', socket.fd, '', 0)
        socket.peer = undefined
      }
      return [new IncomingDatagramStream(socket), new OutgoingDatagramStream(socket)]
    }
    localAddress() {
      const { local } = this.socket
      if (!local) throw 'invalid-state'
      return socketAddress(local.address, local.port)
    }
    remoteAddress() {
      const { peer } = this.socket
      if (!peer) throw 'invalid-state'
      return socketAddress(peer.address, peer.port)
    }
    addressFamily() { return this.socket.family }
    unicastHopLimit() { return this.socket.hopLimit ?? 64 }
    setUnicastHopLimit(value) {
      if (value === 0) throw 'invalid-argument'
      this.socket.hopLimit = value
    }
    receiveBufferSize() { return this.socket.receiveBuffer ?? 65536n }
    setReceiveBufferSize(value) { this.socket.receiveBuffer = value }
    sendBufferSize() { return this.socket.sendBuffer ?? 65536n }
    setSendBufferSize(value) { this.socket.sendBuffer = value }
    subscribe() { return new Pollable() }
    [Symbol.dispose]() { /* the descriptor closes with the process */ }
  }

  class IncomingDatagramStream {
    constructor(socket) { this.socket = socket }
    receive(max) {
      const datagrams = []
      for (let i = 0n; i < max; i++) {
        const value = syscall_raw('sock_recvfrom', this.socket.fd, 65536, MSG_DONTWAIT)
        if (value < 0) {
          if (-value === 11 && datagrams.length === 0) break
          if (-value === 11) break
          throw NETWORK_ERROR[-value] ?? 'unknown'
        }
        const answer = new DataView(returned.buffer, returned.byteOffset)
        const data = returned.slice(RECVFROM_HEADER, value)
        if (!returned[6]) break
        const raw = returned.slice(8, 24)
        const words = []
        for (let j = 0; j < 16; j += 2) words.push((raw[j] << 8) | raw[j + 1])
        const mapped = words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff
        const address = mapped || this.socket.family === 'ipv4' ? { tag: 'ipv4', val: [...raw.subarray(12)] } : { tag: 'ipv6', val: words }
        datagrams.push({ data, remoteAddress: socketAddress(address, answer.getUint16(4, false)) })
      }
      return datagrams
    }
    subscribe() { return new Pollable({ fd: this.socket.fd, events: POLLIN }) }
    [Symbol.dispose]() {}
  }

  class OutgoingDatagramStream {
    constructor(socket) { this.socket = socket }
    checkSend() { return 64n }
    send(datagrams) {
      let sent = 0n
      for (const { data, remoteAddress } of datagrams) {
        if (remoteAddress) {
          const address = { tag: remoteAddress.tag, val: remoteAddress.val.address }
          checked(syscall_raw('sock_sendto', this.socket.fd, data, remoteAddress.tag === 'ipv4' ? AF_INET : AF_INET6, textOf(address), remoteAddress.val.port, MSG_DONTWAIT))
        } else {
          checked(syscall_raw('sock_send', this.socket.fd, data, MSG_DONTWAIT))
        }
        sent++
      }
      return sent
    }
    subscribe() { return new Pollable({ fd: this.socket.fd, events: POLLOUT }) }
    [Symbol.dispose]() {}
  }

  class ResolveAddressStream {
    constructor(addresses) { this.addresses = addresses }
    resolveNextAddress() { return this.addresses.shift() }
    subscribe() { return new Pollable() }
    [Symbol.dispose]() {}
  }

  /** `localhost`, a literal address, or whatever `/etc/hosts` and then the gateway's resolver say */
  const resolve = name => {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) return [ipv4(name)]
    if (name.includes(':')) {
      try { return [ipv6(name)] } catch { throw 'invalid-argument' }
    }
    if (name === '' || /[\s/]/.test(name)) throw 'invalid-argument'
    const found = []
    let failure
    for (const wanted of [4, 6]) {
      const result = callMainThread('dns_lookup', name, wanted)
      if (result.error) failure ??= result.error === 'AGAIN' ? 'temporary-resolver-failure' : 'name-unresolvable'
      else found.push(...result.addresses.map(ipFrom))
    }
    if (!found.length) throw failure ?? 'name-unresolvable'
    return found
  }

  return {
    'wasi:sockets/network': { Network, ErrorCode: undefined },
    'wasi:sockets/instance-network': { instanceNetwork: () => network },
    'wasi:sockets/ip-name-lookup': { ResolveAddressStream, resolveAddresses: (_network, name) => new ResolveAddressStream(resolve(name)) },
    'wasi:sockets/tcp': { TcpSocket },
    'wasi:sockets/tcp-create-socket': { createTcpSocket: family => new TcpSocket(family) },
    'wasi:sockets/udp': { UdpSocket, IncomingDatagramStream, OutgoingDatagramStream },
    'wasi:sockets/udp-create-socket': { createUdpSocket: family => new UdpSocket(family) },
  }
}
