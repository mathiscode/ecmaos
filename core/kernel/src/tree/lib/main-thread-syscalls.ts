/**
 * Custom syscalls that cross from a worker-hosted `@zenfs/linux` `Process` to the main thread, for capabilities that
 * only exist there (DOM windows, Web Bluetooth, the Battery API, kernel singletons).
 * `define_syscall` registers a typed handler per capability; `kernelOf(proc)` resolves which `Kernel` a process
 * belongs to, since the syscall table is module-global.
 * A syscall returns a number or negative errno, so handlers return small integer handles rather than objects, and
 * larger results are written to a scratch file.
 */

import { binfmts, define_syscall, kill as zenfsKill, processes, Process as ZenFSProcess, syscalls, thread_of, type BinFmt, type Process } from '@zenfs/linux'
import { attach, countWritten, createSocket, deliverDatagram, describe, receive, receiveDatagram, receiveRights, rightsFromPeer, send, sendDatagram, sendRights, shutdown, socketAt, sweepSockets, whenPending, type Socket } from './socket-files.ts'
import { createPipe } from './pipe-reaper.ts'
import { Errno } from 'kerium'

import { boundContexts, mounts } from '@zenfs/core'
import { O_DIRECTORY, S_IFSOCK } from '@zenfs/core/constants'
import type { Credentials } from '@zenfs/core'
import type { Kernel } from '#kernel.ts'
import { listMounts, mountFilesystem, type MountRequest } from './mount-backends.ts'
import { isMachineStore, MachineKeyPrefix, machineStore } from './machine.ts'
import { manageAttach, type AttachRequest } from './remote-device.ts'
import { gatewayLink, GatewayFailure, LookupFailure, manageGateway, openGatewayFlow, resolveHostname, setDatagramSink, setInboundSink, setLocalProbe, type GatewayRequest } from './remote-gateway.ts'
import { bindUdpPort, boundUdpPorts, FrameHeader, frameOf, udpPortAt } from './udp-ports.ts'
import { setNetSource, socketInode } from './proc-extras.ts'
import { formatEndpoint, parseEndpoint } from '@ecmaos/peer'
import { canonicalIp, formatIp, isIPv6, isLoopbackIp } from './ip.ts'
import { heldInMemory, totalHeld } from './memory-usage.ts'
import { changeIds } from './process-credentials.ts'
import { quotaLimit, quotaLimits, quotaUsage } from './quota.ts'
import { currentStorageLimits } from './storage-limits.ts'
import { manageShare, type ShareRequest } from './remote-share.ts'
import { startDeviceCli, waitDeviceCli } from './device-cli.ts'
import { installFdLinks } from './fd-links.ts'
import { installPipeWakeup } from './pipe-wakeup.ts'
import { installBusyRetry } from './busy-retry.ts'
import { installNotDirectory } from './not-directory.ts'
import { installThreads, leaderOf } from './wali-threads.ts'
import { installWaliSignals } from './wali-signals.ts'
import { installSysvIpc } from './sysv-ipc.ts'
import { installRecordLocks } from './record-locks.ts'
import { installPtys, ptyIndexOf, ptySlaveOf } from './pty.ts'
import { installDeviceHolds } from './device-holds.ts'
import { FbMajor, framebufferAt, installFbSeek } from './fb.ts'
import { installSharedRandom } from './shared-random.ts'
import { createTracer, finishTrace, tracerOf, traceProcess, untraceProcess } from './syscall-trace.ts'
import type { TraceOptions } from './syscall-trace.ts'
import { dropControllingTty, getpgid, getsid, installGroupExit, installStops, killpg, mayKill, setControllingTty, setpgid, setSignalState, setsid, signalStateOf, ttySession, spawnWithFds, ttyHoldOf, waitpid } from './job-control.ts'
import type { SignalState } from './job-control.ts'
import { umaskOf, setUmask } from './umask-store.ts'
import { managePasskey } from './passkey-manage.ts'
import type { Outcome } from './outcome.ts'
import { hostPresenters, presenters, type Presented } from './presenters/index.ts'
import { remoteKinds } from './presenters/remote.ts'
import type { Shell, SocketConnection } from '@ecmaos/types'

// Declaration merging into `@zenfs/linux`'s `Syscalls` interface, so `define_syscall` accepts these names.
declare module '@zenfs/linux/uapi/abi' {
  interface Syscalls {
    window_create(title: string): number
    fb_create(width: number, height: number, title: string, resizable?: number): number
    window_write(handle: number, text: string): number
    window_close(handle: number): number
    window_list(path: string): number
    wm_control(id: string, action: string, a: number, b: number, text: string): number
    wm_workspace(action: string, n: number, path: string): number
    window_focus(handle: number): number
    window_move(handle: number, x: number, y: number): number
    window_resize(handle: number, width: number, height: number): number
    window_set_title(handle: number, title: string): number
    window_present(kind: string, paramsJson: string, path: string): number
    storage_usage(path: string): number
    quota_report(argsJson: string, path: string): number
    klog(level: string, message: string): number
    reboot(): number
    fs_chmod(path: string, mode: number): number
    fs_chown(path: string, uid: number, gid: number): number
    users_lookup(query: string, path: string): number
    tty_get(): number
    tty_switch(ttyNumber: number): number
    sockets_list(path: string): number
    sockets_create(url: string, type: string, protocols: string, path: string): number
    sockets_close(id: string, path: string): number
    sockets_connect(url: string, type: string, protocols: string, path: string): number
    sockets_result(id: string, path: string): number
    sockets_show(id: string, path: string): number
    users_manage(action: string, argsJson: string, path: string): number
    fs_umount(target: string, path: string): number
    fs_mount(argsJson: string, path: string): number
    peer_share(argsJson: string, path: string): number
    peer_attach(argsJson: string, path: string): number
    gateway_ctl(argsJson: string, path: string): number
    auth_passkey(argsJson: string, path: string): number
    screensaver_start(): number
    screensaver_run(name: string, set: number, path: string): number
    users_chsh(username: string, shellValue: string, path: string): number
    users_password(oldPassword: string, newPassword: string, path: string): number
    users_sign(password: string, dataBase64: string, path: string): number
    users_authenticate(username: string, password: string): number
    credentials_supported(): number
    proc_umask(mask: number): number
    proc_file_limit(): number
    kernel_info(path: string): number
    device_cli_start(name: string, argsJson: string, path: string): number
    device_cli_wait(): number
    dom_toast(kind: string, message: string): number
    shell_set_theme(theme: string): number
    proc_spawn(command: string, argvJson: string, cwd: string, optionsJson?: string): number
    trace_attach(pid: number, optionsJson: string): number
    proc_waitpid(pid: number, flags: number): number
    proc_sigstate(which: number): number
    proc_set_sigstate(ignored: number, blocked: number): number
    proc_setids(group: number, how: number, a: number, b: number, c: number): number
    proc_getids(group: number): number
    proc_getgroups(): number
    proc_setgroups(ids: Uint8Array): number
    proc_setpgid(pid: number, pgid: number): number
    proc_getpgid(pid: number): number
    proc_killpg(pgid: number, signal: number): number
    proc_tcsetpgrp(pid: number): number
    proc_setsid(): number
    proc_getsid(pid: number): number
    proc_ctty(op: number, fd: number, arg: number): number
    proc_wait(pid: number): number
    proc_kill(pid: number, signal: number): number
    fs_utimes(path: string, atime: number, mtime: number, noFollow?: number): number
    shell_exec(command: string): number
    init_wait(timeoutMs: number): number
    init_booted(): number
    init_script(path: string, argsJson: string): number
    init_killall(signal: number): number
    init_alive(): number
    system_stop(mode: string): number
    login_begin(tty: number, username: string): number
    login_session(tty: number, username: string, password: string, path: string): number
    login_end(tty: number): number
    system_ready(): number
    login_builtin(tty: number): number
    terminal_clear_history(): number
    terminal_reload_history(): number
    system_format(argsJson: string, path: string): number
    net_bind(family: string, addr: string, port: number, path: string): number
    net_udp_bind(addr: string, port: number, path: string): number
    net_gateway_up(path: string): number
    net_listen(key: string, backlog: number, path: string): number
    net_connect(key: string, path: string): number
    net_connect_out(host: string, port: number, proto: string, path: string): number
    dns_lookup(name: string, family: number, path: string): number
    net_accept(key: string, nonblock: number, path: string): number
    net_pending(key: string, path: string): number
    scm_send(conn: number, dir: string, offset: number, length: number, items: string, path: string): number
    scm_take(conn: number, dir: string, rx: number, max: number, room: number, hint: number, path: string): number
    scm_cred(conn: number, dir: string, path: string): number
    sock_open(flags: number, datagram?: number): number
    sock_peer(fd: number, addr: string, port: number): number
    sock_sendto(fd: number, data: Uint8Array, family: number, addr: string, port: number, flags: number): number
    sock_recvfrom(fd: number, count: number, flags: number): number
    sock_sendmsg(fd: number, data: Uint8Array, fds: string, flags: number): number
    sock_recvmsg(fd: number, count: number, flags: number, room: number): number
    sock_bind(fd: number, family: string, addr: string, port: number): number
    sock_listen(fd: number, backlog: number): number
    sock_accept(fd: number, flags: number): number
    sock_connect(fd: number, key: string): number
    sock_connect_out(fd: number, host: string, port: number): number
    sock_pair(flags: number): number
    sock_shutdown(fd: number, how: number): number
    sock_info(fd: number): number
    sock_set(fd: number, info: string): number
    sock_recv(fd: number, count: number, flags: number): number
    sock_send(fd: number, data: Uint8Array, flags: number): number
    fd_getfl(fd: number): number
    fd_setfl(fd: number, flags: number): number
  }
}

/** Which `Kernel` owns a given real `Process` - set once, at the one real `execve` call site. */
const kernelOfProcess = new WeakMap<Process, Kernel>()

/**
 * Which `Shell` spawned a given real `Process` - needed alongside `kernelOfProcess` only by
 * `users_lookup` (see its own doc comment), for the *calling* process's own uid/gid/groups; every
 * other syscall in this module only ever needs the `Kernel`.
 */
const shellOfProcess = new WeakMap<Process, Shell>()

export function registerProcessKernel(proc: Process, kernel: Kernel, shell?: Shell): void {
  kernelOfProcess.set(proc, kernel)
  if (shell) shellOfProcess.set(proc, shell)
}

/**
 * Hands a handler's result to the caller through the scratch file it named. The file is given to the caller (mode
 * 0600) so it can delete it from the sticky `/tmp`.
 */
async function writeScratch(kernel: Kernel, proc: Process, path: string, text: string): Promise<void> {
  await kernel.filesystem.fs.writeFile(path, text, { mode: 0o600 })
  const { euid, egid } = proc.context.credentials
  if (euid !== 0) await kernel.filesystem.fs.chown(path, euid, egid)
}

/**
 * `#!ecmaos:bin:app:<name>` and `#!ecmaos:bin:program:<name>` files run under `/bin/app`, as the kernel's own shell runs
 * them, so a program started with `execve` (from `ecmash`, say) runs them too. It goes ahead of the `#!` format, which
 * would take the header for an interpreter path.
 */
function installEcmaosBinfmt(): void {
  const format: BinFmt = {
    name: 'ecmaos-app',
    matches: ({ buf }) => /^#!ecmaos:bin:(app|program):/.test(new TextDecoder().decode(buf.subarray(0, 64))),
    load(prm) {
      prm.argv = ['/bin/app', prm.filename, ...prm.argv.slice(1)]
      prm.filename = '/bin/app'
    }
  }
  const others = [...binfmts]
  binfmts.clear()
  for (const fmt of [format, ...others]) binfmts.add(fmt)
}

/** `tty_get` reports a pty as this plus its number, clear of the eight ttys */
const PtyBase = 1000

/** The tty a process is on, or `undefined` when it has none */
function ttyNumberOf(kernel: Kernel, proc: Process): number | undefined {
  if (proc.tty) for (const [number, shell] of kernel.shells) if (shell.terminal.zfsTty === proc.tty) return number
  return undefined
}

/** A WALI program's thread answers to its process's kernel and shell */
function kernelOf(proc: Process): Kernel {
  const kernel = kernelOfProcess.get(proc) ?? kernelOfProcess.get(leaderOf(proc))
  if (!kernel) throw Object.assign(new Error('No kernel registered for this process'), { errno: Errno.ENOSYS })
  return kernel
}

function shellOf(proc: Process): Shell | undefined {
  return shellOfProcess.get(proc) ?? shellOfProcess.get(leaderOf(proc))
}

/** The errno an error carries, else EIO */
function errnoOf(error: unknown): number {
  const errno = (error as { errno?: unknown } | undefined)?.errno
  return typeof errno === 'number' && errno > 0 ? errno : Errno.EIO
}

/**
 * The credentials a program acts with: its own when programs run as the user, else its shell's (everything runs as
 * root then).
 */
function identityOf(proc: Process): Credentials {
  const shell = shellOf(proc)
  if (kernelOf(proc).programsRunAsUser || !shell) return proc.context.credentials
  return shell.credentials
}

/** A program's credentials as the other end of a connection sees them: its process (a thread's leader), user and group */
function credentialsOf(proc: Process): PeerCredentials {
  const identity = identityOf(proc)
  return { pid: leaderOf(proc).pid, uid: identity.uid, gid: identity.gid }
}

/**
 * Whether the calling process itself is privileged: what init, getty, login and crond are, and a user's program is
 * not.
 */
function processIsRoot(proc: Process): boolean {
  return proc.context.credentials.euid === 0
}

/** Refuses a caller that is not a root process, for what only the system may do. */
function requireRoot(proc: Process, what: string): void {
  if (!processIsRoot(proc)) throw Object.assign(new Error(`${what}: Operation not permitted`), { errno: Errno.EPERM })
}

/**
 * What a file's metadata says, looked up as the caller, so a directory it may not search is refused as it would be
 * for the caller.
 */
async function statAsCaller(proc: Process, path: string): Promise<{ uid: number, gid: number }> {
  const bound = boundContexts.get(proc.context.id)
  if (!bound) throw Object.assign(new Error('Operation not permitted'), { errno: Errno.EPERM })
  const info = await bound.fs.promises.stat(path)
  return { uid: Number(info.uid), gid: Number(info.gid) }
}

/** `statAsCaller` that does not follow a final symlink. */
async function lstatAsCaller(proc: Process, path: string): Promise<{ uid: number, gid: number }> {
  const bound = boundContexts.get(proc.context.id)
  if (!bound) throw Object.assign(new Error('Operation not permitted'), { errno: Errno.EPERM })
  const info = await bound.fs.promises.lstat(path)
  return { uid: Number(info.uid), gid: Number(info.gid) }
}

/** Removes a directory tree, as `userdel -r` removes a home directory. */
async function removeTree(kernel: Kernel, path: string): Promise<void> {
  const fs = kernel.filesystem.fs
  const info = await fs.lstat(path)
  if (info.isDirectory()) {
    for (const entry of await fs.readdir(path)) await removeTree(kernel, `${path}/${entry}`)
    await fs.rmdir(path)
  } else await fs.unlink(path)
}

/** What `sockets_connect` learned about how each connection ended, until `sockets_result` collects it. */
interface SocketResult { opened: boolean, messages: number, code?: number, reason?: string }
const socketResults = new Map<string, SocketResult>()

/**
 * A loopback POSIX socket listener (`net_bind`, `net_listen`, `net_connect`, `net_accept`). `key` is the address
 * (`unix:<path>` or `inet:<host>:<port>`, host normalized to `127.0.0.1`). `queue` holds a connected pair for each
 * pending connection, linked through `Kernel.linkProcesses`, not yet handed to the accepting program's fd table.
 */
interface LoopbackListener {
  key: string
  serverProc: Process
  /** The program listening, when that is not `serverProc` (a socket file's connections land in the kernel's table) */
  owner?: Process
  listening: boolean
  /**
   * `peerAddr` is the address a client on this machine connected from, when it is known (`::1` for an IPv6 client)
   */
  queue: Array<{ fd: number, writeFd: number, peerKey: string, peerAddr?: string, conn?: number, cred?: PeerCredentials }>
  /** Wakes a socket file listening here (`socket-files.ts`) when a connection joins the queue */
  wake?: () => void
}
const loopbackListeners = new Map<string, LoopbackListener>()

/** What `/proc/net` lists: each listener once, whatever number of names (IPv4 and IPv6) it holds */
setNetSource({
  tcp: () => {
    const seen = new Set<LoopbackListener>()
    const out: Array<{ family: 'inet' | 'inet6' | 'inet46', port: number, uid: number, inode: number }> = []
    for (const [key, listener] of loopbackListeners) {
      if (!listener.listening || seen.has(listener) || key.startsWith('unix:')) continue
      seen.add(listener)
      const names = [...loopbackListeners].filter(([, other]) => other === listener).map(([name]) => name)
      const v4 = names.some(name => name.startsWith('inet:'))
      const v6 = names.some(name => name.startsWith('inet6:'))
      const port = Number(key.slice(key.lastIndexOf(':') + 1))
      out.push({ family: v4 && v6 ? 'inet46' : v6 ? 'inet6' : 'inet', port, uid: (listener.owner ?? listener.serverProc).context.credentials.euid, inode: socketInode(listener) })
    }
    return out
  },
  udp: () => boundUdpPorts().map(([port, socket]) => ({ family: 'inet46' as const, port, uid: 0, inode: socketInode(socket) })),
  unix: () => {
    const out: Array<{ path: string, listening: boolean, uid: number, inode: number }> = []
    for (const [key, listener] of loopbackListeners) {
      if (!key.startsWith('unix:')) continue
      out.push({ path: key.slice(5), listening: listener.listening, uid: (listener.owner ?? listener.serverProc).context.credentials.euid, inode: socketInode(listener) })
    }
    return out
  }
})

/** `struct ucred`: who is at the other end of a local connection (`SO_PEERCRED`, `SCM_CREDENTIALS`) */
interface PeerCredentials { pid: number, uid: number, gid: number }

/**
 * Ancillary data on a local stream connection (`SCM_RIGHTS`). Each connection has a number and two ends (`c` client,
 * `s` accepting). A sent descriptor is held as an extra reference to the sender's open file, tied to the byte offset
 * of its data, and put in the receiver's table when that data is received. Anything not received is released when the
 * receiver exits.
 */
type Held = { ref(): unknown, closeSync(): void }
type ScmItem = ({ t: 'fd', handle: Held } | { t: 'sock', read?: Held, write?: Held, meta: Record<string, unknown> }) & { unhold?: Array<() => void> }
interface ScmEntry { offset: number, length: number, items: ScmItem[] }
interface LocalConnection {
  ends: Record<string, Process>
  /**
   * The ends that are socket files (a WALI program's), whose descriptors go in their pipes; an emcc program's go in
   * `scmQueues`, so between the two kinds they are handed across (`rightsToEmcc`, `rightsFromPeer`)
   */
  files?: Record<string, Socket>
}
const localConnections = new Map<number, LocalConnection>()
const scmQueues = new Map<string, ScmEntry[]>()
let nextConnection = 1
const MaxInFlight = 253
const otherEnd = (dir: string) => dir === 'c' ? 's' : 'c'

/**
 * A descriptor in flight is also kept in a table entry of the sender (an fd number far above any a program is given). A
 * pipe is at its end when no table anywhere has the other end, so without this the reader of a pipe whose write end was
 * sent and closed would see the end of the file at once, before the receiver had taken it. Returns what drops the entry.
 */
const InFlightBase = 0x40000000
let nextInFlight = InFlightBase
function holdInFlight(proc: Process, handle: Held | undefined): () => void {
  if (!handle) return () => {}
  const key = nextInFlight++
  const entry = handle.ref() as Held
  proc.context.descriptors.set(key, entry as never)
  return () => {
    // if the sender exited, its table was closed with the entry in it
    if (proc.context.descriptors.get(key) !== (entry as never)) return
    proc.context.descriptors.delete(key)
    try { entry.closeSync() } catch { /* already closed */ }
  }
}
const unholdItem = (item: ScmItem) => { for (const drop of item.unhold ?? []) drop(); item.unhold = [] }

function releaseItems(items: ScmItem[]): void {
  for (const item of items) unholdItem(item)
  for (const item of items) for (const handle of item.t === 'fd' ? [item.handle] : [item.read, item.write]) { try { handle?.closeSync() } catch { /* already closed */ } }
}

function openConnection(ends: Record<string, Process>): number {
  const id = nextConnection++
  localConnections.set(id, { ends })
  // both programs gone: nothing can be received any more
  void Promise.all(Object.values(ends).map(end => end.exited)).then(() => {
    localConnections.delete(id)
    for (const dir of Object.keys(ends)) { const queue = scmQueues.get(`${id}${dir}`); if (queue) for (const entry of queue) releaseItems(entry.items); scmQueues.delete(`${id}${dir}`) }
  })
  return id
}
let nextEphemeralPort = 49152

/**
 * A socket file at end `dir` of connection `conn` whose other end is an emcc program: the descriptors it sends are
 * queued where that program's `recvmsg` looks for them (`scm_take`), at their offset in the stream.
 */
function rightsToEmcc(kernel: Kernel, socket: Socket, conn: number, dir: string): void {
  countWritten(socket)
  socket.rightsToPeer = (handles, offset, length) => {
    const key = `${conn}${dir}`
    const queue = scmQueues.get(key) ?? []
    const items: ScmItem[] = handles.map(one => {
      const handle = one.ref() as unknown as Held
      return { t: 'fd' as const, handle, unhold: [holdInFlight(kernel.pipeProcess, handle)] }
    })
    if (queue.length === 0) {
      const peer = localConnections.get(conn)?.ends[otherEnd(dir)]
      if (peer) void peer.exited.then(() => { for (const entry of scmQueues.get(key) ?? []) releaseItems(entry.items); scmQueues.delete(key) })
    }
    queue.push({ offset, length, items })
    scmQueues.set(key, queue)
  }
}

/** Normalizes an `AF_INET`/`AF_INET6` bind/connect target; anything not loopback is rejected by
 * the caller before this is even consulted - see `net_bind`/`net_connect`'s own checks. */
function isLoopbackHost(host: string): boolean {
  if (host === 'localhost') return true
  const address = canonicalIp(host)
  return address !== undefined && isLoopbackIp(address)
}

/** Handles the running program can reference; not persisted beyond one boot, same as `Windows` itself. */
let nextWindowHandle = 1
const windowHandles = new Map<number, string>() // handle -> the window server's WindowId
const hookedWindowOwners = new Set<number>() // pids whose exit closes their windows

/** Finds a `kernel.sockets` connection by id or 8-character prefix. */
function findSocketConnection(kernel: Kernel, id: string) {
  const fullMatch = kernel.sockets.get(id)
  if (fullMatch) return fullMatch

  for (const [fullId, conn] of kernel.sockets.all().entries()) {
    if (fullId.startsWith(id) || fullId.substring(0, 8) === id) return conn
  }
  return undefined
}

/**
 * Registers this module's syscalls in `@zenfs/linux`'s table, once per process (a second registration throws
 * `EEXIST`).
 */
let installed = false
/**
 * Where a trace goes: one of the tracing process's own descriptors, written as a program would, waiting out a full
 * pipe
 */
function traceSink(proc: Process, fd: number): (text: string) => Promise<void> {
  if (!proc.context.descriptors.has(fd)) throw Object.assign(new Error('Bad file descriptor'), { errno: Errno.EBADF })
  const encoder = new TextEncoder()
  // the kernel's own `write`, as the program would make it: a pipe or a terminal is written as the device it is, which
  // waits while a pipe is full and fails with EPIPE once nothing reads it (that ends the trace). Written through the
  // file's cache instead, the lines would sit there and fail at whatever closes a descriptor for the pipe next, a
  // `posix_spawn` handing the traced program's stdout to a child among them.
  const write = syscalls.get('write') as unknown as (proc: Process, fd: number, data: Uint8Array, position: number) => Promise<number>
  return async text => {
    const bytes = encoder.encode(text)
    for (let at = 0; at < bytes.byteLength;) {
      try { at += await write(proc, fd, bytes.subarray(at), -1) } catch (error) {
        // a full pipe: wait for the reader, as the program writing it would
        if ((error as { code?: string }).code !== 'EAGAIN') throw error
        await new Promise(resolve => setTimeout(resolve, 5))
      }
    }
  }
}

/**
 * Claims a loopback address for a listener whose connections land in `serverProc`'s table. `family`: `'unix'`,
 * `'inet'` (IPv4), `'inet6'` (IPv6 only) or `'inet46'` (an IPv6 socket that also takes IPv4, which is what `bind(::)`
 * is unless `IPV6_V6ONLY` is set). An IPv4 port and an IPv6-only port are separate names (`inet:` and `inet6:`); a
 * dual-stack one holds both, so a connection of either family reaches it and neither family can bind the same port
 * again. `addr` is the path for `unix`; `port: 0` picks the next ephemeral port, as on Linux. `release` gives the
 * address up again.
 */
function claimAddress(family: string, addr: string, port: number, serverProc: Process):
  { listener: LoopbackListener, key: string, port: number, release: () => void } | { error: string } {
  let keys: string[]
  let assigned = port
  if (family === 'unix') {
    keys = [`unix:${addr}`]
  } else if (family === 'inet' || family === 'inet6' || family === 'inet46') {
    if (addr && !isLoopbackHost(addr)) return { error: 'EADDRNOTAVAIL' }
    const keysFor = (candidate: number) => [
      ...(family === 'inet6' ? [] : [`inet:127.0.0.1:${candidate}`]),
      ...(family === 'inet' ? [] : [`inet6:${candidate}`])
    ]
    if (!assigned) { do assigned = nextEphemeralPort++; while (keysFor(assigned).some(key => loopbackListeners.has(key))) }
    keys = keysFor(assigned)
  } else {
    return { error: 'EAFNOSUPPORT' }
  }
  if (keys.some(key => loopbackListeners.has(key))) return { error: 'EADDRINUSE' }
  const listener: LoopbackListener = { key: keys[0]!, serverProc, listening: false, queue: [] }
  for (const key of keys) loopbackListeners.set(key, listener)
  const release = () => { for (const key of keys) if (loopbackListeners.get(key) === listener) loopbackListeners.delete(key) }
  return { listener, key: keys[0]!, port: assigned, release }
}

export function installMainThreadSyscalls(): void {
  if (installed) return
  installed = true
  installFdLinks()
  installPipeWakeup()
  installPtys()
  installEcmaosBinfmt()
  installDeviceHolds()
  installSharedRandom()
  installBusyRetry()
  installNotDirectory()
  installStops()
  installGroupExit()
  installThreads()
  installWaliSignals()
  installSysvIpc()
  installRecordLocks()
  installFbSeek((proc, fd) => {
    const handle = proc.context.descriptors.get(fd) as { inode?: { mode: number, rdev?: number | bigint } } | undefined
    let inode: NonNullable<typeof handle>['inode']
    try { inode = handle?.inode } catch { return undefined }
    if (!inode || (inode.mode & 0o170000) !== 0o020000) return undefined
    const rdev = BigInt(inode.rdev ?? 0)
    return Number(rdev >> 20n) === FbMajor ? framebufferAt(Number(rdev & 0xfffffn)) : undefined
  })

  // `fb_create`: a window of width by height pixels and the `/dev/fb<N>` node that draws in it. Returns N. The window goes with the process.
  define_syscall('fb_create', async (proc: Process, width: number, height: number, title: string, resizable?: number) => {
    const kernel = kernelOf(proc)
    try {
      const { uid, gid } = identityOf(proc)
      const framebuffer = kernel.framebuffers.create({ width, height, title, resizable: resizable === 1, owner: { pid: proc.pid, uid, gid } })
      if (!hookedWindowOwners.has(proc.pid)) {
        hookedWindowOwners.add(proc.pid)
        void proc.exited.then(() => { hookedWindowOwners.delete(proc.pid); kernel.windows.closeOwnedBy(proc.pid) })
      }
      return framebuffer.index
    } catch (error) {
      return -errnoOf(error)
    }
  })

  define_syscall('window_create', async (proc: Process, title: string) => {
    const kernel = kernelOf(proc)
    try {
      const { uid, gid } = identityOf(proc)
      const win = kernel.windows.create({ title: title || 'Untitled', owner: { pid: proc.pid, uid, gid } })
      // A process's windows go with it
      if (!hookedWindowOwners.has(proc.pid)) {
        hookedWindowOwners.add(proc.pid)
        void proc.exited.then(() => { hookedWindowOwners.delete(proc.pid); kernel.windows.closeOwnedBy(proc.pid) })
      }
      const handle = nextWindowHandle++
      windowHandles.set(handle, String(win.id))
      return handle
    } catch (error) {
      return -errnoOf(error)
    }
  })

  /**
   * Runs the presenter registered for `kind` (`#lib/presenters/index.ts`) on the main thread and writes `{ result }`
   * or `{ error }` to the scratch file at `path`.
   */
  define_syscall('window_present', async (proc: Process, kind: string, paramsJson: string, path: string) => {
    const kernel = kernelOf(proc)
    let text: string

    try {
      // A host with no page (Node) has its own set, which builds content for its display; the rest cannot work there
      const pageless = typeof document === 'undefined'
      const table = pageless ? hostPresenters : presenters
      const presenter = Object.hasOwn(table, kind) ? table[kind] : undefined
      if (!presenter) throw new Error(Object.hasOwn(presenters, kind) ? `${kind} is not available on this host: it has no page` : `unknown presenter: ${kind}`)
      const params = JSON.parse(paramsJson) as Record<string, unknown>
      // A browser call that needs the page the user is at goes to the display attached to the program's tty, if there
      // is one
      const spec = !pageless && Object.hasOwn(remoteKinds, kind) ? remoteKinds[kind] : undefined
      const tty = spec ? ttyNumberOf(kernel, proc) : undefined
      const remote = spec && tty !== undefined && kernel.hasDisplay(tty)
        ? kernel.presentOnDisplay(tty, kind, await spec.prepare?.(kernel, proc, params, shellOf(proc)) ?? params)
        : undefined
      const presented = remote
        ? { closed: spec?.finish ? remote.done.then(answer => spec.finish!(kernel, shellOf(proc), answer, params)) : remote.done, dispose: remote.cancel } satisfies Presented
        : await presenter(kernel, proc, params, shellOf(proc))
      let result: unknown = presented?.result ?? null

      if (presented?.closed) {
        // Hold the program here until what was presented is finished - or the process itself ends
        // first (`^C`, `kill`), in which case what it put on screen must go with it.
        const outcome = await Promise.race([presented.closed.then(value => ({ value })), proc.exited.then(() => undefined)])
        if (outcome) result = outcome.value
        else presented.dispose?.()
      }

      text = JSON.stringify({ result })
    } catch (error) {
      text = JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
    }

    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  /** What `window_write` has written to windows that have no DOM, by handle */
  const windowText = new Map<number, string>()

  /** The window behind `handle`, if the process owns it (root may use any) */
  const windowOf = (kernel: Kernel, proc: Process, handle: number) => {
    const id = windowHandles.get(handle)
    const win = id === undefined ? undefined : kernel.windows.get(id)
    if (!win || (win.info.owner.pid !== proc.pid && !processIsRoot(proc))) return undefined
    return win
  }

  define_syscall('window_write', async (proc: Process, handle: number, text: string) => {
    const win = windowOf(kernelOf(proc), proc, handle)
    if (!win) return -Errno.EBADF
    try {
      // A window drawn without the DOM (a host window) keeps the text here and is sent all of it
      const element = (() => { try { return win.body } catch { return undefined } })()
      if (element) element.textContent = ((element.textContent || '') + text)
      else {
        const written = (windowText.get(handle) ?? '') + text
        windowText.set(handle, written)
        win.setContent({ text: written })
      }
    } catch (error) {
      return -errnoOf(error)
    }
    return text.length
  })

  define_syscall('window_close', async (proc: Process, handle: number) => {
    const win = windowOf(kernelOf(proc), proc, handle)
    if (!win) return -Errno.EBADF
    win.close(true)
    windowHandles.delete(handle)
    windowText.delete(handle)
    return 0
  })

  // `window_list`: writes the windows of the caller's user as JSON (every window for root). Each entry has the handle when this
  // process opened it with `window_create`, otherwise `handle: null`.
  define_syscall('window_list', async (proc: Process, path: string) => {
    const kernel = kernelOf(proc)
    const handles = new Map([...windowHandles].map(([handle, id]) => [id, handle]))
    const windows = kernel.windows.list(processIsRoot(proc) ? {} : { uid: proc.context.credentials.euid }).map(info => ({ ...info, handle: handles.get(String(info.id)) ?? null }))
    const text = JSON.stringify(windows)
    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  // `wm_control`: acts on a window by id, for window-manager tools. Root may act on any window, anyone else on the
  // windows of their own user. Actions: focus, close, minimize, maximize, restore, fullscreen, move (a, b), resize
  // (a, b) and title (text).
  define_syscall('wm_control', async (proc: Process, id: string, action: string, a: number, b: number, text: string) => {
    const kernel = kernelOf(proc)
    const win = kernel.windows.get(id) ?? kernel.windows.get(Number(id))
    if (!win) return -Errno.ENOENT
    if (!processIsRoot(proc) && win.info.owner.uid !== proc.context.credentials.euid) return -Errno.EPERM
    switch (action) {
      case 'focus': win.focus(); break
      case 'close': win.close(true); break
      case 'minimize': win.setState('minimized'); break
      case 'maximize': win.setState('maximized'); break
      case 'restore': win.setState('normal'); break
      case 'fullscreen': win.setState('fullscreen'); break
      case 'move': win.move(a, b); break
      case 'resize': win.resize(a, b); break
      case 'title': win.setTitle(text); break
      case 'workspace':
        try { kernel.windows.moveToWorkspace(win.id, a) } catch { return -Errno.EINVAL }
        break
      default: return -Errno.EINVAL
    }
    return 0
  })

  // `wm_workspace`: the workspaces as a whole. `list` writes `{ "current": N, "count": N }` to `path`; `switch` (n) shows a
  // workspace; `count` (n) sets how many there are and is for root. A syscall can only return a number, hence the file.
  define_syscall('wm_workspace', async (proc: Process, action: string, n: number, path: string) => {
    const kernel = kernelOf(proc)
    switch (action) {
      case 'list':
        await writeScratch(kernel, proc, path, JSON.stringify({ current: kernel.windows.workspace, count: kernel.windows.workspaces }))
        return 0
      case 'switch':
        try { kernel.windows.switchWorkspace(n) } catch { return -Errno.EINVAL }
        return 0
      case 'count':
        if (!processIsRoot(proc)) return -Errno.EPERM
        kernel.windows.setWorkspaceCount(n)
        return 0
      default: return -Errno.EINVAL
    }
  })

  define_syscall('window_focus', async (proc: Process, handle: number) => {
    const win = windowOf(kernelOf(proc), proc, handle)
    if (!win) return -Errno.EBADF
    win.focus()
    return 0
  })

  define_syscall('window_move', async (proc: Process, handle: number, x: number, y: number) => {
    const win = windowOf(kernelOf(proc), proc, handle)
    if (!win) return -Errno.EBADF
    win.move(x, y)
    return 0
  })

  define_syscall('window_resize', async (proc: Process, handle: number, width: number, height: number) => {
    const win = windowOf(kernelOf(proc), proc, handle)
    if (!win) return -Errno.EBADF
    win.resize(width, height)
    return 0
  })

  define_syscall('window_set_title', async (proc: Process, handle: number, title: string) => {
    const win = windowOf(kernelOf(proc), proc, handle)
    if (!win) return -Errno.EBADF
    win.setTitle(title)
    return 0
  })

  // `storage_usage`: writes JSON to a file under `/tmp` because a syscall can only return a number.
  define_syscall('storage_usage', async (proc: Process, path: string) => {
    const kernel = kernelOf(proc)
    const usage = await kernel.storage.usage()
    // what the file systems hold in RAM (the IndexedDB root, /tmp and the other memory mounts, and browser
    // directories)
    const held = heldInMemory(mounts)
    const limits = currentStorageLimits()
    const memory = { held: totalHeld(held), warnAt: limits.warnResidentBytes === false ? 'never' : limits.warnResidentBytes, maxFile: limits.maxFileBytes === false ? 'unlimited' : limits.maxFileBytes, mounts: held }
    const text = JSON.stringify({ ...(usage ?? {}), persistent: kernel.storage.persisted, memory })
    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  // `quota`: what a user's files on the root come to against the limit in /etc/quota. A user sees their own; root
  // names anyone, or gets
  // every quota that is set. `reload` (root) reads /etc/quota again first.
  define_syscall('quota_report', async (proc: Process, argsJson: string, path: string) => {
    const kernel = kernelOf(proc)
    const args = JSON.parse(argsJson) as { user?: string, reload?: boolean }
    const me = identityOf(proc)
    let result: Record<string, unknown>
    try {
      const problems = args.reload ? (requireRoot(proc, 'quota -r'), await kernel.loadQuotas()) : []
      const nameOf = (uid: number) => kernel.users.get(uid)?.username ?? String(uid)
      const row = (uid: number) => ({ user: nameOf(uid), uid, used: quotaUsage(uid), limit: quotaLimit(uid)! })
      let rows: Array<ReturnType<typeof row>>
      if (args.user) {
        const target = [...kernel.users.all.values()].find(user => user.username === args.user)
        if (!target) throw new Error(`no such user '${args.user}'`)
        if (target.uid !== me.euid && me.euid !== 0) throw new Error('only root can look at another user\'s quota')
        rows = quotaLimit(target.uid) === undefined ? [] : [row(target.uid)]
      } else if (me.euid === 0) rows = [...quotaLimits().keys()].map(row)
      else rows = quotaLimit(me.euid) === undefined ? [] : [row(me.euid)]
      result = { rows, problems, listing: !args.user && me.euid === 0 }
    } catch (error) {
      result = { error: error instanceof Error ? error.message : String(error) }
    }
    const text = JSON.stringify(result)
    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  // `klog`: writes to `kernel.log` instead of the program's stdout, for daemon messages. An unrecognized level
  // becomes `info`.
  define_syscall('klog', async (proc: Process, level: string, message: string) => {
    const kernel = kernelOf(proc)
    const fn = (kernel.log as unknown as Record<string, (msg: string) => void>)[level]
    if (typeof fn === 'function') fn.call(kernel.log, message)
    else kernel.log.info(message)
    return 0
  })

  define_syscall('reboot', async (proc: Process) => {
    requireRoot(proc, 'reboot')
    const kernel = kernelOf(proc)
    await kernel.reboot()
    return 0
  })

  // `tty_get`: the caller's own terminal number when it has one, else the one on screen. A program on a pty gets
  // `PtyBase + <n>` for `/dev/pts/<n>`.
  define_syscall('tty_get', async (proc: Process) => {
    const kernel = kernelOf(proc)
    const pts = ptyIndexOf(proc.tty)
    if (pts !== undefined) return PtyBase + pts
    return ttyNumberOf(kernel, proc) ?? kernel.activeTty
  })

  // `kernel.switchTty` throws on an out-of-range TTY number rather than returning an error code
  // itself; translated to a real `-errno` here, the same convention `window_write`/`window_close`
  // use for a bad handle.
  define_syscall('tty_switch', async (proc: Process, ttyNumber: number) => {
    const kernel = kernelOf(proc)
    try {
      await kernel.switchTty(ttyNumber)
      return 0
    } catch {
      return -Errno.EINVAL
    }
  })

  // `sockets_*`: operate on the live `kernel.sockets` registry and write JSON to a scratch file. Failures are written
  // as `{ error: message }` because `dispatch()` turns a thrown plain `Error` into a bare `-EIO` and loses the
  // message.
  define_syscall('sockets_list', async (proc: Process, path: string) => {
    const kernel = kernelOf(proc)
    const list = Array.from(kernel.sockets.all().values()).map(conn => ({
      id: conn.id, type: conn.type, state: conn.state, url: conn.url, created: conn.created
    }))
    const text = JSON.stringify(list)
    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  define_syscall('sockets_create', async (proc: Process, url: string, type: string, protocols: string, path: string) => {
    const kernel = kernelOf(proc)
    let text: string

    try {
      let connection
      if (type === 'webtransport' || (!type && url.startsWith('https://'))) {
        if (!('WebTransport' in globalThis)) throw new Error('WebTransport is not supported in this browser')
        connection = await kernel.sockets.createWebTransport(url)
      } else if (type === 'websocket' || url.startsWith('ws://') || url.startsWith('wss://')) {
        const options = protocols ? { protocols: protocols.split(',') } : undefined
        connection = await kernel.sockets.createWebSocket(url, options)
      } else {
        throw new Error('unable to determine connection type. Use -t to specify type or use a URL with ws://, wss://, or https:// scheme')
      }
      text = JSON.stringify({ id: connection.id, type: connection.type, url: connection.url, state: connection.state })
    } catch (error) {
      text = JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
    }

    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  define_syscall('sockets_close', async (proc: Process, id: string, path: string) => {
    const kernel = kernelOf(proc)
    const connection = findSocketConnection(kernel, id)
    let text: string

    if (!connection) {
      text = JSON.stringify({ error: `connection not found: ${id}` })
    } else {
      await kernel.sockets.close(connection.id)
      text = JSON.stringify({ id: connection.id })
    }

    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  /**
   * Connects a socket and gives the caller two descriptors (`rx`, `tx`) through `Kernel.attachStream`. The connection
   * stays a `kernel.sockets` entry and is closed if the process dies with it open. Writes `{ id, rx, tx }` or `{
   * error }` to `path`; how it ended is left for `sockets_result`.
   */
  define_syscall('sockets_connect', async (proc: Process, url: string, type: string, protocols: string, path: string) => {
    const kernel = kernelOf(proc)
    let text: string

    try {
      let connection: SocketConnection
      let rx: ReadableStream<Uint8Array>
      let tx: WritableStream<Uint8Array>
      const info: SocketResult = { opened: true, messages: 0 }

      if (type === 'webtransport' || (!type && url.startsWith('https://'))) {
        if (!('WebTransport' in globalThis)) throw new Error('WebTransport is not supported in this browser')
        const transportConnection = await kernel.sockets.createWebTransport(url)
        connection = transportConnection
        const stream = await transportConnection.transport.createBidirectionalStream()
        tx = stream.writable
        // Reading to the end is how a transport session ends, so record it as a normal close
        const reader = stream.readable.getReader()
        rx = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const { done, value } = await reader.read()
            if (done) {
              info.code = 1000
              controller.close()
            } else {
              info.messages++
              controller.enqueue(value)
            }
          },
          cancel: () => reader.cancel()
        })
      } else if (type === 'websocket' || url.startsWith('ws://') || url.startsWith('wss://')) {
        const webSocketConnection = await kernel.sockets.createWebSocket(url, protocols ? { protocols: protocols.split(',') } : undefined)
        connection = webSocketConnection
        const ws = webSocketConnection.socket
        rx = new ReadableStream<Uint8Array>({
          start(controller) {
            ws.onmessage = event => {
              info.messages++
              controller.enqueue(typeof event.data === 'string' ? new TextEncoder().encode(event.data) : new Uint8Array(event.data as ArrayBuffer))
            }
            ws.onclose = event => {
              info.code = event.code
              info.reason = event.reason
              void webSocketConnection.close() // drops it from `kernel.sockets`, which `createWebSocket`'s own onclose did until we replaced it
              try { controller.close() } catch { /* already closed */ }
            }
          },
          cancel: () => { void webSocketConnection.close() }
        })
        tx = new WritableStream<Uint8Array>({
          write(chunk) { if (ws.readyState === WebSocket.OPEN) ws.send(chunk as unknown as ArrayBuffer) },
          close() { if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'Input closed') }
        })
      } else {
        throw new Error('unable to determine connection type. Use a ws://, wss://, or https:// URL')
      }

      const rxEnd = kernel.attachStream(proc, 'read', rx)
      const txEnd = kernel.attachStream(proc, 'write', tx)
      socketResults.set(connection.id, info)
      void proc.exited.then(() => {
        rxEnd.stop()
        txEnd.stop()
        void connection.close().catch(() => {})
      })
      text = JSON.stringify({ id: connection.id, rx: rxEnd.fd, tx: txEnd.fd })
    } catch (error) {
      text = JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
    }

    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  /** How a `sockets_connect` connection ended: `{ opened, messages, code?, reason? }`. Read once. */
  define_syscall('sockets_result', async (proc: Process, id: string, path: string) => {
    const kernel = kernelOf(proc)
    const info = socketResults.get(id)
    socketResults.delete(id)
    const text = JSON.stringify(info ?? { error: `connection not found: ${id}` })
    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  define_syscall('sockets_show', async (proc: Process, id: string, path: string) => {
    const kernel = kernelOf(proc)
    const connection = findSocketConnection(kernel, id)
    let text: string

    if (!connection) {
      text = JSON.stringify({ error: `connection not found: ${id}` })
    } else {
      const detail: Record<string, unknown> = {
        id: connection.id, type: connection.type, state: connection.state,
        url: connection.url, created: connection.created
      }

      if (connection.type === 'websocket') {
        const ws = connection.socket
        detail['protocol'] = ws.protocol || null
        detail['extensions'] = ws.extensions || null
        detail['binaryType'] = ws.binaryType
        detail['readyState'] = ws.readyState
      }

      text = JSON.stringify(detail)
    }

    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  /** Binds a loopback address (see `claimAddress`) for a program holding its sockets as pipes. Writes `{ ok, key, port? }`
   * or `{ error }` to `path`, the same convention every `sockets_*` syscall above already uses. */
  define_syscall('net_bind', async (proc: Process, family: string, addr: string, port: number, path: string) => {
    const kernel = kernelOf(proc)
    // A dead server must not leave its address permanently squatted - the next bind to the same
    // address (very common: restart the same local dev server) has to see it as free again.
    const claimed = claimAddress(family, addr, port, proc)
    if ('listener' in claimed) void proc.exited.then(claimed.release)
    const text = JSON.stringify('error' in claimed ? claimed : { ok: true, key: claimed.key, ...(family === 'unix' ? {} : { port: claimed.port }) })
    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  // A connection the gateway's host forwarded (`gateway expose`) joins the loopback listener's queue like one from
  // another program,
  // except both its ends are streams bridged to the link instead of pipes to a process. Nothing listening there:
  // refused.
  setInboundSink((kernel, port, streams, peer, ended) => {
    const listener = loopbackListeners.get(isIPv6(parseEndpoint(peer)?.address ?? '') ? `inet6:${port}` : `inet:127.0.0.1:${port}`)
    if (!listener?.listening) return false
    const serverProc = listener.serverProc
    const rxEnd = kernel.attachStream(serverProc, 'read', streams.rx)
    const txEnd = kernel.attachStream(serverProc, 'write', streams.tx)
    listener.queue.push({ fd: rxEnd.fd, writeFd: txEnd.fd, peerKey: `remote:${peer}` })
    listener.wake?.()
    // what the program wrote just before exiting is still on its way out: stop reading, let the writing side drain,
    // then end the flow
    void serverProc.exited.then(() => { rxEnd.stop(); void txEnd.done.then(ended) })
    return true
  })

  setLocalProbe((port, udp) => udp ? udpPortAt(port) !== undefined : loopbackListeners.get(`inet:127.0.0.1:${port}`)?.listening === true || loopbackListeners.get(`inet6:${port}`)?.listening === true)

  // A datagram from a peer that reached an exposed UDP port: handed to the program that bound it, with the way to
  // answer
  setDatagramSink((port, data, peer, reply) => {
    const bound = udpPortAt(port)
    const from = parseEndpoint(peer)
    const address = from ? canonicalIp(from.address) : undefined
    if (!bound || !from || !address) return false
    bound.hear(formatEndpoint(address, from.port), reply)
    bound.deliver(address, from.port, data)
    return true
  })

  /**
   * `bind()` on a datagram socket: claims the loopback port (`0` for an ephemeral one) and attaches the socket's two
   * streams as
   * descriptors, carrying addressed datagrams (see `udp-ports.ts`). Writes `{ fd, writeFd, port }` or `{ error }`.
   */
  define_syscall('net_udp_bind', async (proc: Process, addr: string, port: number, path: string) => {
    const kernel = kernelOf(proc)
    let text: string
    if (addr && !isLoopbackHost(addr)) text = JSON.stringify({ error: 'EADDRNOTAVAIL' })
    else {
      const bound = bindUdpPort(port, { open: (host, to) => openGatewayFlow(kernel, host, to, 'udp') })
      if (!bound) text = JSON.stringify({ error: 'EADDRINUSE' })
      else {
        const rxEnd = kernel.attachStream(proc, 'read', bound.rx)
        const txEnd = kernel.attachStream(proc, 'write', bound.tx)
        // the program closing the socket ends the writing side; its exit does the same for one it left open
        void txEnd.done.then(() => bound.close())
        // what the program sent just before exiting is still on its way: let the writing side drain, then release the
        // port
        void proc.exited.then(() => { rxEnd.stop(); void txEnd.done.then(() => bound.close()) })
        text = JSON.stringify({ fd: rxEnd.fd, writeFd: txEnd.fd, port: bound.port })
      }
    }
    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  /** Whether a gateway is up, so a datagram to an address beyond this machine has somewhere to go */
  define_syscall('net_gateway_up', async (proc: Process, path: string) => {
    const kernel = kernelOf(proc)
    const text = JSON.stringify({ up: gatewayLink(kernel) !== undefined })
    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  define_syscall('net_listen', async (proc: Process, key: string, backlog: number, path: string) => {
    const kernel = kernelOf(proc)
    const listener = loopbackListeners.get(key)
    let text: string

    if (!listener || listener.serverProc !== proc) text = JSON.stringify({ error: 'EINVAL' })
    else {
      listener.listening = true
      void backlog // accepted but not enforced - the queue is unbounded; a real backlog limit
      // would need net_connect to reject once full, not worth it for a loopback-only first pass.
      text = JSON.stringify({ ok: true })
    }

    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  /**
   * Links the caller and `key`'s listener with two directed `Kernel.linkProcesses` pipes and queues the accepting
   * side's fds for `net_accept`. Writes `{ fd, writeFd }` or `{ error }`.
   */
  define_syscall('net_connect', async (proc: Process, key: string, path: string) => {
    const kernel = kernelOf(proc)
    const listener = loopbackListeners.get(key)
    let text: string

    if (!listener || !listener.listening) {
      text = JSON.stringify({ error: 'ECONNREFUSED' })
    } else {
      const toServer = kernel.linkProcesses(proc, listener.serverProc) // client writes -> server reads
      const toClient = kernel.linkProcesses(listener.serverProc, proc) // server writes -> client reads
      const conn = openConnection({ c: proc, s: listener.owner ?? listener.serverProc })
      listener.queue.push({ fd: toServer.readerFd, writeFd: toClient.writerFd, peerKey: `client:${proc.pid}`, peerAddr: key.startsWith('inet6:') ? '::1' : key.startsWith('inet:') ? '127.0.0.1' : undefined, conn })
      listener.wake?.()
      text = JSON.stringify({ fd: toClient.readerFd, writeFd: toServer.writerFd, conn })
    }

    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  /**
   * `sendmsg()` with `SCM_RIGHTS`: holds the named descriptors (an `{ t: 'fd', fd }` for a plain one, `{ t: 'sock',
   * readFd, writeFd, meta }`
   * for a socket, which is a pair of them) for the other end of connection `conn`, tied to the stream `offset` of the
   * data they go with.
   */
  define_syscall('scm_send', async (proc: Process, conn: number, dir: string, offset: number, length: number, specs: string, path: string) => {
    const kernel = kernelOf(proc)
    let text: string
    const connection = localConnections.get(conn)
    const list = JSON.parse(specs) as Array<{ t: 'fd', fd: number } | { t: 'sock', readFd: number, writeFd: number, meta: Record<string, unknown> }>
    const key = `${conn}${dir}`
    const queue = scmQueues.get(key) ?? []
    const held = queue.reduce((sum, entry) => sum + entry.items.length, 0)
    const lookup = (fd: number) => proc.context.descriptors.get(fd) as unknown as Held | undefined
    const file = connection?.files?.[otherEnd(dir)]
    if (!connection || connection.ends[dir] !== proc) text = JSON.stringify({ error: 'ENOTCONN' })
    else if (list.some(item => item.t === 'fd' ? !lookup(item.fd) : !lookup(item.readFd) || !lookup(item.writeFd))) text = JSON.stringify({ error: 'EBADF' })
    // to a WALI program, whose sockets are files: the descriptors go in its pipe (an emcc socket, a pair of pipe ends, is not one it could take)
    else if (file && list.some(item => item.t !== 'fd')) text = JSON.stringify({ error: 'EINVAL' })
    else if (file) {
      rightsFromPeer(file, list.map(item => lookup((item as { fd: number }).fd)!.ref() as never), length, kernel.pipeProcess)
      text = JSON.stringify({ ok: true })
    }
    else if (held + list.length > MaxInFlight) text = JSON.stringify({ error: 'ENOBUFS' })
    else {
      const items: ScmItem[] = list.map(item => {
        if (item.t === 'fd') {
          const handle = lookup(item.fd)!.ref() as Held
          return { t: 'fd' as const, handle, unhold: [holdInFlight(proc, handle)] }
        }
        const read = lookup(item.readFd)!.ref() as Held
        const write = lookup(item.writeFd)!.ref() as Held
        return { t: 'sock' as const, read, write, meta: item.meta, unhold: [holdInFlight(proc, read), holdInFlight(proc, write)] }
      })
      if (queue.length === 0) {
        const peer = connection.ends[otherEnd(dir)]
        // what the receiving program never took goes when it does
        if (peer) void peer.exited.then(() => { for (const entry of scmQueues.get(key) ?? []) releaseItems(entry.items); scmQueues.delete(key) })
      }
      queue.push({ offset, length, items })
      scmQueues.set(key, queue)
      text = JSON.stringify({ ok: true })
    }
    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  /**
   * `recvmsg()`: the descriptors that go with the data at stream offset `rx`. Anything held for earlier bytes is
   * dropped. `max` is how much data was asked for and `limit` where to stop, since data from before and after a
   * descriptor is never returned together. Up to `room` descriptors go into the caller's table from `hint` upwards,
   * the rest are dropped and `ctrunc` is set. Writes `{ limit, items, ctrunc, peer }`.
   */
  define_syscall('scm_take', async (proc: Process, conn: number, dir: string, rx: number, max: number, room: number, hint: number, path: string) => {
    const kernel = kernelOf(proc)
    const key = `${conn}${dir}`
    const queue = scmQueues.get(key) ?? []
    while (queue.length > 0 && queue[0]!.offset < rx) releaseItems(queue.shift()!.items)
    const taken: ScmItem[] = []
    let end = rx
    while (queue.length > 0 && queue[0]!.offset === rx) { const entry = queue.shift()!; taken.push(...entry.items); end = Math.max(end, entry.offset + entry.length) }
    if (queue.length === 0) scmQueues.delete(key)
    // a read never runs on past the message that carried descriptors, nor into the next one that carries some
    const nextAt = queue.length > 0 ? queue[0]!.offset - rx : null
    const limit = end > rx ? (nextAt === null ? end - rx : Math.min(end - rx, nextAt)) : nextAt
    const given = taken.slice(0, Math.max(room, 0))
    releaseItems(taken.slice(given.length))
    let next = hint
    const place = (handle: Held | undefined) => {
      if (!handle) return -1
      while (proc.context.descriptors.has(next)) next++
      proc.context.descriptors.set(next, handle as never)
      return next++
    }
    const items = given.map(item => item.t === 'fd' ? { t: 'fd', fd: place(item.handle) } : { t: 'sock', readFd: place(item.read), writeFd: place(item.write), meta: item.meta })
    for (const item of given) unholdItem(item)   // the receiver's table has them now
    const sender = localConnections.get(conn)?.ends[dir]
    const identity = sender ? identityOf(sender) : undefined
    const text = JSON.stringify({ limit, items, ctrunc: taken.length > given.length, max, peer: sender ? { pid: sender.pid, uid: identity?.uid ?? 0, gid: identity?.gid ?? 0 } : undefined })
    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  /**
   * `SO_PEERCRED`: the process, user and group at the other end of connection `conn` (the caller is `dir`). Writes `{
   * pid, uid, gid }` or `{ error }`.
   */
  define_syscall('scm_cred', async (proc: Process, conn: number, dir: string, path: string) => {
    const kernel = kernelOf(proc)
    const peer = localConnections.get(conn)?.ends[otherEnd(dir)]
    const identity = peer ? identityOf(peer) : undefined
    const text = JSON.stringify(peer ? { pid: peer.pid, uid: identity?.uid ?? 0, gid: identity?.gid ?? 0 } : { error: 'ENOTCONN' })
    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  /**
   * A TCP connection (or, with `proto` `udp`, a datagram flow framed as the shim expects) to an address that is not
   * this machine, through the gateway (`remote-gateway.ts`). Hands back the same
   * `{ fd, writeFd }` shape `net_connect` does, so the program reads, writes, polls and closes it like any other
   * socket; the
   * pair is a bridge to the gateway's flow, ended when the program exits. `{ error }` is the errno `connect()` should
   * return.
   */
  define_syscall('net_connect_out', async (proc: Process, host: string, port: number, proto: string, path: string) => {
    const kernel = kernelOf(proc)
    let text: string
    try {
      const flow = await openGatewayFlow(kernel, host, port, proto === 'udp' ? 'udp' : 'tcp')
      const rxEnd = kernel.attachStream(proc, 'read', flow.rx)
      const txEnd = kernel.attachStream(proc, 'write', flow.tx)
      // what the program wrote just before exiting is still on its way out: stop reading, let the writing side drain,
      // then end the flow
      void proc.exited.then(() => { rxEnd.stop(); void txEnd.done.then(() => flow.close()) })
      text = JSON.stringify({ fd: rxEnd.fd, writeFd: txEnd.fd, address: flow.address })
    } catch (error) {
      text = JSON.stringify({ error: error instanceof GatewayFailure ? error.errno : 'ECONNREFUSED', message: error instanceof Error ? error.message : String(error) })
    }
    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  /**
   * A name's addresses for `getaddrinfo`: `/etc/hosts`, then the gateway. Writes `{ addresses }` or `{ error:
   * 'NONAME' | 'AGAIN', message }`.
   */
  define_syscall('dns_lookup', async (proc: Process, name: string, family: number, path: string) => {
    const kernel = kernelOf(proc)
    let text: string
    try {
      text = JSON.stringify({ addresses: await resolveHostname(kernel, name, family === 6 ? 6 : 4) })
    } catch (error) {
      text = JSON.stringify({ error: error instanceof LookupFailure ? error.kind : 'AGAIN', message: error instanceof Error ? error.message : String(error) })
    }
    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  /** Pops the next already-connected pair off `key`'s queue. `nonblock`: return `{ pending: true }`
   * immediately on an empty queue instead of leaving the worker to poll-retry (its own choice, made
   * by whether the socket has `O_NONBLOCK`/`SOCK_NONBLOCK` set - this syscall itself never blocks
   * the main thread either way, same as everything else in this module). */
  define_syscall('net_accept', async (proc: Process, key: string, nonblock: number, path: string) => {
    const kernel = kernelOf(proc)
    const listener = loopbackListeners.get(key)
    let text: string

    if (!listener || listener.serverProc !== proc) text = JSON.stringify({ error: 'EINVAL' })
    else {
      const next = listener.queue.shift()
      if (next) text = JSON.stringify(next)
      else text = JSON.stringify(nonblock ? { error: 'EAGAIN' } : { pending: true })
    }

    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  // `net_pending`: how many connections wait on the listener's queue, without taking one (what `poll` on a listening socket asks)
  define_syscall('net_pending', async (proc: Process, key: string, path: string) => {
    const kernel = kernelOf(proc)
    const listener = loopbackListeners.get(key)
    const text = JSON.stringify({ pending: listener && listener.serverProc === proc ? listener.queue.length : 0 })
    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  // Sockets that are files (`socket-files.ts`), for programs whose C library makes the socket calls: one descriptor
  // per socket, its connection's pipe ends held in the kernel's table. Errors are thrown as errno; answers that are
  // more than a number go in the region.
  const socketErrno = (name: string) => Object.assign(new Error(name), { errno: Errno[name as keyof typeof Errno] ?? Errno.EIO })

  /** `socket(2)`: a stream socket, or with `datagram` a UDP one, which has a queue of datagrams in place of pipes */
  define_syscall('sock_open', (proc: Process, flags: number, datagram?: number) => {
    const made = createSocket(proc, flags)
    if (datagram) made.socket.datagrams = { queue: [] }
    return made.fd
  })

  /**
   * Gives a datagram socket a UDP port (`port`, or an ephemeral one for 0) on this machine's address `addr` (empty for
   * any): what is sent to the port waits in the socket's queue, and what the socket sends goes out from it, to another
   * program's port or through the gateway. @returns the port
   */
  const bindDatagram = (proc: Process, socket: Socket, addr: string, port: number): number => {
    const kernel = kernelOf(proc)
    if (socket.info.bound) throw socketErrno('EINVAL')
    if (addr && !isLoopbackHost(addr)) throw socketErrno('EADDRNOTAVAIL')
    const bound = bindUdpPort(port, { open: (host, to) => openGatewayFlow(kernel, host, to, 'udp') })
    if (!bound) throw socketErrno('EADDRINUSE')
    const writer = bound.tx.getWriter()
    const reader = bound.rx.getReader()
    socket.datagrams!.send = (to, toPort, data) => { void writer.write(frameOf(to, toPort, data)).catch(() => { /* the port closed */ }) }
    // each chunk the port gives is one framed datagram
    void (async () => {
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }))
        if (done || !value) return
        const size = (value[0]! << 8) | value[1]!
        deliverDatagram(socket, { addr: formatIp(value.subarray(2, 18)), port: (value[18]! << 8) | value[19]!, data: value.slice(FrameHeader, FrameHeader + size) })
      }
    })()
    socket.cleanup.push(() => { void reader.cancel().catch(() => {}); void writer.close().catch(() => {}); bound.close() })
    socket.info.bound = `udp:${bound.port}`
    socket.info.local = { addr: addr || (socket.info.family === 2 ? '0.0.0.0' : '::'), port: bound.port }
    return bound.port
  }

  /** "Any" as a destination is this machine */
  const anyToLoopback = (addr: string) => addr === '0.0.0.0' ? '127.0.0.1' : addr === '::' ? '::1' : addr

  /** A datagram to an address beyond this machine needs a route there: without a gateway it fails at once */
  const routeTo = (proc: Process, addr: string) => {
    if (!isLoopbackHost(addr) && !gatewayLink(kernelOf(proc))) throw socketErrno('ENETUNREACH')
  }

  /**
   * `connect(2)` on a datagram socket: fixes its peer (where `send` goes, and the only sender it hears), giving it a
   * port first if it has none, as Linux does. An empty `addr` (`AF_UNSPEC`) undoes it.
   */
  define_syscall('sock_peer', (proc: Process, fd: number, addr: string, port: number) => {
    const { socket } = socketAt(proc, fd)
    if (!socket.datagrams) throw socketErrno('EINVAL')
    if (!addr) { delete socket.info.peer; return 0 }
    routeTo(proc, addr)
    if (!socket.info.bound) bindDatagram(proc, socket, '', 0)
    socket.info.peer = { addr: anyToLoopback(addr), port }
    return 0
  })

  /**
   * `sendto(2)` with an address (`family` is its `sa_family`). A stream has its peer already, so the address is not
   * looked at. An IPv6 datagram socket sends to an IPv4 address too, unless it is IPv6-only, as on Linux.
   */
  define_syscall('sock_sendto', (proc: Process, fd: number, data: Uint8Array, family: number, addr: string, port: number, flags: number) => {
    const { socket } = socketAt(proc, fd)
    if (!socket.datagrams) return send(proc, fd, data, flags)
    if (family !== socket.info.family) {
      if (socket.info.family !== 10 || family !== 2) throw socketErrno('EAFNOSUPPORT')
      if (socket.info.v6only) throw socketErrno('ENETUNREACH')
    }
    const to = { addr: anyToLoopback(addr), port }
    routeTo(proc, to.addr)
    if (!socket.info.bound) bindDatagram(proc, socket, '', 0)
    return sendDatagram(socket, to, data)
  })

  /** The bytes before what `sock_recvfrom` received: its full length (4), sender's port (2, big-endian), whether it was a datagram (1), the socket's family (1), and the sender's address (16, an IPv4 one mapped) */
  const RecvfromHeader = 24

  /**
   * `recvfrom(2)` with room for the sender's address. A datagram socket gives its next datagram and who sent it; a
   * stream gives what `recv` would, with no address (its peer is fixed). The region gets `RecvfromHeader`, then as
   * much as `count` lets.
   */
  define_syscall('sock_recvfrom', async (proc: Process, fd: number, count: number, flags: number) => {
    const { socket } = socketAt(proc, fd)
    const { region } = thread_of(proc)
    const answer = new DataView(region.buffer, region.byteOffset)
    region.fill(0, 0, RecvfromHeader)
    if (!socket.datagrams) {
      const length = await receive(proc, fd, Math.min(count, region.byteLength - RecvfromHeader), flags)
      region.copyWithin(RecvfromHeader, 0, length)
      region.fill(0, 0, RecvfromHeader)
      answer.setUint32(0, length, true)
      return thread_of(proc).filled(RecvfromHeader + length)
    }
    const datagram = await receiveDatagram(proc, fd, flags)
    const length = Math.max(0, Math.min(datagram.data.byteLength, count, region.byteLength - RecvfromHeader))
    answer.setUint32(0, datagram.data.byteLength, true)
    answer.setUint16(4, datagram.port, false)
    region[6] = 1
    region[7] = socket.info.family as number
    region.set(frameOf(datagram.addr, 0, new Uint8Array()).subarray(2, 18), 8)
    region.set(datagram.data.subarray(0, length), RecvfromHeader)
    return thread_of(proc).filled(RecvfromHeader + length)
  })

  /** `bind(2)`: claims the address for the socket, whose connections then land in the kernel's table. @returns the port */
  define_syscall('sock_bind', async (proc: Process, fd: number, family: string, addr: string, port: number) => {
    sweepSockets()
    const { socket } = socketAt(proc, fd)
    if (socket.datagrams) return bindDatagram(proc, socket, addr, port)
    if (socket.listening || socket.connected || socket.info.bound) throw socketErrno('EINVAL')
    const claimed = claimAddress(family, addr, port, kernelOf(proc).pipeProcess)
    if ('error' in claimed) throw socketErrno(claimed.error)
    // a Unix socket with a path is a file there too, as `bind(2)` makes it: a socket node that `stat` and `ls` show, that
    // `chmod` and `chown` change and `unlink` removes, and that a path already naming something refuses with EADDRINUSE.
    // Closing the socket leaves the file, as on Linux; the program that made it removes it.
    if (family === 'unix' && addr.startsWith('/')) {
      try {
        const bound = boundContexts.get(proc.context.id)
        if (!bound) throw socketErrno('EPERM')
        await (await bound.fs.promises.open(addr, 'wx', S_IFSOCK | (0o777 & ~umaskOf(proc)))).close()
      } catch (error) {
        claimed.release()
        const code = (error as { code?: string }).code
        throw code === 'EEXIST' ? socketErrno('EADDRINUSE') : error
      }
    }
    claimed.listener.wake = () => socket.wake.wake_up()
    socket.pending = () => claimed.listener.queue.length
    socket.cleanup.push(() => {
      claimed.release()
      // connections no one will accept: their ends are in the kernel's table, and the clients see them closed
      const table = kernelOf(proc).pipeProcess.context.descriptors
      for (const entry of claimed.listener.queue.splice(0)) {
        for (const end of [entry.fd, entry.writeFd]) { const handle = table.get(end); table.delete(end); try { handle?.closeSync() } catch { /* already closed */ } }
      }
    })
    socket.info.bound = claimed.key
    return claimed.port
  })

  define_syscall('sock_listen', (proc: Process, fd: number) => {
    const { socket } = socketAt(proc, fd)
    const key = socket.info.bound as string | undefined
    const listener = key ? loopbackListeners.get(key) : undefined
    if (!listener || socket.connected) throw socketErrno('EINVAL')
    listener.listening = true
    listener.owner = proc
    socket.listening = key
    socket.wake.wake_up()
    return 0
  })

  /** `accept4(2)`: waits for a connection unless the socket is non-blocking; `flags` may hold `SOCK_NONBLOCK` */
  define_syscall('sock_accept', async (proc: Process, fd: number, flags: number) => {
    const { socket, handle } = socketAt(proc, fd)
    const listener = socket.listening ? loopbackListeners.get(socket.listening) : undefined
    if (!listener) throw socketErrno('EINVAL')
    await whenPending(proc, socket, handle)
    const next = listener.queue.shift()
    if (!next) throw socketErrno('EAGAIN')
    const made = createSocket(proc, flags, { ...socket.info, bound: undefined, local: socket.info.local, peer: { addr: next.peerAddr, key: next.peerKey }, peercred: next.cred })
    attach(made.socket, listener.serverProc, next.fd, next.writeFd)
    const connection = next.conn === undefined ? undefined : localConnections.get(next.conn)
    if (connection) {
      connection.files = { ...connection.files, s: made.socket }
      // a client that is not a socket file is an emcc program
      if (!connection.files.c) {
        rightsToEmcc(kernelOf(proc), made.socket, next.conn!, 's')
        // what it sent before it was accepted
        for (const entry of scmQueues.get(`${next.conn}c`) ?? []) {
          for (const item of entry.items) unholdItem(item)
          const handles = entry.items.flatMap(item => item.t === 'fd' ? [item.handle] : (releaseItems([item]), []))
          rightsFromPeer(made.socket, handles as never, entry.length, kernelOf(proc).pipeProcess, entry.offset)
        }
        scmQueues.delete(`${next.conn}c`)
      }
    }
    return made.fd
  })

  /** `connect(2)` to a loopback listener: the listener's queue gets the server's ends, as `net_connect` gives them */
  define_syscall('sock_connect', (proc: Process, fd: number, key: string) => {
    sweepSockets()
    const kernel = kernelOf(proc)
    const { socket } = socketAt(proc, fd)
    if (socket.connected) throw socketErrno('EISCONN')
    if (socket.listening) throw socketErrno('EINVAL')
    const listener = loopbackListeners.get(key)
    if (!listener?.listening) throw socketErrno('ECONNREFUSED')
    const holder = kernel.pipeProcess
    const toServer = kernel.linkProcesses(holder, listener.serverProc)
    const toClient = kernel.linkProcesses(listener.serverProc, holder)
    const conn = openConnection({ c: proc, s: listener.owner ?? listener.serverProc })
    listener.queue.push({ fd: toServer.readerFd, writeFd: toClient.writerFd, peerKey: `client:${proc.pid}`, peerAddr: key.startsWith('inet6:') ? '::1' : key.startsWith('inet:') ? '127.0.0.1' : undefined, conn, cred: credentialsOf(proc) })
    listener.wake?.()
    // the client's peer is whoever listened
    socket.info.peercred = credentialsOf(listener.owner ?? listener.serverProc)
    attach(socket, holder, toClient.readerFd, toServer.writerFd)
    localConnections.get(conn)!.files = { c: socket }
    // a listener that is not a socket file is an emcc program's
    if (!listener.owner) rightsToEmcc(kernel, socket, conn, 'c')
    return 0
  })

  /** `connect(2)` to an address beyond this machine, through the gateway (`net_connect_out`'s flow) */
  define_syscall('sock_connect_out', async (proc: Process, fd: number, host: string, port: number) => {
    const kernel = kernelOf(proc)
    const { socket } = socketAt(proc, fd)
    if (socket.connected) throw socketErrno('EISCONN')
    if (!gatewayLink(kernel)) throw socketErrno('ENETUNREACH')
    let flow: Awaited<ReturnType<typeof openGatewayFlow>>
    try {
      flow = await openGatewayFlow(kernel, host, port, 'tcp')
    } catch (error) {
      throw socketErrno(error instanceof GatewayFailure ? error.errno : 'ECONNREFUSED')
    }
    const holder = kernel.pipeProcess
    const rxEnd = kernel.attachStream(holder, 'read', flow.rx)
    const txEnd = kernel.attachStream(holder, 'write', flow.tx)
    // what the program wrote last is still on its way out: stop reading, let the writing side drain, then end the flow
    socket.cleanup.push(() => { rxEnd.stop(); void txEnd.done.then(() => flow.close()) })
    socket.info.peer = { addr: flow.address, port }
    attach(socket, holder, rxEnd.fd, txEnd.fd)
    return 0
  })

  /** `socketpair(2)`: two connected sockets, their descriptors in the region as `pipe` gives its two */
  define_syscall('sock_pair', (proc: Process, flags: number) => {
    const holder = kernelOf(proc).pipeProcess
    const [aToB, bToA] = [createPipe(holder.context), createPipe(holder.context)]
    const a = createSocket(proc, flags, { family: 'unix', peercred: credentialsOf(proc) }), b = createSocket(proc, flags, { family: 'unix', peercred: credentialsOf(proc) })
    attach(a.socket, holder, bToA[0], aToB[1])
    attach(b.socket, holder, aToB[0], bToA[1])
    const { region } = thread_of(proc)
    const answer = new DataView(region.buffer, region.byteOffset)
    answer.setInt32(0, a.fd, true)
    answer.setInt32(4, b.fd, true)
    thread_of(proc).filled(8)
    return 0
  })

  define_syscall('sock_shutdown', (proc: Process, fd: number, how: number) => {
    shutdown(socketAt(proc, fd).socket, how)
    return 0
  })

  /** What the socket's library recorded about it and what the kernel knows (connected, listening, bytes to read), as JSON in the region */
  define_syscall('sock_info', (proc: Process, fd: number) => thread_of(proc).put(new TextEncoder().encode(JSON.stringify(describe(socketAt(proc, fd).socket)))))
  /** Merges what the socket's library wants kept about it (family, type, options), which every descriptor for it shares */
  define_syscall('sock_set', (proc: Process, fd: number, info: string) => {
    Object.assign(socketAt(proc, fd).socket.info, JSON.parse(info))
    return 0
  })
  define_syscall('sock_recv', (proc: Process, fd: number, count: number, flags: number) => receive(proc, fd, count, flags))
  /** `sendmsg(2)` with `SCM_RIGHTS` on a local stream: `fds` is the descriptors' numbers, as JSON; they wait in the kernel's table until received */
  define_syscall('sock_sendmsg', (proc: Process, fd: number, data: Uint8Array, fds: string, flags: number) =>
    sendRights(proc, fd, data, JSON.parse(fds) as number[], kernelOf(proc).pipeProcess, flags))
  /** `recvmsg(2)` on a local stream, with up to `room` descriptors and the peer's credentials (`socket-files.ts`, `receiveRights`) */
  define_syscall('sock_recvmsg', (proc: Process, fd: number, count: number, flags: number, room: number) => receiveRights(proc, fd, count, flags, room))
  define_syscall('sock_send', (proc: Process, fd: number, data: Uint8Array, flags: number) => send(proc, fd, data, flags))

  // The status flags of an open file, which every descriptor for it shares: `O_NONBLOCK` decides whether a read of a
  // pipe or socket waits. `fcntl(F_SETFL)` changes only the ones Linux lets it.
  const SetflMask = 0o2000 /* O_APPEND */ | 0o4000 /* O_NONBLOCK */ | 0o20000 /* O_ASYNC */ | 0o40000 /* O_DIRECT */ | 0o1000000 /* O_NOATIME */
  const openFile = (proc: Process, fd: number) => {
    const handle = proc.context.descriptors.get(fd) as unknown as { flag: number } | undefined
    if (!handle) throw socketErrno('EBADF')
    return handle
  }
  // `O_APPEND` moves every write to the end of the file and does nothing to reads or to `lseek` (`a+` reads what is in the
  // file from the start). The handle of a file opened with it reports the end as its position, which is right for
  // writes and wrong for the rest, so a file opened to read and append keeps its own position, and its writes go to the end.
  const openSyscall = syscalls.get('open') as unknown as (proc: Process, ...args: unknown[]) => number | Promise<number>
  syscalls.set('open', (async (proc: Process, path: string, flags: number, mode: number) => {
    // a directory opens read-only without `O_DIRECTORY` too (toybox's `ps` and `lsof` open `/proc` so, then read it with
    // getdents); only a write or create is refused, with EISDIR
    let fd: number
    try {
      fd = await openSyscall(proc, path, flags, mode)
    } catch (error) {
      if ((error as { code?: string }).code !== 'EISDIR' || (flags & 3) !== 0 || (flags & 0o100) /* O_CREAT */) throw error
      fd = await openSyscall(proc, path, flags | O_DIRECTORY, mode)
    }
    if ((flags & 0o2000) && (flags & 3) === 2) {
      type Handle = { _position: number, inode: { size: number }, writeSync: Writer, write: Writer }
      type Writer = (this: Handle, buffer: Uint8Array, offset?: number, length?: number, position?: number) => unknown
      const handle = proc.context.descriptors.get(fd) as unknown as Handle | undefined
      if (handle && typeof handle._position === 'number') {
        Object.defineProperty(handle, 'position', { get() { return this._position }, set(value: number) { this._position = value }, configurable: true })
        for (const name of ['writeSync', 'write'] as const) {
          const original = handle[name]
          handle[name] = function (this: Handle, buffer, offset, length) { return original.call(this, buffer, offset, length, this.inode.size) }
        }
      }
    }
    return fd
  }) as never)
  define_syscall('fd_getfl', (proc: Process, fd: number) => openFile(proc, fd).flag)
  define_syscall('fd_setfl', (proc: Process, fd: number, flags: number) => {
    const handle = openFile(proc, fd)
    handle.flag = (handle.flag & ~SetflMask) | (flags & SetflMask)
    return 0
  })

  for (const name of ['close', 'dup2', 'dup3'] as const) {
    const original = syscalls.get(name as never) as ((proc: Process, ...args: unknown[]) => unknown) | undefined
    if (!original) continue
    syscalls.set(name as never, (async (proc: Process, ...args: unknown[]) => {
      try { return await original(proc, ...args) } finally { sweepSockets() }
    }) as never)
  }
  const exit = ZenFSProcess.prototype.exit
  ZenFSProcess.prototype.exit = function (this: Process, ...args: Parameters<typeof exit>) {
    try { return exit.apply(this, args) } finally { sweepSockets() }
  }

  // `users_lookup`: resolves usernames and uids against `kernel.users` and writes `{ uid, gid, groups, username }`
  // entries to `path`; no hashes or keys. `mode: 'self'` resolves the caller's own uid, gid and groups, since there
  // is no `getgroups` syscall.
  define_syscall('users_lookup', async (proc: Process, query: string, path: string) => {
    const kernel = kernelOf(proc)
    const request = JSON.parse(query) as
      | { mode: 'self' }
      | { mode: 'byUid', uid: number }
      | { mode: 'byUsername', username: string }
      | { mode: 'group', gid: number }

    const toRecord = (uid: number) => {
      const user = kernel.users.get(uid)
      return user ? { uid: user.uid, gid: user.gid, groups: user.groups, username: user.username } : null
    }

    let result: unknown
    if (request.mode === 'self') {
      const credentials = identityOf(proc)
      const user = kernel.users.get(credentials.uid)
      result = {
        uid: credentials.uid,
        gid: credentials.gid,
        euid: credentials.euid ?? credentials.uid,
        egid: credentials.egid ?? credentials.gid,
        groups: credentials.groups ?? [],
        username: user?.username ?? 'root'
      }
    } else if (request.mode === 'byUid') {
      result = toRecord(request.uid)
    } else if (request.mode === 'group') {
      const group = kernel.users.findGroup(request.gid)
      result = group ? { gid: group.gid, name: group.name } : null
    } else {
      const match = Array.from(kernel.users.all.values()).find(u => u.username === request.username)
      result = match ? toRecord(match.uid) : null
    }

    const text = JSON.stringify(result)
    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  // `users_manage`: `list`, `add`, `del` and `mod`, all requiring root. May prompt for a password through
  // `shell.terminal.readline()`, so it needs `shellOf(proc)`. Failures are written as `{ error: message }`.
  define_syscall('users_manage', async (proc: Process, action: string, argsJson: string, path: string) => {
    const kernel = kernelOf(proc)
    const shell = shellOf(proc)
    let text: string

    if (!shell || identityOf(proc).euid !== 0) {
      text = JSON.stringify({ error: 'permission denied' })
      await writeScratch(kernel, proc, path, text)
      return text.length
    }

    try {
      const args = JSON.parse(argsJson) as Record<string, unknown>

      if (action === 'list') {
        text = JSON.stringify(Array.from(kernel.users.all.values()).map(u => ({ uid: u.uid, gid: u.gid, groups: u.groups, username: u.username })))
      } else if (action === 'add') {
        const username = args['username'] as string
        const allUsers = Array.from(kernel.users.all.values())
        if (allUsers.some(u => u.username === username)) throw new Error(`user '${username}' already exists`)

        const uid = args['uid'] as number | undefined
        if (uid !== undefined && kernel.users.all.has(uid)) throw new Error(`UID ${uid} already in use`)

        let password = args['password'] as string | undefined
        if (!password) {
          password = await shell.terminal.readline('New password: ', true)
          const confirm = await shell.terminal.readline('Retype new password: ', true)
          if (password !== confirm) throw new Error('password mismatch')
        }

        await kernel.users.add(
          { username, password, uid, gid: args['gid'] as number | undefined, shell: args['shellValue'] as string, home: `/home/${username}` },
          { noHome: !args['createHome'] }
        )
        text = JSON.stringify({ message: `user '${username}' created successfully` })
      } else if (action === 'del') {
        const username = args['username'] as string
        const allUsers = Array.from(kernel.users.all.values())
        const usr = allUsers.find(u => u.username === username)
        if (!usr) throw new Error(`user '${username}' does not exist`)
        if (usr.uid === 0) throw new Error('cannot delete root user')

        await kernel.users.remove(usr.uid)

        let warning: string | undefined
        if (args['removeHome'] && usr.home) {
          try {
            const removeDirRecursive = async (dirPath: string): Promise<void> => {
              const entries = await kernel.filesystem.fs.readdir(dirPath)
              for (const entry of entries) {
                const entryPath = `${dirPath}/${entry}`
                const stat = await kernel.filesystem.fs.stat(entryPath)
                if (stat.isDirectory()) await removeDirRecursive(entryPath)
                else await kernel.filesystem.fs.unlink(entryPath)
              }
              await kernel.filesystem.fs.rmdir(dirPath)
            }
            await removeDirRecursive(usr.home)
          } catch {
            warning = `warning: could not remove home directory '${usr.home}'`
          }
        }

        text = JSON.stringify({ message: `user '${username}' deleted successfully`, warning })
      } else if (action === 'mod') {
        const username = args['username'] as string
        const allUsers = Array.from(kernel.users.all.values())
        const usr = allUsers.find(u => u.username === username)
        if (!usr) throw new Error(`user '${username}' does not exist`)

        const updates: Record<string, unknown> = {}
        let changedPassword = false
        if (args['shellValue'] !== undefined) updates['shell'] = args['shellValue']
        if (args['gid'] !== undefined) updates['gid'] = args['gid']

        if (args['changePassword']) {
          const newPassword = await shell.terminal.readline('New password: ', true)
          const confirm = await shell.terminal.readline('Retype new password: ', true)
          if (newPassword !== confirm) throw new Error('password mismatch')

          await kernel.users.resetPassword(usr.uid, newPassword)
          changedPassword = true
        }

        if (Object.keys(updates).length === 0 && !changedPassword) throw new Error('no changes specified')

        if (Object.keys(updates).length > 0) await kernel.users.update(usr.uid, updates)
        text = JSON.stringify({ message: `user '${username}' modified successfully` })
      } else if (action === 'groups') {
        text = JSON.stringify(kernel.users.groupList)
      } else if (action === 'groupadd') {
        const name = args['name'] as string
        if (args['force'] && kernel.users.findGroup(name)) text = JSON.stringify({ message: `group '${name}' already exists` })
        else {
          const group = await kernel.users.addGroup(name, args['gid'] as number | undefined, Boolean(args['system']))
          text = JSON.stringify({ message: `group '${group.name}' created with GID ${group.gid}` })
        }
      } else if (action === 'groupdel') {
        const group = kernel.users.findGroup(args['name'] as string)
        if (!group) throw new Error(`group '${args['name']}' does not exist`)
        await kernel.users.removeGroup(group.gid)
        text = JSON.stringify({ message: `group '${group.name}' deleted` })
      } else if (action === 'groupmod') {
        const group = kernel.users.findGroup(args['name'] as string)
        if (!group) throw new Error(`group '${args['name']}' does not exist`)
        if (args['gid'] === undefined && args['newName'] === undefined) throw new Error('no changes specified')
        await kernel.users.modifyGroup(group.gid, { gid: args['gid'] as number | undefined, name: args['newName'] as string | undefined })
        text = JSON.stringify({ message: `group '${group.name}' modified` })
      } else if (action === 'member' || action === 'members') {
        const group = kernel.users.findGroup(args['group'] as string)
        if (!group) throw new Error(`group '${args['group']}' does not exist`)
        const named = (args['users'] as string[] | undefined) ?? [args['user'] as string]
        const people = named.map(username => {
          const found = kernel.users.byName(username)
          if (!found) throw new Error(`user '${username}' does not exist`)
          return found
        })
        if (action === 'members') {
          for (const person of kernel.users.all.values()) await kernel.users.setMembership(person.uid, group.gid, people.some(chosen => chosen.uid === person.uid))
        } else for (const person of people) await kernel.users.setMembership(person.uid, group.gid, args['op'] === 'add')
        text = JSON.stringify({ message: `group '${group.name}' updated` })
      } else if (action === 'useradd') {
        const username = args['username'] as string
        if (kernel.users.byName(username)) throw new Error(`user '${username}' already exists`)
        const system = Boolean(args['system'])
        const uid = (args['uid'] as number | undefined) ?? kernel.users.freeId('uid', system ? 100 : 1000, system ? 999 : Infinity)
        if (kernel.users.all.has(uid)) throw new Error(`UID '${uid}' is not unique`)
        const resolveGroup = (spec: string | number) => {
          const found = kernel.users.findGroup(spec)
          if (!found) throw new Error(`group '${spec}' does not exist`)
          return found
        }
        const supplementary = ((args['groups'] as string[] | undefined) ?? []).map(spec => resolveGroup(spec).gid)

        // A system account has no password anyone can type (`*`), unless one is given
        let password = args['password'] as string | undefined
        const noPassword = !password && system
        if (noPassword) password = '*'
        else if (!password) {
          password = await shell.terminal.readline('New password: ', true)
          const confirm = await shell.terminal.readline('Retype new password: ', true)
          if (password !== confirm) throw new Error('password mismatch')
        }

        // without -g the user gets a group of their own, named after them
        let createdGroup: number | undefined
        let gid: number
        if (args['group'] !== undefined) gid = resolveGroup(args['group'] as string | number).gid
        else {
          if (kernel.users.findGroup(username)) throw new Error(`group ${username} exists - if you want to add this user to that group, use -g`)
          const preferred = kernel.users.findGroup(uid) ? kernel.users.freeId('gid', system ? 100 : 1000, system ? 999 : Infinity) : uid
          gid = (await kernel.users.addGroup(username, preferred)).gid
          createdGroup = gid
        }
        try {
          await kernel.users.add(
            { username, password, uid, gid, groups: supplementary, shell: (args['shell'] as string | undefined) ?? 'ecmaos', home: (args['home'] as string | undefined) ?? `/home/${username}` },
            { noHome: !args['createHome'], noHash: noPassword }
          )
        } catch (error) {
          if (createdGroup !== undefined) await kernel.users.removeGroup(createdGroup).catch(() => {})
          throw error
        }
        text = JSON.stringify({ message: `user '${username}' created with UID ${uid}` })
      } else if (action === 'userdel') {
        const username = args['username'] as string
        const usr = kernel.users.byName(username)
        if (!usr) throw new Error(`user '${username}' does not exist`)
        if (usr.uid === 0) throw new Error('cannot remove the root user')
        if (!args['force']) {
          for (const running of processes.values()) {
            if (running.code === undefined && running.context.credentials.uid === usr.uid) throw new Error(`user ${username} is currently used by process ${running.pid}`)
          }
        }
        await kernel.users.remove(usr.uid)
        let warning: string | undefined
        if (args['removeHome'] && usr.home) {
          try { await removeTree(kernel, usr.home) } catch { warning = `warning: could not remove home directory '${usr.home}'` }
        }
        text = JSON.stringify({ message: `user '${username}' deleted`, warning })
      } else if (action === 'usermod') {
        const username = args['username'] as string
        let usr = kernel.users.byName(username)
        if (!usr) throw new Error(`user '${username}' does not exist`)
        const resolveGroup = (spec: string | number) => {
          const found = kernel.users.findGroup(spec)
          if (!found) throw new Error(`group '${spec}' does not exist`)
          return found
        }
        const updates: Partial<typeof usr> = {}
        if (args['group'] !== undefined) updates.gid = resolveGroup(args['group'] as string | number).gid
        if (args['groups'] !== undefined) {
          const gids = (args['groups'] as string[]).map(spec => resolveGroup(spec).gid)
          updates.groups = args['append'] ? Array.from(new Set([...usr.groups, ...gids])) : gids
        }
        if (args['shell'] !== undefined) updates.shell = args['shell'] as string
        const oldHome = usr.home
        if (args['home'] !== undefined) updates.home = args['home'] as string
        const changes = Object.keys(updates).length > 0 || args['uid'] !== undefined || args['newName'] !== undefined
        if (!changes) throw new Error('no changes specified')
        if (args['newName'] !== undefined && args['newName'] !== username && kernel.users.byName(args['newName'] as string)) throw new Error(`user '${args['newName']}' already exists`)
        if (args['uid'] !== undefined && args['uid'] !== usr.uid && kernel.users.all.has(args['uid'] as number)) throw new Error(`UID '${args['uid']}' already exists`)

        if (args['moveHome'] && updates.home && updates.home !== oldHome) {
          if (await kernel.filesystem.fs.exists(updates.home)) throw new Error(`directory ${updates.home} exists`)
          await kernel.filesystem.fs.rename(oldHome, updates.home)
        }
        if (Object.keys(updates).length > 0) await kernel.users.update(usr.uid, updates)
        if (args['uid'] !== undefined) { await kernel.users.changeUid(usr.uid, args['uid'] as number); usr = kernel.users.byName(username) as typeof usr }
        if (args['newName'] !== undefined) await kernel.users.rename(usr.uid, args['newName'] as string)
        text = JSON.stringify({ message: `user '${username}' modified` })
      } else if (action === 'passwd') {
        // `passwd -l`, `-u` and `-S`: the lock on an account's password, and what state it is in
        const username = args['username'] as string
        const usr = kernel.users.byName(username)
        if (!usr) throw new Error(`user '${username}' does not exist`)
        const op = args['op'] as string
        if (op === 'lock') await kernel.users.lock(usr.uid)
        else if (op === 'unlock') await kernel.users.unlock(usr.uid)
        else if (op === 'set') await kernel.users.resetPassword(usr.uid, args['password'] as string)
        else if (op !== 'status') throw new Error(`unknown passwd operation: ${op}`)
        const hash = kernel.users.byName(username)!.password
        const state = hash.replace(/^!/, '') === '' ? 'NP' : hash.startsWith('!') || hash.replace(/^!/, '') === '*' ? 'L' : 'P'
        text = JSON.stringify({ message: `password for '${username}' ${op === 'status' ? 'is' : 'is now'} ${state === 'L' ? 'locked' : state === 'NP' ? 'empty' : 'set'}`, username, state, aging: kernel.users.byName(username)!.aging ?? {} })
      } else if (action === 'chage') {
        // `chage`: read or change the password aging fields (a `null` clears one)
        const username = args['username'] as string
        const usr = kernel.users.byName(username)
        if (!usr) throw new Error(`user '${username}' does not exist`)
        const changes = (args['changes'] ?? {}) as Record<string, number | null>
        if (Object.keys(changes).length > 0) await kernel.users.setAging(usr.uid, changes)
        text = JSON.stringify({ username, aging: kernel.users.byName(username)!.aging ?? {}, locked: kernel.users.isLocked(usr.uid) })
      } else {
        throw new Error(`unknown action: ${action}`)
      }
    } catch (error) {
      text = JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
    }

    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  // `umount`: `target === ''` unmounts everything except `/`. Results go to the scratch file as a JSON array.
  define_syscall('fs_umount', async (proc: Process, target: string, path: string) => {
    requireRoot(proc, 'umount')
    const kernel = kernelOf(proc)
    const results: Array<{ target: string, error?: string }> = []

    const unmountOne = (mountTarget: string) => {
      try {
        const mounted = kernel.filesystem.mounts.get(mountTarget) as { closeRemote?: () => void } | undefined
        kernel.filesystem.fsSync.umount(mountTarget)
        // A mount of another machine holds a connection to it, which ends with the mount
        mounted?.closeRemote?.()
        results.push({ target: mountTarget })
      } catch (error) {
        results.push({ target: mountTarget, error: error instanceof Error ? error.message : String(error) })
      }
    }

    if (target === '') {
      const mountList = Array.from(kernel.filesystem.mounts.keys()).filter(m => m !== '/')
      for (const mountTarget of mountList) unmountOne(mountTarget)
    } else if (target === '/') {
      results.push({ target, error: 'cannot unmount root filesystem' })
    } else if (!kernel.filesystem.mounts.has(target)) {
      results.push({ target, error: `${target} is not mounted` })
    } else {
      unmountOne(target)
    }

    const text = JSON.stringify(results)
    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  // `mount`: the backends need the live mount table and main-thread browser APIs. The program parses arguments;
  // `mountFilesystem` (`mount-backends.ts`) returns the lines to print and an exit code.
  define_syscall('fs_mount', async (proc: Process, argsJson: string, path: string) => {
    const kernel = kernelOf(proc)
    const shell = shellOf(proc)
    const args = JSON.parse(argsJson) as ({ action: 'list' } | ({ action: 'mount' } & MountRequest))

    let text: string
    if (args.action === 'list') {
      text = JSON.stringify({ mounts: listMounts(kernel) })
    } else if (!processIsRoot(proc)) {
      text = JSON.stringify({ code: 1, lines: [{ stream: 'err', text: 'mount: only root can do that' }] })
    } else if (!shell) {
      text = JSON.stringify({ code: 1, lines: [{ stream: 'err', text: 'mount: no shell available for this process' }] })
    } else {
      text = JSON.stringify(await mountFilesystem(kernel, shell, args))
    }

    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  // `share`: offers a directory of this machine to another one, over a connection the kernel keeps open (so it has to
  // live
  // here and not in the worker that ran the command, which ends). Root only, like `mount`.
  define_syscall('peer_share', async (proc: Process, argsJson: string, path: string) => {
    const kernel = kernelOf(proc)
    const shell = shellOf(proc)
    const request = JSON.parse(argsJson) as ShareRequest
    let text: string
    if (!processIsRoot(proc)) text = JSON.stringify({ code: 1, lines: [{ stream: 'err', text: 'share: only root can do that' }] })
    else if (!shell) text = JSON.stringify({ code: 1, lines: [{ stream: 'err', text: 'share: no shell available for this process' }] })
    else text = JSON.stringify(await manageShare(kernel, shell, request))
    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  // `attach`: makes a device of another machine appear as /dev/NAME, over a connection the kernel keeps open. Root
  // only: it
  // creates a device node.
  define_syscall('peer_attach', async (proc: Process, argsJson: string, path: string) => {
    const kernel = kernelOf(proc)
    const shell = shellOf(proc)
    const request = JSON.parse(argsJson) as AttachRequest
    let text: string
    if (!processIsRoot(proc)) text = JSON.stringify({ code: 1, lines: [{ stream: 'err', text: 'attach: only root can do that' }] })
    else if (!shell) text = JSON.stringify({ code: 1, lines: [{ stream: 'err', text: 'attach: no shell available for this process' }] })
    else text = JSON.stringify(await manageAttach(kernel, shell, request))
    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  // `gateway`: the route to the real network through another machine, kept up by the kernel. Root only: it changes
  // where every
  // program's outbound connections go.
  define_syscall('gateway_ctl', async (proc: Process, argsJson: string, path: string) => {
    const kernel = kernelOf(proc)
    const shell = shellOf(proc)
    const request = JSON.parse(argsJson) as GatewayRequest
    let text: string
    if (!processIsRoot(proc) && request.action !== 'status') text = JSON.stringify({ code: 1, lines: [{ stream: 'err', text: 'gateway: only root can do that' }] })
    else if (!shell) text = JSON.stringify({ code: 1, lines: [{ stream: 'err', text: 'gateway: no shell available for this process' }] })
    else text = JSON.stringify(await manageGateway(kernel, shell, request))
    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  // `passkey`: WebAuthn only exists in the top-level browsing context (see `passkey-manage.ts`)
  define_syscall('auth_passkey', async (proc: Process, argsJson: string, path: string) => {
    const kernel = kernelOf(proc)
    const shell = shellOf(proc)
    const { subcommand, name, id } = JSON.parse(argsJson) as { subcommand: string, name?: string, id?: string }

    const outcome = shell
      ? await managePasskey(kernel, shell, subcommand, { name, id })
      : { code: 1, lines: [{ stream: 'err', text: 'Error: Current user not found' }] }

    const text = JSON.stringify(outcome)
    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  // `screensaver-daemon`: registers global DOM activity listeners. Returns 0 on start, 1 if the
  // configured screensaver isn't a registered one (the program reports that).
  define_syscall('screensaver_start', async (proc: Process) => {
    return kernelOf(proc).startScreensaverDaemon() ? 0 : 1
  })

  // `screensaver [NAME] [--set]`: draws over the page, so it runs here. `name === ''` means "the
  // saved one, else matrix"; `off` clears the saved default.
  define_syscall('screensaver_run', async (proc: Process, name: string, set: number, path: string) => {
    const kernel = kernelOf(proc)
    const outcome: Outcome = { code: 0, lines: [] }

    if (name === 'off') {
      kernel.storage.local.removeItem('screensaver')
    } else {
      const saverName = name || kernel.storage.local.getItem('screensaver') || 'matrix'
      const saver = kernel.screensavers.get(saverName)
      if (!saver) {
        outcome.code = 1
        outcome.lines.push({ stream: 'err', text: '\x1b[31mInvalid screensaver\x1b[0m' })
      } else {
        kernel.terminal.blur()
        saver.default({ terminal: kernel.terminal })
        if (set) kernel.storage.local.setItem('screensaver', saverName)
      }
    }

    const text = JSON.stringify(outcome)
    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  // `passwd`: changes the password of the user the kernel is running as; the program prompts and passes both
  // passwords. `chsh`: a user may change their own login shell, root anyone's; the shell must be in `/etc/shells` and
  // applies at the next login. The result is `{}` or `{ error }`.
  define_syscall('users_chsh', async (proc: Process, username: string, shellValue: string, path: string) => {
    const kernel = kernelOf(proc)
    const shell = shellOf(proc)
    let text: string
    try {
      if (!shell) throw new Error('no shell')
      const caller = identityOf(proc)
      const name = username || kernel.users.get(caller.uid)?.username || shell.username
      const target = Array.from(kernel.users.all.values()).find(u => u.username === name)
      if (!target) throw new Error(`user '${name}' does not exist`)
      if (target.uid !== caller.uid && caller.euid !== 0) throw new Error('permission denied')
      const listed = (await kernel.filesystem.fs.readFile('/etc/shells', 'utf-8')).split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'))
      if (!listed.includes(shellValue)) throw new Error(`${shellValue} is not listed in /etc/shells`)
      await kernel.users.update(target.uid, { shell: shellValue })
      text = JSON.stringify({ message: `shell for ${target.username} changed to ${shellValue}` })
    } catch (error) {
      text = JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  // What `su` and `sudo` ask before starting something as someone else: 1 when `password` is `username`'s.
  // Only a root process may ask (those two run with the setuid bit), so an ordinary program cannot use it
  // to guess passwords, only go through them, as on Linux.
  define_syscall('users_authenticate', async (proc: Process, username: string, password: string) => {
    requireRoot(proc, 'users_authenticate')
    try {
      await kernelOf(proc).users.login(username, password)
      return 1
    } catch {
      return 0
    }
  })

  // `umask(2)` for a program: sets the file mode creation mask of the calling process (a negative mask only asks)
  // and returns what it was. What the program starts afterwards inherits it, and the interpreter in its worker
  // takes it off the mode of everything the program creates.
  define_syscall('proc_umask', (proc: Process, mask: number) => {
    // the mask lives with the process; a negative argument asks without changing
    if (mask < 0) return umaskOf(proc)
    return setUmask(proc, mask)
  })

  // The most one file on the machine's storage may hold, in bytes (`ulimit -f`), or -1 when there is no limit.
  define_syscall('proc_file_limit', () => {
    const { maxFileBytes } = currentStorageLimits()
    return maxFileBytes === false ? -1 : maxFileBytes
  })

  // 1 when a program runs as the user who started it. `su` and `sudo` refuse to work otherwise: with
  // everything running as root they could not tell who was asking, and would hand root to anyone.
  define_syscall('credentials_supported', (proc: Process) => kernelOf(proc).programsRunAsUser ? 1 : 0)

  define_syscall('users_password', async (proc: Process, oldPassword: string, newPassword: string, path: string) => {
    const kernel = kernelOf(proc)
    let text: string
    try {
      if (!oldPassword || !newPassword) throw new Error('Missing password')
      await kernel.users.password(oldPassword, newPassword, identityOf(proc).uid)
      text = JSON.stringify({})
    } catch (error) {
      text = JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  // `connect`: signs a login challenge with the calling user's key (`~/.ssh/id_ecdsa`, made on first use). The
  // program asks for
  // the password and passes it here; the private key is decrypted in the kernel and only the signature and public key
  // go back.
  define_syscall('users_sign', async (proc: Process, password: string, dataBase64: string, path: string) => {
    const kernel = kernelOf(proc)
    let text: string
    try {
      if (!password) throw new Error('Missing password')
      const { publicKey, signature } = await kernel.users.signWithKey(identityOf(proc).uid, password, Uint8Array.from(atob(dataBase64), ch => ch.charCodeAt(0)))
      let encoded = ''
      for (const byte of signature) encoded += String.fromCharCode(byte)
      text = JSON.stringify({ publicKey, signature: btoa(encoded) })
    } catch (error) {
      text = JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  // A device's command line under a real process (`/bin/devcli`, see `device-cli.ts`): start returns the
  // pipe fd carrying its output, wait its exit code.
  define_syscall('device_cli_start', async (proc: Process, name: string, argsJson: string, path: string) => {
    const kernel = kernelOf(proc)
    let text: string
    try {
      text = JSON.stringify({ fd: startDeviceCli(kernel, proc, shellOf(proc), name, JSON.parse(argsJson) as string[]) })
    } catch (error) {
      text = JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
    }
    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  define_syscall('device_cli_wait', async (proc: Process) => await waitDeviceCli(proc))

  // What an `@ecmaos-apps/*` program's `params.kernel` exposes beyond stdio (see `bin/commands/app.mjs`):
  // the kernel's identity, this process's ids, and toasts - the DOM notifications apps raise.
  define_syscall('kernel_info', async (proc: Process, path: string) => {
    const kernel = kernelOf(proc)
    const credentials = identityOf(proc)
    const text = JSON.stringify({ name: kernel.name, id: kernel.id, pid: proc.pid, uid: credentials.uid, gid: credentials.gid })
    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  const toastKinds = ['success', 'error', 'info', 'warning'] as const
  define_syscall('dom_toast', async (proc: Process, kind: string, message: string) => {
    const kernel = kernelOf(proc)
    if (!(toastKinds as readonly string[]).includes(kind)) return -Errno.EINVAL
    const toast = kernel.dom.toast as unknown as Record<string, (message: string) => unknown>
    // Notyf has no `info`/`warning` of its own; `open` takes a type
    if (kind === 'success' || kind === 'error') toast[kind]!(message)
    else (kernel.dom.toast as unknown as { open: (options: { type: string, message: string }) => unknown }).open({ type: kind, message })
    return 0
  })

  // `shell_set_theme`: sets the calling shell's theme and updates the terminal. The program validates the name
  // against `ThemePresets` first.
  define_syscall('shell_set_theme', async (proc: Process, theme: string) => {
    const shell = shellOf(proc)
    if (!shell) return -Errno.ENOSYS
    shell.config.setTheme(theme)
    return 0
  })

  // `proc_spawn`, `proc_wait`, `proc_kill`: `spawn()`, `Process.wait()` and `kill()` are plain functions of a
  // `Process`, but a worker program has no reference to its own `Process`, so they are syscalls. The child is
  // registered with `registerProcessKernel` so it can make `custom()` calls too. Errors throw `Exception`s carrying a
  // real errno, which `dispatch()` preserves.
  // `optionsJson` is `{ env?, fds? }`: `env` replaces the shell's snapshot and `fds` maps child fd to caller fd (how
  // a pipeline is wired). See `job-control.ts`.
  define_syscall('proc_spawn', async (proc: Process, command: string, argvJson: string, cwd: string, optionsJson?: string) => {
    const kernel = kernelOf(proc)
    const shell = shellOf(proc)
    const argv = JSON.parse(argvJson) as string[]
    const options = optionsJson ? JSON.parse(optionsJson) as { env?: Record<string, string>, fds?: Record<string, number>, exactFds?: boolean, signals?: SignalState, pgid?: number, foreground?: boolean, setsid?: boolean, tty?: number, credentials?: { uid: number, gid: number, groups?: number[] }, trace?: TraceOptions & { fd: number } } : {}
    const terminal = options.tty === undefined ? undefined : (await kernel.shellForTty(options.tty).catch(() => undefined))?.terminal
    if (options.tty !== undefined && !terminal) throw Object.assign(new Error('No such terminal'), { errno: Errno.ENXIO })
    // Starting a program as someone else is `setuid` and `exec` in one: only a root process may, and it
    // takes effect only where programs can run as a user at all (otherwise everything is root, as before)
    let credentials: Credentials | undefined
    if (options.credentials) {
      requireRoot(proc, 'proc_spawn')
      if (kernel.programsRunAsUser) {
        const { uid, gid, groups = [] } = options.credentials
        credentials = { uid, gid, suid: uid, sgid: gid, euid: uid, egid: gid, groups: [...groups] }
      }
    }
    // `strace`: the trace is written to one of the caller's own descriptors, so it goes wherever the caller sends it
    let trace: ReturnType<typeof createTracer> | undefined
    if (options.trace) {
      const { fd, ...traceOptions } = options.trace
      trace = createTracer(traceOptions, traceSink(proc, fd))
    }
    const child = await spawnWithFds(proc, command, argv, options.env ?? shell?.envObject ?? proc.env, { cwd, fds: options.fds, exactFds: options.exactFds, signals: options.signals, pgid: options.pgid, foreground: options.foreground, setsid: options.setsid, terminal, credentials, trace })
    registerProcessKernel(child, kernel, shell)
    // A getty started during boot must not take the keyboard until boot is over: the kernel may still be
    // asking a question (the first-boot prompt) on the same terminal, and the answer would reach both.
    // `system_ready` gives the keyboard back.
    if (options.tty !== undefined && !kernel.ready) ttyHoldOf(child)?.suspend()
    return child.pid
  })

  // `fork(2)` for a WALI program built with Asyncify (`wali-host.mjs`): a child with a copy of the caller's descriptor
  // table (the open files shared, as on Linux), directory and credentials, running the same program on the copy of the
  // memory the caller made, which rewinds into the call. The caller gives its signal state; the handlers it has are the
  // child's too, from the start.
  define_syscall('proc_fork', async (proc: Process, exe: string, _interpreter: string, memory: WebAssembly.Memory, shared: SharedArrayBuffer, optionsJson: string) => {
    const kernel = kernelOf(proc)
    const shell = shellOf(proc)
    const options = JSON.parse(optionsJson) as { signals: SignalState } & Record<string, unknown>
    // from a thread, the child is the process's: its parent is the leader, whose descriptors, directory and credentials the thread shares
    const leader = leaderOf(proc)
    const fds = Object.fromEntries([...leader.context.descriptors.keys()].map(fd => [fd, fd]))
    const child = await spawnWithFds(leader, exe, leader.argv, { ...leader.env, __WALI_FORK__: '1' }, {
      cwd: leader.context.pwd, fds, exactFds: true, signals: options.signals, credentials: { ...leader.context.credentials }
    })
    registerProcessKernel(child, kernel, shell)
    for (const signal of leader.caught) child.catch_signal(signal)
    ;(child.thread as unknown as { host?: { post(message: unknown): void } }).host?.post({ $: 'wali-thread', memory, shared, fork: options })
    return child.pid
  })

  // `strace -p`: record the calls of a process that is already running. Root may trace anything but init's own
  // business is its own; anyone else only their own user's processes.
  define_syscall('trace_attach', async (proc: Process, pid: number, optionsJson: string) => {
    const target = processes.get(pid)
    if (!target || target.code !== undefined) throw Object.assign(new Error('No such process'), { errno: Errno.ESRCH })
    if (target === proc) throw Object.assign(new Error('Invalid argument'), { errno: Errno.EINVAL })
    const caller = identityOf(proc)
    if (caller.euid !== 0 && !mayKill(proc, target)) throw Object.assign(new Error('Operation not permitted'), { errno: Errno.EPERM })
    if (tracerOf(pid)) throw Object.assign(new Error('Operation not permitted'), { errno: Errno.EPERM })
    const { fd, ...traceOptions } = JSON.parse(optionsJson) as TraceOptions & { fd: number }
    const tracer = createTracer(traceOptions, traceSink(proc, fd))
    traceProcess(pid, tracer)
    void target.exited.then(async () => {
      await finishTrace(target, tracer).catch(() => {})
      untraceProcess(pid)
    })
    return 0
  })

  define_syscall('proc_wait', async (proc: Process, pid: number) => {
    return await proc.wait(pid)
  })

  // a child is the process's, not the thread's that made it: any thread may wait for it
  define_syscall('proc_waitpid', async (proc: Process, pid: number, flags: number) => waitpid(proc, pid, flags, leaderOf(proc)))
  // The signals a program was started with ignored (`which` 0) and blocked (1), and the ones it keeps across its own
  // `execve`: see `SignalState` in job-control.ts
  define_syscall('proc_sigstate', (proc: Process, which: number) => {
    const state = signalStateOf(proc.pid)
    return which === 1 ? state.blocked : state.ignored
  })
  define_syscall('proc_set_sigstate', (proc: Process, ignored: number, blocked: number) => {
    setSignalState(proc, { ignored, blocked })
    return 0
  })
  // A new image has no handlers: the signals the old program caught go back to their default action (the ignored ones
  // stay ignored, above). A forked child that runs a program keeps its parent's until then, and a SIGCHLD for a child
  // it made before the exec (bash makes the `<(...)` of `cat < <(...)` in the child, ahead of the exec) would
  // interrupt a read of the new program, which has no handler to ask for it to be restarted.
  const execveSyscall = syscalls.get('execve') as unknown as (proc: Process, ...args: unknown[]) => Promise<void | number | bigint>
  // Nor does a program's exec change what its terminal is in front of, as Linux's does not: upstream puts the new
  // program in front, which would take the terminal from a shell that started a background job (its child, in a group of
  // its own, execs the job) and make the shell a background process of its own terminal.
  syscalls.set('execve', async (proc: Process, ...args: unknown[]) => {
    const caught = [...proc.caught]
    const front = proc.tty?.foreground
    for (const signal of caught) proc.uncatch_signal(signal)
    try {
      const result = await execveSyscall(proc, ...args)
      if (proc.tty && front && front !== proc && front.code === undefined && proc.tty.foreground === proc) proc.tty.foreground = front
      return result
    } catch (error) {
      for (const signal of caught) proc.catch_signal(signal)
      throw error
    }
  })
  // `setuid(2)`, `setreuid`, `setresuid` and the group calls (`group` is 1 for those): `how` is 0 for setuid(a), 1 for
  // setreuid(a, b) and 2 for setresuid(a, b, c). Linux's rules are in `changeIds`.
  define_syscall('proc_setids', (proc: Process, group: number, how: number, a: number, b: number, c: number) => {
    const credentials = proc.context.credentials
    const [real, effective, saved] = group ? ['gid', 'egid', 'sgid'] as const : ['uid', 'euid', 'suid'] as const
    const next = changeIds(
      { real: credentials[real], effective: credentials[effective], saved: credentials[saved] },
      credentials.euid === 0, (['id', 're', 'res'] as const)[how] ?? 'id', a, b, c
    )
    if (!next) return -Errno.EPERM
    credentials[real] = next.real
    credentials[effective] = next.effective
    credentials[saved] = next.saved
    return 0
  })
  const answerWithIds = (proc: Process, ids: readonly number[]) => {
    const thread = thread_of(proc)
    const answer = new DataView(thread.region.buffer, thread.region.byteOffset)
    ids.forEach((id, i) => answer.setUint32(i * 4, id, true))
    return thread.filled(ids.length * 4)
  }
  // `getresuid(2)` and `getresgid(2)` (`group` is 1): the real, effective and saved ids, as three 32-bit numbers; and
  // `getgroups(2)`: the supplementary groups as 32-bit numbers
  define_syscall('proc_getids', (proc: Process, group: number) => {
    const { uid, euid, suid, gid, egid, sgid } = proc.context.credentials
    return answerWithIds(proc, group ? [gid, egid, sgid] : [uid, euid, suid])
  })
  define_syscall('proc_getgroups', (proc: Process) => answerWithIds(proc, proc.context.credentials.groups))
  // `setgroups(2)`: the supplementary groups, as the bytes of the caller's array of 32-bit ids; only root may
  define_syscall('proc_setgroups', (proc: Process, ids: Uint8Array) => {
    if (proc.context.credentials.euid !== 0) return -Errno.EPERM
    const view = new DataView(ids.buffer, ids.byteOffset, ids.byteLength)
    proc.context.credentials.groups = Array.from({ length: ids.byteLength >> 2 }, (_, i) => view.getUint32(i * 4, true))
    return 0
  })
  define_syscall('proc_setpgid', (proc: Process, pid: number, pgid: number) => setpgid(proc, pid, pgid))
  define_syscall('proc_getpgid', (proc: Process, pid: number) => {
    const target = pid === 0 ? proc : processes.get(pid)
    if (!target) throw Object.assign(new Error('No such process'), { errno: Errno.ESRCH })
    return getpgid(target)
  })
  // `tcsetpgrp(3)`: what the caller's terminal is in front of, which is who `^C` and `^Z` reach. Upstream
  // holds a process here rather than a group, so this takes a pid.
  define_syscall('proc_tcsetpgrp', (proc: Process, pid: number) => {
    const target = processes.get(pid)
    if (!proc.tty || !target) throw Object.assign(new Error('No such process'), { errno: Errno.ESRCH })
    proc.tty.foreground = target
    return 0
  })
  // Sessions: `setsid(2)`, `getsid(2)` and the controlling-terminal ioctls. `proc_ctty` takes 0 for `TIOCSCTTY` (arg 1
  // steals), 1 for `TIOCNOTTY` and 2 for `TIOCGSID`; the terminal is the one `fd` is open on.
  define_syscall('proc_setsid', (proc: Process) => setsid(proc))
  define_syscall('proc_getsid', (proc: Process, pid: number) => {
    const target = pid === 0 ? proc : processes.get(pid)
    if (!target || target.code !== undefined) throw Object.assign(new Error('No such process'), { errno: Errno.ESRCH })
    return getsid(target)
  })
  define_syscall('proc_ctty', (proc: Process, op: number, fd: number, arg: number) => {
    const kernel = kernelOf(proc)
    const handle = proc.context.descriptors.get(fd) as unknown as { path?: string, internalPath?: string } | undefined
    if (!handle) throw Object.assign(new Error('Bad file descriptor'), { errno: Errno.EBADF })
    const path = handle.path ?? handle.internalPath ?? ''
    const pts = /^(?:\/dev)?\/pts\/(\d+)$/.exec(path)
    const numbered = /^(?:\/dev)?\/tty(\d+)$/.exec(path)
    const tty = pts ? ptySlaveOf(Number(pts[1]))
      : numbered ? kernel.shells.get(Number(numbered[1]))?.terminal.zfsTty
      : /^(?:\/dev)?\/(?:tty|console)$/.test(path) ? proc.tty ?? undefined
      : undefined
    if (!tty) throw Object.assign(new Error('Inappropriate ioctl for device'), { errno: Errno.ENOTTY })
    if (op === 0) return setControllingTty(proc, tty, arg !== 0)
    if (op === 1) return dropControllingTty(proc)
    const sid = ttySession(tty)
    if (sid === undefined) throw Object.assign(new Error('Inappropriate ioctl for device'), { errno: Errno.ENOTTY })
    return sid
  })
  define_syscall('proc_killpg', (proc: Process, pgid: number, signal: number) => { killpg(pgid, signal, proc); return 0 })

  // `fs_chmod`, `fs_chown`, `fs_utimes`: changing a mode, owner or time needs ownership, not access, and the
  // installed `@zenfs/core` refuses directories and files the owner made read-only. The commands call these when
  // their own call is refused; the rule is Linux's (owner or root). Delete when `@zenfs/core` does this itself.
  define_syscall('fs_chmod', async (proc: Process, path: string, mode: number) => {
    const info = await statAsCaller(proc, path)
    const caller = proc.context.credentials
    if (caller.euid !== 0 && caller.euid !== info.uid) throw Object.assign(new Error('Operation not permitted'), { errno: Errno.EPERM })
    await kernelOf(proc).filesystem.fs.chmod(path, mode & 0o7777)
    return 0
  })

  define_syscall('fs_chown', async (proc: Process, path: string, uid: number, gid: number) => {
    const info = await statAsCaller(proc, path)
    const { euid, egid, groups } = proc.context.credentials
    // root may give a file to anyone; an owner may only move it to a group they belong to
    const allowed = euid === 0 || (euid === info.uid && uid === info.uid && (gid === info.gid || gid === egid || groups.includes(gid)))
    if (!allowed) throw Object.assign(new Error('Operation not permitted'), { errno: Errno.EPERM })
    await kernelOf(proc).filesystem.fs.chown(path, uid, gid)
    return 0
  })

  // Setting a file's times to chosen values is a matter of owning it (any caller with write access may set them to
  // the
  // present, which the plain call already allows). Asked when the plain `utimes` is refused: a directory, or a file
  // the
  // owner has made read-only. Times are seconds; a negative one means now.
  define_syscall('fs_utimes', async (proc: Process, path: string, atime: number, mtime: number, noFollow = 0) => {
    // `noFollow` stamps a symlink itself (`touch -h`, `lutimes(3)`) rather than its target
    const info = noFollow ? await lstatAsCaller(proc, path) : await statAsCaller(proc, path)
    const caller = proc.context.credentials
    if (caller.euid !== 0 && caller.euid !== info.uid) throw Object.assign(new Error('Operation not permitted'), { errno: Errno.EPERM })
    const now = Date.now() / 1000
    const fs = kernelOf(proc).filesystem.fs
    if (noFollow) await fs.lutimes(path, atime < 0 ? now : atime, mtime < 0 ? now : mtime)
    else await fs.utimes(path, atime < 0 ? now : atime, mtime < 0 ? now : mtime)
    return 0
  })

  define_syscall('proc_kill', async (proc: Process, pid: number, signal: number) => {
    const target = processes.get(pid)
    if (!target) throw Object.assign(new Error('No such process'), { errno: Errno.ESRCH })
    if (!mayKill(proc, target)) throw Object.assign(new Error('Operation not permitted'), { errno: Errno.EPERM })
    // `mayKill` reads the process context's credentials, which are root's for every program while the installed
    // @zenfs/core cannot run programs as their user, so it cannot tell users apart then; init is what a signal
    // can take the whole system down through, so it is guarded by the caller's identity as well.
    const kernel = kernelOf(proc)
    if (target === kernel.init.process && identityOf(proc).euid !== 0) throw Object.assign(new Error('Operation not permitted'), { errno: Errno.EPERM })
    // Signal 0 only asks whether the process exists and may be signalled, which is everything above
    if (signal === 0) return 0
    // A signal to a shell's own pid runs its trap for it, if it has one; the shell is not a worker to deliver to
    if (await kernel.shellOfPid(pid)?.deliverSignal(signal)) return 0
    zenfsKill(pid, signal)
    return 0
  })

  // `shell_exec`: runs a full command line through `kernel.system.execute()`; used by `crond` for crontab entries.
  // Pipeline stages still get pids.
  define_syscall('shell_exec', async (proc: Process, command: string) => {
    // it runs in the system shell, with root's authority, which no user's program may borrow
    requireRoot(proc, 'shell_exec')
    const kernel = kernelOf(proc)
    return await kernel.system.execute(command)
  })

  // What `/sbin/init` needs from the main thread (see `lib/init.ts`). Only pid 1 may call them: they
  // reap children and run the boot script, which no other program has any business doing.
  const initOf = (proc: Process) => {
    const init = kernelOf(proc).init
    if (!init || init.process !== proc) throw Object.assign(new Error('Only init may do this'), { errno: Errno.EPERM })
    return init
  }

  define_syscall('init_wait', async (proc: Process, timeoutMs: number) => initOf(proc).wait(timeoutMs))

  define_syscall('init_booted', (proc: Process) => { initOf(proc).markBooted(); return 0 })

  define_syscall('init_killall', (proc: Process, signal: number) => initOf(proc).killAll(signal))
  define_syscall('init_alive', (proc: Process) => initOf(proc).alive())

  // Stops the kernel: `reboot` shuts down and reloads the page, `halt` and `poweroff` only shut down.
  // Init calls it last, once everything else has stopped. A program can call it directly (`reboot -f`
  // and friends skip init) but only as root, since it kills the system without warning anything.
  define_syscall('system_stop', async (proc: Process, mode: string) => {
    const kernel = kernelOf(proc)
    const root = identityOf(proc).euid === 0
    if (proc !== kernel.init.process && !root) throw Object.assign(new Error('Permission denied (requires root)'), { errno: Errno.EPERM })
    if (mode !== 'reboot' && mode !== 'halt' && mode !== 'poweroff') throw Object.assign(new Error(`Unknown mode: ${mode}`), { errno: Errno.EINVAL })
    await kernel.stop(mode)
    return 0
  })

  // `/sbin/getty`'s half of a login: the program prompts; the kernel authenticates (including a passkey, which needs
  // the page) and starts the session. `login_begin` is 1 when a passkey already settled it; `login_session` writes `{
  // ok, ... }` to `path`, with the message on failure.
  define_syscall('login_begin', async (proc: Process, tty: number, username: string) => {
    requireRoot(proc, 'login_begin')
    return await kernelOf(proc).beginLogin(tty, username) ? 1 : 0
  })

  define_syscall('login_session', async (proc: Process, tty: number, username: string, password: string, path: string) => {
    requireRoot(proc, 'login_session')
    const kernel = kernelOf(proc)
    let result: unknown
    try {
      // a negative terminal number is a pty: there is no numbered terminal behind it
      result = { ok: true, ...(tty < 0 ? await kernel.ptyLogin(username, password) : await kernel.finishLogin(tty, username, password)) }
    } catch (error) {
      result = { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
    const text = JSON.stringify(result)
    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  // The built-in `ecmaos` shell has no program to run: the terminal's own line editor is the shell. The
  // calling login, and the getty that ran it, give up their holds on the keyboard for as long as the user is in it.
  define_syscall('login_builtin', async (proc: Process, tty: number) => {
    requireRoot(proc, 'login_builtin')
    const shell = await kernelOf(proc).shellForTty(tty)
    const holds = []
    for (let p: Process | undefined = proc; p; p = p.parent) {
      const hold = ttyHoldOf(p)
      if (hold) holds.push(hold)
    }
    for (const hold of holds) hold.suspend()
    try {
      await shell.terminal.runSession()
    } finally {
      for (const hold of holds) hold.resume()
    }
    return 0
  })

  // Resolves once boot has finished: a getty must not draw its prompt over the first-boot questions.
  define_syscall('system_ready', async (proc: Process) => {
    await kernelOf(proc).whenReady()
    ttyHoldOf(proc)?.resume()
    return 0
  })

  define_syscall('login_end', async (proc: Process, tty: number) => {
    requireRoot(proc, 'login_end')
    await kernelOf(proc).endLogin(tty)
    return 0
  })

  // A `#!ecmaos:bin:script:` file is run by the kernel's own shell, not by `execve`, so init cannot
  // `proc_spawn` it. This starts it as a child of init that exits with the script's status.
  define_syscall('init_script', (proc: Process, path: string, argsJson: string) => {
    const init = initOf(proc)
    const kernel = kernelOf(proc)
    const args = JSON.parse(argsJson) as string[]
    return init.script(kernel, path, args, () => kernel.runInitScript(path, args))
  })

  // `terminal_clear_history` and `terminal_reload_history`: act on the calling user's in-memory history buffer.
  define_syscall('terminal_clear_history', async (proc: Process) => {
    const shell = shellOf(proc)
    if (!shell) return -Errno.ENOSYS
    await shell.terminal.clearHistory(identityOf(proc).uid)
    return 0
  })

  define_syscall('terminal_reload_history', async (proc: Process) => {
    const shell = shellOf(proc)
    if (!shell) return -Errno.ENOSYS
    await shell.terminal.reloadHistory(identityOf(proc).uid)
    return 0
  })

  // `system_format`: root only; asks for confirmation through `shell.terminal.readline()` and deletes the IndexedDB
  // databases and `localStorage` before returning. Cancellation and failures are written as `{ cancelled: true }` or
  // `{ error }`; success as `{ messages }`. Rebooting is left to the caller.
  define_syscall('system_format', async (proc: Process, argsJson: string, path: string) => {
    const kernel = kernelOf(proc)
    const shell = shellOf(proc)
    let text: string

    if (!shell || identityOf(proc).euid !== 0) {
      text = JSON.stringify({ error: 'permission denied (requires root)' })
      await writeScratch(kernel, proc, path, text)
      return text.length
    }

    if (kernel.guest) {
      text = JSON.stringify({ error: 'this is a guest session: nothing is saved, and the machine in the other tab is not this tab\'s to format' })
      await writeScratch(kernel, proc, path, text)
      return text.length
    }

    try {
      const args = JSON.parse(argsJson) as { indexedDB: boolean, localStorage: boolean, keep: string[] }

      const confirmation = await shell.terminal.readline('Type "yes" to continue, or anything else to cancel: ')
      if (confirmation.trim().toLowerCase() !== 'yes') {
        text = JSON.stringify({ cancelled: true })
        await writeScratch(kernel, proc, path, text)
        return text.length
      }

      if (kernel.storage.db) kernel.storage.db.close()

      const messages: string[] = []

      if (args.indexedDB) {
        if (!globalThis.indexedDB) {
          messages.push('IndexedDB is not available')
        } else if (typeof indexedDB.databases === 'function') {
          const databases = await indexedDB.databases()
          // Other machines of this origin (`?machine=`) are not this one's to wipe: only this machine's own store
          // goes
          const own = machineStore(kernel.machine)
          const toDelete = databases.filter((db): db is { name: string, version: number } => typeof db.name === 'string' && !args.keep.includes(db.name) && (!isMachineStore(db.name) || db.name === own))

          for (const db of toDelete) {
            await new Promise<void>((resolve, reject) => {
              const request = indexedDB.deleteDatabase(db.name)
              request.onsuccess = () => resolve()
              request.onerror = () => reject(request.error)
              // Another open connection is blocking the delete - nothing left holds one open on
              // purpose at this point (this kernel's own `storage.db` was just closed above), so
              // treat this the same as success rather than hang the format indefinitely.
              request.onblocked = () => resolve()
            })
          }

          const kept = databases.filter(db => typeof db.name === 'string' && args.keep.includes(db.name))
          if (kept.length > 0) messages.push(`Preserved databases: ${kept.map(db => db.name).join(', ')}`)
          messages.push(`Deleted ${toDelete.length} IndexedDB database(s)`)
        } else {
          messages.push('indexedDB.databases() not supported, cannot enumerate databases to delete')
        }
      }

      if (args.localStorage) {
        // Keys that describe another machine's store stay: clearing them would make that machine install itself over
        // its own files
        const local = kernel.storage.local
        const prefix = kernel.machine ? `${MachineKeyPrefix}${kernel.machine}:` : undefined
        const doomed: string[] = []
        for (let at = 0; at < local.length; at++) {
          const key = local.key(at)
          if (key === null) continue
          if (prefix ? key.startsWith(prefix) : !key.startsWith(MachineKeyPrefix)) doomed.push(key)
        }
        for (const key of doomed) local.removeItem(key)
        messages.push(`Cleared localStorage (${doomed.length} item(s))`)
      }

      text = JSON.stringify({ messages })
    } catch (error) {
      text = JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
    }

    await writeScratch(kernel, proc, path, text)
    return text.length
  })
}
