/**
 * Custom syscalls that cross from a real, worker-isolated `@zenfs/linux` `Process` back onto the
 * main thread, for the handful of capabilities that only exist there (DOM window creation today;
 * Web Bluetooth and the Battery Status API are the reason this module exists at all -- neither is
 * exposed inside a Web Worker by spec, in any browser, ever, so no amount of worker-side code can
 * reach them directly).
 *
 * There is no separate "bridge" to build: `@zenfs/linux`'s own `Thread.syscall` (`thread.js`) already
 * runs `dispatch(this.proc, name, args)` on the main thread for every syscall, sync or async alike,
 * and unconditionally `await`s whatever the handler returns -- confirmed against the installed
 * package, and confirmed as real, working precedent by `read`/`write`/`poll`'s own handlers, which
 * already `await` an indefinite external event (`wait_event`/`wait_event_any` in `wait.js`), not just
 * a fast in-memory operation. `define_syscall` (`syscall/table.js`) is the whole registration surface;
 * this module's only real job is (a) registering a small, typed handler per capability, the same way
 * a Linux syscall is added one at a time, and (b) resolving which `Kernel` instance a given `Process`
 * belongs to, since `@zenfs/linux`'s `Process` has no notion of "kernel" at all and the `syscalls` map
 * is module-global -- shared across every `Kernel` instance in the same page (or test file: several
 * of this repo's own tests construct more than one `Kernel`).
 *
 * A syscall's numeric return (`dispatch`'s contract: a `number`, or a negative `-errno`) is the reason
 * every handler here returns a small integer *handle*, never the real object (`WinBox`, a `Bluetooth-
 * Device`, ...) -- those aren't structured-clone-safe across the syscall boundary in general, and the
 * return path is `i64`-shaped, not "any JS value." A handle is looked up again against `Windows`'s own
 * (or a future device driver's own) manager on each subsequent call, exactly the way a real fd is an
 * integer a program passes back to the kernel rather than the open file itself.
 */

import { define_syscall, kill as zenfsKill, processes, type Process } from '@zenfs/linux'
import { Errno } from 'kerium'

import type { Credentials } from '@zenfs/core'
import type { Kernel } from '#kernel.ts'
import { listMounts, mountFilesystem, type MountRequest } from './mount-backends.ts'
import { startDeviceCli, waitDeviceCli } from './device-cli.ts'
import { installFdLinks } from './fd-links.ts'
import { installPipeWakeup } from './pipe-wakeup.ts'
import { installPtys } from './pty.ts'
import { getpgid, killpg, mayKill, setpgid, spawnWithFds, ttyHoldOf, waitpid } from './job-control.ts'
import { managePasskey } from './passkey-manage.ts'
import type { Outcome } from './outcome.ts'
import { presenters } from './presenters/index.ts'
import type { Shell, SocketConnection } from '@ecmaos/types'

// Declaration merging into `@zenfs/linux`'s own `Syscalls` interface (`uapi/abi.d.ts`) -- the
// intended extension point for a custom syscall's argument/return shape, matching how `define_syscall`
// itself is generic over `keyof Syscalls`. Without this, `define_syscall('window_create', ...)` doesn't
// typecheck: `name` is constrained to the closed set `@zenfs/linux` ships.
declare module '@zenfs/linux/uapi/abi' {
  interface Syscalls {
    window_create(title: string): number
    window_write(handle: number, text: string): number
    window_close(handle: number): number
    window_present(kind: string, paramsJson: string, path: string): number
    storage_usage(path: string): number
    klog(level: string, message: string): number
    reboot(): number
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
    auth_passkey(argsJson: string, path: string): number
    screensaver_start(): number
    screensaver_run(name: string, set: number, path: string): number
    users_chsh(username: string, shellValue: string, path: string): number
    users_password(oldPassword: string, newPassword: string, path: string): number
    users_authenticate(username: string, password: string): number
    credentials_supported(): number
    proc_umask(mask: number): number
    kernel_info(path: string): number
    device_cli_start(name: string, argsJson: string, path: string): number
    device_cli_wait(): number
    dom_toast(kind: string, message: string): number
    shell_set_theme(theme: string): number
    proc_spawn(command: string, argvJson: string, cwd: string, optionsJson?: string): number
    proc_waitpid(pid: number, flags: number): number
    proc_setpgid(pid: number, pgid: number): number
    proc_getpgid(pid: number): number
    proc_killpg(pgid: number, signal: number): number
    proc_tcsetpgrp(pid: number): number
    proc_wait(pid: number): number
    proc_kill(pid: number, signal: number): number
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
    net_listen(key: string, backlog: number, path: string): number
    net_connect(key: string, path: string): number
    net_accept(key: string, nonblock: number, path: string): number
  }
}

/** Which `Kernel` owns a given real `Process` -- set once, at the one real `execve` call site. */
const kernelOfProcess = new WeakMap<Process, Kernel>()

/**
 * Which `Shell` spawned a given real `Process` -- needed alongside `kernelOfProcess` only by
 * `users_lookup` (see its own doc comment), for the *calling* process's own uid/gid/groups; every
 * other syscall in this module only ever needs the `Kernel`.
 */
const shellOfProcess = new WeakMap<Process, Shell>()

export function registerProcessKernel(proc: Process, kernel: Kernel, shell?: Shell): void {
  kernelOfProcess.set(proc, kernel)
  if (shell) shellOfProcess.set(proc, shell)
}

/**
 * Hands a handler's result to the program that asked for it, through the scratch file it named.
 *
 * The kernel writes as root, and `/tmp` is sticky, so a root-owned file there is one the calling user
 * could read but never delete. The file is therefore given to the caller (mode 0600, since it is
 * theirs alone), which is what lets `readBackAndDelete` clean up after itself.
 */
async function writeScratch(kernel: Kernel, proc: Process, path: string, text: string): Promise<void> {
  await kernel.filesystem.fs.writeFile(path, text, { mode: 0o600 })
  const { euid, egid } = proc.context.credentials
  if (euid !== 0) await kernel.filesystem.fs.chown(path, euid, egid)
}

function kernelOf(proc: Process): Kernel {
  const kernel = kernelOfProcess.get(proc)
  if (!kernel) throw Object.assign(new Error('No kernel registered for this process'), { errno: Errno.ENOSYS })
  return kernel
}

function shellOf(proc: Process): Shell | undefined {
  return shellOfProcess.get(proc)
}

/** The credentials a program acts with: its own when programs run as the user, else its shell's (everything runs as root then). */
function identityOf(proc: Process): Credentials {
  const shell = shellOf(proc)
  if (kernelOf(proc).programsRunAsUser || !shell) return proc.context.credentials
  return shell.credentials
}

/** Whether the calling process itself is privileged: what init, getty, login and crond are, and a user's program is not. */
function processIsRoot(proc: Process): boolean {
  return proc.context.credentials.euid === 0
}

/** Refuses a caller that is not a root process, for what only the system may do. */
function requireRoot(proc: Process, what: string): void {
  if (!processIsRoot(proc)) throw Object.assign(new Error(`${what}: Operation not permitted`), { errno: Errno.EPERM })
}

/** What `sockets_connect` learned about how each connection ended, until `sockets_result` collects it. */
interface SocketResult { opened: boolean, messages: number, code?: number, reason?: string }
const socketResults = new Map<string, SocketResult>()

/**
 * A loopback POSIX socket listener (`net_bind`/`net_listen`/`net_connect`/`net_accept`, the
 * `env.__syscall_socket`/`bind`/`listen`/`connect`/`accept4` translation's main-thread half). No
 * real internet socket exists in a browser at all -- there is no raw TCP/UDP API, full stop, and
 * every "socket support" claim from a browser-based Unix (WebContainers, Browsix) turns out to
 * mean exactly this: loopback/inter-process sockets, not real external connectivity. Real network
 * I/O for an ecmaOS program is `kernel.sockets` (`sockets_connect` et al., above), unchanged; this
 * is what an unmodified POSIX binary's `socket()`/`bind()`/`connect()` calls actually get when the
 * target is loopback, so it runs for real instead of not running at all.
 *
 * `key` is the canonical address this listener is reachable at (`unix:<path>` or
 * `inet:<host>:<port>`, host always normalized to `127.0.0.1` -- see `net_bind`). `queue` holds an
 * already-connected pair for each pending, not-yet-`accept4`ed connection, in the order
 * `net_connect` created them: real fds already linked into `serverProc`'s own context via
 * `Kernel.linkProcesses` (not bridged/pumped -- the client and the eventual accepting program talk
 * directly to each other's real pipe), just not yet handed to the program's own `fds` table.
 */
interface LoopbackListener {
  key: string
  serverProc: Process
  listening: boolean
  queue: Array<{ fd: number, writeFd: number, peerKey: string }>
}
const loopbackListeners = new Map<string, LoopbackListener>()
let nextEphemeralPort = 49152

/** Normalizes an `AF_INET`/`AF_INET6` bind/connect target; anything not loopback is rejected by
 * the caller before this is even consulted -- see `net_bind`/`net_connect`'s own checks. */
function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '0.0.0.0' || host === '::1' || host === '::' || host === 'localhost'
}

/** Handles the running program can reference; not persisted beyond one boot, same as `Windows` itself. */
let nextWindowHandle = 1
const windowHandles = new Map<number, string>() // handle -> Windows' own WindowId

/**
 * Unlike `Windows`, `kernel.sockets`' own connections are already keyed by a real, structured-
 * clone-safe string (`crypto.randomUUID()`) -- so the `sockets_*` syscalls below pass that id
 * straight through as a syscall argument instead of minting a second, handle-based indirection
 * layer the way `window_*` needs to. This mirrors `sockets.ts`'s own `findConnectionById` (the
 * legacy in-process command's fuzzy 8-char-prefix match), ported here since only the main thread
 * can see `kernel.sockets.all()` at all.
 */
function findSocketConnection(kernel: Kernel, id: string) {
  const fullMatch = kernel.sockets.get(id)
  if (fullMatch) return fullMatch

  for (const [fullId, conn] of kernel.sockets.all().entries()) {
    if (fullId.startsWith(id) || fullId.substring(0, 8) === id) return conn
  }
  return undefined
}

/**
 * Registers this module's syscalls in `@zenfs/linux`'s module-global `syscalls` table.
 *
 * Idempotent: `define_syscall` throws `EEXIST` on a second registration of the same name, and this
 * module's own registrations must survive more than one `Kernel` being constructed in the same page
 * or test process (confirmed: `kernel.test.ts` and `protocol.test.ts` each construct several) -- so
 * this only ever registers once per process lifetime, tracked here rather than relying on the second
 * `Kernel`'s call silently failing in some more surprising way.
 */
let installed = false
export function installMainThreadSyscalls(): void {
  if (installed) return
  installed = true
  installFdLinks()
  installPipeWakeup()
  installPtys()

  define_syscall('window_create', async (proc: Process, title: string) => {
    const kernel = kernelOf(proc)
    const win = kernel.windows.create({ title: title || 'Untitled' })
    const handle = nextWindowHandle++
    windowHandles.set(handle, String(win.id))
    return handle
  })

  /**
   * Runs the presenter registered for `kind` (`#lib/presenters/index.ts`) on the main thread and
   * reports the outcome as `{ result }` or `{ error }` in the scratch file at `path` -- the same convention
   * as the `sockets_*` handlers, because a thrown `Error` collapses to a bare `-EIO` and loses the
   * message. `kind` is looked up in a fixed table, never evaluated.
   */
  define_syscall('window_present', async (proc: Process, kind: string, paramsJson: string, path: string) => {
    const kernel = kernelOf(proc)
    let text: string

    try {
      const presenter = Object.hasOwn(presenters, kind) ? presenters[kind] : undefined
      if (!presenter) throw new Error(`unknown presenter: ${kind}`)
      const presented = await presenter(kernel, proc, JSON.parse(paramsJson) as Record<string, unknown>, shellOf(proc))
      let result: unknown = presented?.result ?? null

      if (presented?.closed) {
        // Hold the program here until what was presented is finished -- or the process itself ends
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

  define_syscall('window_write', async (proc: Process, handle: number, text: string) => {
    const kernel = kernelOf(proc)
    const id = windowHandles.get(handle)
    if (!id) return -Errno.EBADF
    const win = kernel.windows.get(id)
    if (!win) return -Errno.EBADF
    win.body.textContent = ((win.body.textContent || '') + text)
    return text.length
  })

  define_syscall('window_close', async (proc: Process, handle: number) => {
    const kernel = kernelOf(proc)
    const id = windowHandles.get(handle)
    if (!id) return -Errno.EBADF
    kernel.windows.close(id)
    windowHandles.delete(handle)
    return 0
  })

  // A syscall's return must be `number | bigint | void` (`dispatch`'s contract, enforced by
  // `SyscallHandler`'s own type) -- there's no string-returning custom syscall shape available, so
  // `storage_usage` writes its JSON into a real file under `/tmp` instead (real `/proc` is
  // `@zenfs/linux`'s synthetic, read-only `ProcFS` -- not a place this can write into): a worker-
  // hosted `df` just `open`+`read`s the file back with the plain filesystem syscalls it already
  // has, no custom syscall needed on the read side at all. The write-then-signal-length return keeps
  // the caller from racing a read against an unfinished write.
  define_syscall('storage_usage', async (proc: Process, path: string) => {
    const kernel = kernelOf(proc)
    const usage = await kernel.storage.usage()
    const text = JSON.stringify(usage ?? {})
    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  // A worker process's syslog-style escape hatch: writes to `kernel.log` (tslog, already piped to
  // `/var/log/kernel.log` via `Kernel.boot`'s own transport) instead of the program's own stdout/
  // stderr, so a daemon's routine bookkeeping (`crond` starting up, a job failing on some future
  // tick) never lands in an interactive terminal it happens to share a session with -- the same
  // distinction real syslog draws between a daemon's controlling tty and `/var/log/*`. `level` is
  // whatever `kernel.log` itself exposes (`info`/`warn`/`error`/`debug`/`fatal`); an unrecognized one
  // falls back to `info` rather than throwing, since a bad level string is never worth crashing the
  // caller over.
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

  // `kernel.activeTty` is a plain number already, so unlike `storage_usage` this needs no
  // scratch-file round trip at all -- it fits `dispatch`'s `number` return directly.
  define_syscall('tty_get', async (proc: Process) => {
    const kernel = kernelOf(proc)
    return kernel.activeTty
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

  // `kernel.sockets` is a live, main-thread-only registry of real `WebSocket`/`WebTransport`
  // instances -- reached the same way `storage_usage` reach other live `Kernel` state,
  // via the write-JSON-to-a-scratch-file convention (a syscall's return must be `number | bigint |
  // void`, see that doc comment above).
  //
  // `create`/`close`/`show` write `{ error: message }` to the scratch file on failure instead of
  // throwing -- confirmed by hand against the installed package's `dispatch()` (`syscall/table.js`):
  // it catches every thrown error, and only preserves it as a real `-errno` when the error carries a
  // numeric `.errno` property (as `kernelOf`'s own `ENOSYS` throw does); a plain `throw new
  // Error(message)`, exactly what "connection not found"/"WebTransport is not supported"/etc. are,
  // gets logged as a "kernel bug" and collapsed into a bare `-EIO` with the real message discarded
  // entirely -- caught in this session's own tests before it shipped (`sockets show` against an
  // unknown ID surfaced as `EIO: i/o error`, not the real "connection not found" message). The
  // scratch file is the one channel that reliably carries a string across this boundary either way,
  // so failure uses it too, rather than trying to keep two different error-reporting paths working.
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
   * Connects a socket and hands it to the calling program as two real file descriptors (`rx`, which
   * yields what the peer sends, and `tx`, which sends what is written) that it can `read`, `write` and
   * `poll` like any other -- `Kernel.attachStream`. The connection is still an ordinary
   * `kernel.sockets` entry, so `sockets list` sees it for as long as it is open, and it is closed if
   * the process dies with it still open (a `^C`ed `nc`). How it ended is left for `sockets_result`.
   * Writes `{ id, rx, tx }` (or `{ error }`) to `path`, the same convention as `sockets_create`.
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

  /** `family`: `'unix'` or `'inet'` (`'inet6'` isn't supported -- `sockaddr_in6`'s layout wasn't
   * worth the extra surface for a first loopback-only pass; `-EAFNOSUPPORT` from the worker side
   * before this is ever reached). `addr`/`port` are `''`/`0` for `unix` (the socket's own path is
   * `addr`, unused). `port: 0` picks the next ephemeral port, same meaning as real Linux. Writes
   * `{ ok, key, port? }` or `{ error }` to `path`, the same convention every `sockets_*` syscall
   * above already uses. */
  define_syscall('net_bind', async (proc: Process, family: string, addr: string, port: number, path: string) => {
    const kernel = kernelOf(proc)
    let text: string

    // A dead server must not leave its address permanently squatted -- the next bind to the same
    // address (very common: restart the same local dev server) has to see it as free again.
    const register = (key: string) => {
      loopbackListeners.set(key, { key, serverProc: proc, listening: false, queue: [] })
      void proc.exited.then(() => { if (loopbackListeners.get(key)?.serverProc === proc) loopbackListeners.delete(key) })
    }

    if (family === 'unix') {
      const key = `unix:${addr}`
      if (loopbackListeners.has(key)) text = JSON.stringify({ error: 'EADDRINUSE' })
      else {
        register(key)
        text = JSON.stringify({ ok: true, key })
      }
    } else if (family === 'inet') {
      if (addr && !isLoopbackHost(addr)) {
        text = JSON.stringify({ error: 'EADDRNOTAVAIL' })
      } else {
        const assigned = port || nextEphemeralPort++
        const key = `inet:127.0.0.1:${assigned}`
        if (loopbackListeners.has(key)) text = JSON.stringify({ error: 'EADDRINUSE' })
        else {
          register(key)
          text = JSON.stringify({ ok: true, key, port: assigned })
        }
      }
    } else {
      text = JSON.stringify({ error: 'EAFNOSUPPORT' })
    }

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
      void backlog // accepted but not enforced -- the queue is unbounded; a real backlog limit
      // would need net_connect to reject once full, not worth it for a loopback-only first pass.
      text = JSON.stringify({ ok: true })
    }

    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  /**
   * Creates the real, full-duplex link (two directed `Kernel.linkProcesses` pipes, one per
   * direction) between the calling process and `key`'s listener, and hands the accepting side's
   * fds to the listener's `queue` for `net_accept` to hand out later. Writes `{ fd, writeFd }` (the
   * connecting side's own real fds -- `fd` to read, `writeFd` to write) or `{ error }`.
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
      listener.queue.push({ fd: toServer.readerFd, writeFd: toClient.writerFd, peerKey: `client:${proc.pid}` })
      text = JSON.stringify({ fd: toClient.readerFd, writeFd: toServer.writerFd })
    }

    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  /** Pops the next already-connected pair off `key`'s queue. `nonblock`: return `{ pending: true }`
   * immediately on an empty queue instead of leaving the worker to poll-retry (its own choice, made
   * by whether the socket has `O_NONBLOCK`/`SOCK_NONBLOCK` set -- this syscall itself never blocks
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

  // `id`/`groups` need to resolve arbitrary usernames/uids against the live user registry
  // (`kernel.users`) -- no execve-compatible equivalent exists for that, and `groups` even supports
  // looking up a user other than the caller's own (`groups someoneelse`), so this can't be
  // pre-snapshotted into env at spawn time the way `id`/`groups`' *own*-process values could be.
  // `query` is a small JSON request object; the response (also JSON, written to `path` the same way
  // `storage_usage` do, per this module's own doc comment on why a custom syscall can't
  // just return a string) is a plain array of `{ uid, gid, groups, username }` entries -- password
  // hashes and keypairs are never included, this is a read-only identity lookup, not a full user
  // record dump.
  //
  // `mode: 'self'` additionally resolves the *calling* process's own uid/gid/groups from
  // `shellOf(proc)`'s live `Credentials` -- there's no real syscall for "my supplementary groups"
  // (`getuid`/`geteuid`/`getgid`/`getegid` exist in `@zenfs/linux`, `getgroups` does not), so this one
  // mode is the only way a worker program can see its own `groups` list at all.
  define_syscall('users_lookup', async (proc: Process, query: string, path: string) => {
    const kernel = kernelOf(proc)
    const request = JSON.parse(query) as
      | { mode: 'self' }
      | { mode: 'byUid', uid: number }
      | { mode: 'byUsername', username: string }

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
    } else {
      const match = Array.from(kernel.users.all.values()).find(u => u.username === request.username)
      result = match ? toRecord(match.uid) : null
    }

    const text = JSON.stringify(result)
    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  // `list`/`add`/`del`/`mod` all gate on the *calling* process's own credentials (`suid !== 0`,
  // matching the legacy command's own permission check exactly -- note this covers `list` too, not
  // just the three mutating actions, since the original command gated every subcommand the same
  // way), and `add`/`mod -p` may need to prompt for a password interactively via
  // `shell.terminal.readline()` when one isn't supplied on the command line -- all of this is
  // reachable only through `shellOf(proc)`, so unlike every other syscall in this module,
  // `users_manage` needs the calling `Shell`, not just the `Kernel`. `list` could have reused
  // `users_lookup` (its read-only shape is identical), but that syscall's other modes are
  // deliberately permission-free (`id`/`groups` on oneself, or looking up one other user by name)
  // and giving `list` its own permission check there would have meant carrying `shellOf(proc)`'s
  // credentials into a syscall that otherwise never needs a permission gate at all -- simpler to
  // keep `list` here, next to the other three actions that already need the same gate.
  //
  // Every failure (permission denied, bad arguments, a user that doesn't/already does exist, a
  // password mismatch) is written to the scratch file as `{ error: message }` rather than thrown --
  // see `sockets_create`'s doc comment above for why a thrown `Error` doesn't reliably survive the
  // trip back to the worker at all.
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

        // `Users.remove()` (`tree/users.ts`) already rewrites both /etc/passwd and /etc/group from
        // its own in-memory map once the user is deleted -- but it never touches /etc/shadow at
        // all, so that still needs manual cleanup here.
        await kernel.filesystem.fs.writeFile('/etc/shadow',
          (await kernel.filesystem.fs.readFile('/etc/shadow', 'utf8')).split('\n').filter(line => !line.startsWith(`${username}:`)).join('\n'))

        text = JSON.stringify({ message: `user '${username}' deleted successfully`, warning })
      } else if (action === 'mod') {
        const username = args['username'] as string
        const allUsers = Array.from(kernel.users.all.values())
        const usr = allUsers.find(u => u.username === username)
        if (!usr) throw new Error(`user '${username}' does not exist`)

        const updates: Record<string, unknown> = {}
        if (args['shellValue'] !== undefined) updates['shell'] = args['shellValue']
        if (args['gid'] !== undefined) updates['gid'] = args['gid']

        if (args['changePassword']) {
          const newPassword = await shell.terminal.readline('New password: ', true)
          const confirm = await shell.terminal.readline('Retype new password: ', true)
          if (newPassword !== confirm) throw new Error('password mismatch')

          const hashedPassword = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(newPassword.trim()))
          updates['password'] = Array.from(new Uint8Array(hashedPassword)).map(b => b.toString(16).padStart(2, '0')).join('')
        }

        if (Object.keys(updates).length === 0) throw new Error('no changes specified')

        await kernel.users.update(usr.uid, updates)
        text = JSON.stringify({ message: `user '${username}' modified successfully` })
      } else {
        throw new Error(`unknown action: ${action}`)
      }
    } catch (error) {
      text = JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
    }

    await writeScratch(kernel, proc, path, text)
    return text.length
  })

  // Real Linux `umount(2)` is itself a syscall, not filesystem I/O -- this is the one command in the
  // "portable" bucket that's arguably closer to "the Linux way" as a custom syscall than any plain
  // fs operation would be. `kernel.filesystem.mounts` (the live mount-point registry) and
  // `kernel.filesystem.fsSync.umount()` (the actual unmount) are both main-thread-only `Kernel`
  // state, reached the same way `sockets_*`/`users_manage` reach theirs.
  //
  // `target === ''` means "unmount everything except `/`" (`umount -a`), matching the legacy
  // command's own loop -- done here, in one syscall round trip, rather than making the worker call
  // this syscall once per mount point after a separate list syscall. Every result (success or
  // per-target failure) goes into one JSON array written to the scratch file, following the
  // `{ error: message }` convention (see `sockets_create`'s doc comment) for why nothing here throws
  // a plain `Error` across the syscall boundary.
  define_syscall('fs_umount', async (proc: Process, target: string, path: string) => {
    requireRoot(proc, 'umount')
    const kernel = kernelOf(proc)
    const results: Array<{ target: string, error?: string }> = []

    const unmountOne = (mountTarget: string) => {
      try {
        kernel.filesystem.fsSync.umount(mountTarget)
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

  // `mount`: the backends need the live mount table, browser storage/File System Access APIs and (for
  // Google Drive) `document.head` script injection plus an OAuth popup -- all main-thread only. The
  // program parses arguments; `mountFilesystem` (`mount-backends.ts`) is the original command body,
  // and reports the lines to print plus an exit code, like every "whole command" syscall here.
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

  // `passwd`: changes the password of the user the kernel is running as. The program does the
  // prompting (with echo off) and passes both passwords here; the result is `{}` or `{ error }`.
  // `chsh`: a user may change their own login shell, root anyone's. The shell must be listed in
  // `/etc/shells`; the change takes effect at the next login, as on Linux.
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

  // `umask(2)` for a program: sets the file mode creation mask of the caller's own context (a negative mask only
  // asks) and returns what it was, or -1 where the installed @zenfs/core has no such thing. What the program
  // starts afterwards inherits it.
  define_syscall('proc_umask', (proc: Process, mask: number) => {
    const context = proc.context as { umask?: number }
    if (typeof context.umask !== 'number') return -1
    const old = context.umask
    if (mask >= 0) context.umask = mask & 0o777
    return old
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
  // the kernel's identity, this process's ids, and toasts -- the DOM notifications apps raise.
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

  // `shell.config.setTheme()` mutates the calling `Shell`'s own live `TerminalConfig` and immediately
  // calls `terminal.updateConfig()` -- both are main-thread-only `Shell`/`Terminal` state, unlike
  // every syscall above this needs `shellOf(proc)`, not just `kernelOf(proc)`. `setTheme()` itself
  // silently no-ops on an unrecognized preset name rather than throwing (`shell.ts`), so the calling
  // worker program validates the name against `ThemePresets` itself before ever reaching this
  // syscall -- there's nothing for this handler to fail on, so unlike `fs_umount`/`users_manage` it
  // needs no scratch-file round trip, just a plain `0`/`-errno` return.
  define_syscall('shell_set_theme', async (proc: Process, theme: string) => {
    const shell = shellOf(proc)
    if (!shell) return -Errno.ENOSYS
    shell.config.setTheme(theme)
    return 0
  })

  // `spawn()`/`Process.wait()`/`kill()` (`@zenfs/linux`'s `process.js`/`fs/exec.js`) are real process
  // creation (a new process running `execve` -- there is no copy-on-write `fork()`), `waitpid()` and
  // `kill()` -- not main-thread-only capabilities like everything above, they're plain functions any
  // `Process` object can call. The only reason these need to be
  // custom syscalls at all is that they're free functions taking a `Process` object as an argument,
  // and a worker-hosted program only ever sees itself as an opaque id inside `@zenfs/linux`'s own
  // syscall machinery -- it has no direct JS reference to its own `Process` object to call
  // `parent.wait()` on. `kernelOf(proc)`/`shellOf(proc)` resolve nothing these three need beyond
  // `proc` itself (the calling process, i.e. `spawn()`'s `parent`) -- registered here purely so the
  // *child* `proc_spawn` creates can itself later make `custom()` calls of its own (`registerProcess-
  // Kernel`, the exact same call `executeViaExecve` makes for a shell-launched process).
  //
  // Errors here are deliberately left to throw and propagate as real `-errno` returns, unlike every
  // scratch-file-using syscall above: `spawn`/`wait`/`kill` all throw `@zenfs/linux`'s own `Exception`
  // (via kerium's `withErrno`/`UV`), which already carries a real numeric `.errno` -- exactly the
  // shape `dispatch()` (`syscall/table.js`) needs to preserve a thrown error as a real `-errno`
  // instead of collapsing it to `-EIO` (see `sockets_create`'s doc comment on that). And the worker's
  // own `syscall_async` (`uapi/base.js`) reconstructs a real, correctly-named error (`ENOENT`,
  // `ECHILD`, `ESRCH`, ...) from that `-errno` automatically -- so a program calling `custom('proc_wait',
  // ...)` on a pid that was never its child gets a real `ECHILD` back, not a generic failure.
  // `optionsJson` is `{ env?, fds? }`: `env` replaces the shell's snapshot (so `FOO=bar cmd` and a
  // per-command environment work from a worker) and `fds` maps child fd -> caller fd (`posix_spawn`
  // file actions, how a pipeline is wired). See `job-control.ts` for the removal path.
  define_syscall('proc_spawn', async (proc: Process, command: string, argvJson: string, cwd: string, optionsJson?: string) => {
    const kernel = kernelOf(proc)
    const shell = shellOf(proc)
    const argv = JSON.parse(argvJson) as string[]
    const options = optionsJson ? JSON.parse(optionsJson) as { env?: Record<string, string>, fds?: Record<string, number>, pgid?: number, tty?: number, credentials?: { uid: number, gid: number, groups?: number[] } } : {}
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
    const child = await spawnWithFds(proc, command, argv, options.env ?? shell?.envObject ?? proc.env, { cwd, fds: options.fds, pgid: options.pgid, terminal, credentials })
    registerProcessKernel(child, kernel, shell)
    // A getty started during boot must not take the keyboard until boot is over: the kernel may still be
    // asking a question (the first-boot prompt) on the same terminal, and the answer would reach both.
    // `system_ready` gives the keyboard back.
    if (options.tty !== undefined && !kernel.ready) ttyHoldOf(child)?.suspend()
    return child.pid
  })

  define_syscall('proc_wait', async (proc: Process, pid: number) => {
    return await proc.wait(pid)
  })

  define_syscall('proc_waitpid', async (proc: Process, pid: number, flags: number) => waitpid(proc, pid, flags))
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
  define_syscall('proc_killpg', (proc: Process, pgid: number, signal: number) => { killpg(pgid, signal, proc); return 0 })

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

  // `kernel.shell.execute()` is the one thing in this module that runs a *full shell command line*
  // (pipes, redirects, the works) rather than a single program -- main-thread-only since `Shell` is a
  // persistent object tied to a `Terminal`, not something `proc_spawn` can hand a worker a real
  // `execve`-shaped binary for (there is no `/bin/sh -c` interpreter in ecmaOS to `proc_spawn` in the
  // first place). This exists for `crond` (`src/bin/commands/crond.mjs`) to fire a crontab entry's
  // command line exactly the way the old `kernel.intervals`-based scheduler did (`kernel.shell.execute
  // (entry.command)`), preserving pipe/redirect support in a cron job with zero behavior change --
  // individual pipeline stages `kernel.shell.execute()` itself launches via `executeViaExecve` still
  // get real pids visible in `ps` (visible in `ps`, which reads `/proc`), even though the job as a
  // whole has no single pid of its own, the same limitation real `crond`'s `sh -c` child has for a
  // multi-stage pipeline.
  define_syscall('shell_exec', async (proc: Process, command: string) => {
    // it runs in the kernel's own shell, with that shell's authority, which no user's program may borrow
    requireRoot(proc, 'shell_exec')
    const kernel = kernelOf(proc)
    return await kernel.shell.execute(command)
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

  // `/sbin/getty`'s half of a login. The prompts and the password are the program's; authenticating (and
  // a passkey, which needs the page rather than a worker) and starting the session are the kernel's.
  // `login_begin` is 1 when a passkey already settled it; `login_session` writes `{ ok, ... }` to `path`,
  // a failure carrying the message to show, since an errno would lose it.
  define_syscall('login_begin', async (proc: Process, tty: number, username: string) => {
    requireRoot(proc, 'login_begin')
    return await kernelOf(proc).beginLogin(tty, username) ? 1 : 0
  })

  define_syscall('login_session', async (proc: Process, tty: number, username: string, password: string, path: string) => {
    requireRoot(proc, 'login_session')
    const kernel = kernelOf(proc)
    let result: unknown
    try {
      result = { ok: true, ...await kernel.finishLogin(tty, username, password) }
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

  // `shell.terminal.clearHistory()`/`reloadHistory()` mutate/re-read the live, in-memory history
  // buffer a real `Terminal` keeps for its own up-arrow recall -- `history`'s own file-backed
  // list/`-d` work stays plain fs syscalls (no kernel state involved), only `-c`/`-r` need this,
  // exactly the two flags `history.ts` (the legacy command) already routed through `terminal.
  // clearHistory`/`reloadHistory` rather than touching the file behind the terminal's back. Zero
  // arguments: the uid is always the calling process's own (`shellOf(proc)`'s live credentials), the
  // same "self" scoping `users_lookup`'s own `mode: 'self'` uses -- there's no legitimate case for
  // clearing or reloading another user's history from here.
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

  // `format` needs three things no worker can reach on its own: the permission gate (`suid !== 0`,
  // same convention as `users_manage`), an interactive `shell.terminal.readline()` confirmation
  // prompt (there is no yes/no confirmation primitive on the worker side, same reasoning as
  // `users_manage`'s password prompts), and real `indexedDB`/`localStorage` access -- `indexedDB` is
  // spec'd to exist in a Worker, but `kernel.storage.local` (`globalThis.localStorage`) is main-thread
  // only, so both live here together rather than splitting the two stores across two different
  // execution contexts for no benefit.
  //
  // Real improvement over the legacy command, not just a port: the old `format.ts` only ever computed
  // which IndexedDB databases *would* be emptied and printed a "Will empty on reboot" message --
  // nothing anywhere actually called `indexedDB.deleteDatabase()`, so a real reboot never followed
  // through on that promise (confirmed by grepping `kernel.ts`'s boot path for any trace of it). This
  // syscall actually deletes them, synchronously, before it returns -- `format` genuinely formats now.
  //
  // Cancellation and per-step failures are written to the scratch file as `{ cancelled: true }` /
  // `{ error: message }`, matching `sockets_create`'s convention; on success `{ messages: [...] }`
  // carries the human-readable summary lines the worker prints. Rebooting is deliberately left to the
  // caller (a plain `custom('reboot')` after this returns, reusing the existing `reboot` syscall)
  // rather than folded in here -- keeps this syscall's own job to "do the destructive thing safely",
  // not "and also shut down every subsystem", which `reboot`'s handler already owns end to end.
  define_syscall('system_format', async (proc: Process, argsJson: string, path: string) => {
    const kernel = kernelOf(proc)
    const shell = shellOf(proc)
    let text: string

    if (!shell || identityOf(proc).euid !== 0) {
      text = JSON.stringify({ error: 'permission denied (requires root)' })
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
          const toDelete = databases.filter((db): db is { name: string, version: number } => typeof db.name === 'string' && !args.keep.includes(db.name))

          for (const db of toDelete) {
            await new Promise<void>((resolve, reject) => {
              const request = indexedDB.deleteDatabase(db.name)
              request.onsuccess = () => resolve()
              request.onerror = () => reject(request.error)
              // Another open connection is blocking the delete -- nothing left holds one open on
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
        const count = kernel.storage.local.length
        kernel.storage.local.clear()
        messages.push(`Cleared localStorage (${count} item(s))`)
      }

      text = JSON.stringify({ messages })
    } catch (error) {
      text = JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
    }

    await writeScratch(kernel, proc, path, text)
    return text.length
  })
}
