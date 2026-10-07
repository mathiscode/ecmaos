import { awaitShared, Connection, DeviceChannel, DeviceError, DeviceShareChannel, FsError, loopbackSession, PeerError, RemoteDevice, serveDevice } from '@ecmaos/peer'
import type { DeviceInfo, DeviceSession, Value } from '@ecmaos/peer'
import { openSerialSession } from '@ecmaos-devices/serial'
import { char_dev, Class, current as zenfsCurrent, Device, EPOLLIN, EPOLLOUT, WaitQueue } from '@zenfs/linux'
import type { FileOperations } from '@zenfs/linux'
import { withErrno } from 'kerium'

import type { Shell } from '@ecmaos/types'

import type { Kernel } from '#kernel.ts'

import type { Outcome, OutcomeLine } from './outcome.ts'
import { dialPeer, parseRemoteSource, RemoteMountFailure } from './remote-mount.ts'
import { getCachedManifest } from './syscall-policy.ts'

/** A device of another machine, present here as `/dev/<name>` */
export interface AttachedDevice {
  name: string
  host: string
  info: DeviceInfo
  remote: RemoteDevice
  minor: number
  device: Device
  /** Ends the link this device came over (a connection this machine made, or the channel a machine offered it on) */
  close(): void
}

interface Registry {
  major?: number
  nextMinor: number
  byMinor: Map<number, AttachedDevice>
  byName: Map<string, AttachedDevice>
  queues: Map<number, WaitQueue>
}

const registries = new WeakMap<Kernel, Registry>()
const registry = (kernel: Kernel) => {
  let state = registries.get(kernel)
  if (!state) registries.set(kernel, state = { nextMinor: 0, byMinor: new Map(), byName: new Map(), queues: new Map() })
  return state
}

/** `/sys/class/remote` */
let remoteClass: Class | undefined

export const deviceNamePattern = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/

/** What a process with a manifest listing `devices` may open; the same rule the built-in devices follow */
function allowed(name: string) {
  const exe = zenfsCurrent?.exe
  const list = exe ? getCachedManifest(exe)?.devices : undefined
  return !list || list.includes(name) || list.includes('remote')
}

function operations(state: Registry): FileOperations {
  const entry = (file: { devt: { minor: number } }) => {
    const found = state.byMinor.get(file.devt.minor)
    if (!found) throw withErrno('ENODEV')
    if (!allowed(found.name)) throw withErrno('EPERM')
    return found
  }
  return {
    open: file => { if (entry(file).remote.closed) throw withErrno('ENODEV') },
    read: (file, buffer, start, end) => {
      const found = entry(file)
      if (!found.info.read) throw withErrno('EBADF', 'this device cannot be read')
      // A device that has gone reads as the end of a file, once what it sent has been taken
      return found.remote.take(buffer.subarray(start, end))
    },
    write: (file, buffer, offset) => {
      const found = entry(file)
      if (!found.info.write) throw withErrno('EBADF', 'this device cannot be written to')
      const data = buffer.subarray(offset)
      if (data.length === 0) return 0
      try {
        const count = found.remote.write(data)
        if (count === 0) throw withErrno('EAGAIN')
        return count
      } catch (error) {
        if (error instanceof DeviceError) throw withErrno('ENODEV', error.message)
        throw error
      }
    },
    poll: file => {
      const found = state.byMinor.get(file.devt.minor)
      if (!found) return EPOLLIN | EPOLLOUT
      let events = 0
      // Gone is ready: a read gets the end of the file and a write its error, instead of sleeping for ever
      if (found.remote.closed || found.remote.available > 0) events |= EPOLLIN
      if (found.remote.closed || found.remote.writable > 0) events |= EPOLLOUT
      return events
    },
    poll_wait: file => state.queues.get(file.devt.minor)
  }
}

export interface RegisterOptions {
  name: string
  remote: RemoteDevice
  info: DeviceInfo
  host: string
  close(): void
}

/** Makes `/dev/<name>` for a device of another machine; it lasts as long as the channel does */
export function registerRemoteDevice(kernel: Kernel, options: RegisterOptions): AttachedDevice {
  if (!deviceNamePattern.test(options.name)) throw new RemoteMountFailure('a device name starts with a letter and may hold letters, digits, dashes and underscores')
  const state = registry(kernel)
  if (state.byName.has(options.name)) throw new RemoteMountFailure(`${options.name} is already attached`)

  state.major ??= char_dev.register(0, 'ecmaos-remote', operations(state))
  const minor = state.nextMinor++
  remoteClass ??= new Class('remote')
  const device = new Device({ name: options.name, class: remoteClass, dev_t: { major: state.major, minor } })
  try { device.register() } catch { throw new RemoteMountFailure(`/dev/${options.name} already exists`) }

  const { remote } = options
  const queue = new WaitQueue()
  state.queues.set(minor, queue)
  const attached: AttachedDevice = { name: options.name, host: options.host, info: options.info, remote, minor, device, close: options.close }
  state.byMinor.set(minor, attached)
  state.byName.set(options.name, attached)
  remote.onChange = () => queue.wake_up()
  remote.onEvent = (event, data) => kernel.events.emit('device:remote', { name: options.name, event, data })

  void remote.channel.done.then(() => {
    if (state.byName.get(options.name) !== attached) return
    state.byName.delete(options.name)
    state.byMinor.delete(minor)
    try { device.unregister() } catch { /* already gone */ }
    queue.wake_up()
    state.queues.delete(minor)
    options.close()
  })
  return attached
}

export interface AttachOptions {
  /** The name of the device on the other machine */
  device: string
  /** The node it gets here, `/dev/<name>` */
  name: string
  password: string
  pairingCode?: string
  fingerprint?: string
  acceptNew?: boolean
  source: NonNullable<ReturnType<typeof parseRemoteSource>>
}

/** Logs in to another machine, opens one of its devices and makes `/dev/<name>` for it */
export async function attachDevice(kernel: Kernel, shell: Shell, options: AttachOptions): Promise<AttachedDevice> {
  if (!deviceNamePattern.test(options.name)) throw new RemoteMountFailure('a device name starts with a letter and may hold letters, digits, dashes and underscores')
  if (registry(kernel).byName.has(options.name)) throw new RemoteMountFailure(`${options.name} is already attached`)

  const connection = await dialPeer(kernel, shell, options)
  try {
    const channel = await connection.open(DeviceChannel, { params: { device: options.device }, timeout: 20_000 })
    const remote = new RemoteDevice(channel)
    const info = await remote.info()
    const attached = registerRemoteDevice(kernel, { name: options.name, remote, info, host: `${options.source.host}:${options.source.port}`, close: () => connection.close() })
    void connection.done.then(() => channel.close())
    return attached
  } catch (error) {
    connection.close()
    throw error
  }
}

/** A device of this machine offered to another one, which makes a node for it */
export interface ServedDevice {
  name: string
  spec: string
  host: string
  connection: Connection
}

const served = new WeakMap<Kernel, Map<string, ServedDevice>>()
const servedRegistry = (kernel: Kernel) => { let map = served.get(kernel); if (!map) served.set(kernel, map = new Map()); return map }

/**
 * What `attach -s` can offer: `loopback`, or `serial:N[,baud=RATE]` for the Nth port this browser has been given access to
 * (`serial request`). The port is opened here, once the other machine accepts.
 */
export async function openLocalDevice(spec: string): Promise<DeviceSession> {
  if (spec === 'loopback') return loopbackSession()
  const match = /^serial:(\d+)((?:,[a-z]+=[A-Za-z0-9]+)*)$/.exec(spec)
  if (!match) throw new RemoteMountFailure(`unknown device '${spec}' (use loopback or serial:N[,baud=RATE])`)
  const serial = (globalThis as { navigator?: { serial?: { getPorts(): Promise<Array<Parameters<typeof openSerialSession>[0]>> } } }).navigator?.serial
  if (!serial) throw new RemoteMountFailure('this machine has no Web Serial')
  const port = (await serial.getPorts())[Number(match[1])]
  if (!port) throw new RemoteMountFailure(`no serial port ${match[1]} (see 'serial devices'; 'serial request' asks for one)`)
  const options: Record<string, string> = Object.fromEntries((match[2] ?? '').split(',').filter(Boolean).map(part => part.split('=') as [string, string]))
  const baudRate = options['baud'] === undefined ? undefined : Number(options['baud'])
  return await openSerialSession(port, baudRate === undefined ? {} : { baudRate }) as unknown as DeviceSession
}

export interface ServeOptions extends Omit<AttachOptions, 'device'> {
  /** What to offer: see `openLocalDevice` */
  spec: string
}

/** Logs in to another machine and offers it a device of this one as `/dev/<name>` there. Root only there. */
export async function serveLocalDevice(kernel: Kernel, shell: Shell, options: ServeOptions): Promise<ServedDevice> {
  if (!deviceNamePattern.test(options.name)) throw new RemoteMountFailure('a device name starts with a letter and may hold letters, digits, dashes and underscores')
  if (servedRegistry(kernel).has(options.name)) throw new RemoteMountFailure(`${options.name} is already being offered`)
  const session = await openLocalDevice(options.spec)
  let connection: Connection | undefined
  try {
    connection = await dialPeer(kernel, shell, options)
    // The description travels with the request: the other machine makes its node (or refuses) before it accepts
    const channel = await connection.open(DeviceShareChannel, { params: { name: options.name, info: session.info }, timeout: 20_000 })
    await awaitShared(channel)
    serveDevice(channel, session)
    const item: ServedDevice = { name: options.name, spec: options.spec, host: `${options.source.host}:${options.source.port}`, connection }
    servedRegistry(kernel).set(options.name, item)
    const link = connection
    const forget = () => { if (servedRegistry(kernel).get(options.name) === item) servedRegistry(kernel).delete(options.name); link.close() }
    void channel.done.then(forget)
    void link.done.then(forget)
    return item
  } catch (error) {
    connection?.close()
    void Promise.resolve(session.close()).catch(() => {})
    throw error
  }
}

export function listAttached(kernel: Kernel): AttachedDevice[] { return [...registry(kernel).byName.values()] }

export function listServed(kernel: Kernel): ServedDevice[] { return [...servedRegistry(kernel).values()] }

export function detachDevice(kernel: Kernel, name: string): boolean {
  const offered = servedRegistry(kernel).get(name)
  if (offered) {
    servedRegistry(kernel).delete(name)
    offered.connection.close()
    return true
  }
  const attached = registry(kernel).byName.get(name)
  if (!attached) return false
  attached.remote.close()
  attached.close()
  return true
}

export function controlAttached(kernel: Kernel, name: string, op: string, args: Value[]): Promise<Value> {
  const attached = registry(kernel).byName.get(name)
  if (!attached) return Promise.reject(new RemoteMountFailure(`${name} is not attached`))
  return attached.remote.control(op, ...args)
}

export type AttachRequest =
  | { action: 'list' }
  | { action: 'detach', name: string }
  | { action: 'control', name: string, op: string, args: Value[] }
  | { action: 'attach', target: string, name?: string, options: Record<string, string> }
  | { action: 'serve', target: string, name: string, spec: string, options: Record<string, string> }

/** `attach`: what the command asks for, as lines to print and an exit code */
export async function manageAttach(kernel: Kernel, shell: Shell, request: AttachRequest): Promise<Outcome> {
  const lines: OutcomeLine[] = []
  const out = (text: string) => lines.push({ stream: 'out', text })
  const err = (text: string) => lines.push({ stream: 'err', text })

  if (request.action === 'list') {
    const all = listAttached(kernel)
    const offered = listServed(kernel)
    if (all.length === 0 && offered.length === 0) out('No devices are attached.')
    for (const item of all) {
      const how = `${item.info.read ? 'r' : '-'}${item.info.write ? 'w' : '-'}`
      out(`/dev/${item.name.padEnd(16)} ${String(item.info.kind).padEnd(10)} ${how}  from ${item.host}`)
    }
    for (const item of offered) out(`${item.name.padEnd(21)} ${item.spec.padEnd(10)}     offered to ${item.host}`)
    return { code: 0, lines }
  }
  if (request.action === 'detach') {
    if (!detachDevice(kernel, request.name)) { err(`attach: ${request.name} is not attached`); return { code: 1, lines } }
    out(`Detached ${request.name}`)
    return { code: 0, lines }
  }
  if (request.action === 'control') {
    try {
      out(JSON.stringify(await controlAttached(kernel, request.name, request.op, request.args)))
      return { code: 0, lines }
    } catch (error) {
      err(`attach: ${error instanceof Error ? error.message : String(error)}`)
      return { code: 1, lines }
    }
  }

  if (request.action === 'serve') {
    try {
      const source = parseRemoteSource(request.target, shell.env.get('USER') || 'root')
      if (!source || source.name) throw new RemoteMountFailure('the machine is [user@]host[:port]')
      const options = request.options
      if (!options['password']) throw new RemoteMountFailure('a password is needed to unlock your key')
      const item = await serveLocalDevice(kernel, shell, {
        source, spec: request.spec, name: request.name, password: options['password'],
        pairingCode: options['pair'], fingerprint: options['fingerprint'], acceptNew: options['accept-new'] === 'yes' || options['accept-new'] === 'true'
      })
      out(`Offering ${item.spec} to ${item.host} as ${item.name}`)
      return { code: 0, lines }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const known = error instanceof RemoteMountFailure || error instanceof PeerError || (error instanceof Error && 'code' in error)
      err(`attach: ${known ? message : `failed: ${message}`}`)
      return { code: 1, lines }
    }
  }

  try {
    const source = parseRemoteSource(request.target, shell.env.get('USER') || 'root')
    if (!source || !source.name) throw new RemoteMountFailure('name the device: [user@]host[:port]/DEVICE')
    const options = request.options
    if (!options['password']) throw new RemoteMountFailure('a password is needed to unlock your key')
    const attached = await attachDevice(kernel, shell, {
      source,
      device: source.name,
      name: request.name ?? source.name,
      password: options['password'],
      pairingCode: options['pair'],
      fingerprint: options['fingerprint'],
      acceptNew: options['accept-new'] === 'yes' || options['accept-new'] === 'true'
    })
    out(`Attached ${source.name} from ${attached.host} as /dev/${attached.name} (${attached.info.kind}, ${attached.info.read ? 'read' : ''}${attached.info.read && attached.info.write ? '/' : ''}${attached.info.write ? 'write' : ''})`)
    return { code: 0, lines }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const known = error instanceof RemoteMountFailure || error instanceof PeerError || error instanceof FsError || (error instanceof Error && 'code' in error)
    err(`attach: ${known ? message : `failed: ${message}`}`)
    return { code: 1, lines }
  }
}
