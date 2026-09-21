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

import { define_syscall, type Process } from '@zenfs/linux'
import { Errno } from 'kerium'

import type { Kernel } from '#kernel.ts'
import type { Shell } from '@ecmaos/types'

// Declaration merging into `@zenfs/linux`'s own `Syscalls` interface (`uapi/abi.d.ts`) -- the
// intended extension point for a custom syscall's argument/return shape, matching how `define_syscall`
// itself is generic over `keyof Syscalls`. Without this, `define_syscall('window_create', ...)` doesn't
// typecheck: `name` is constrained to the closed set `@zenfs/linux` ships.
declare module '@zenfs/linux/uapi/abi' {
  interface Syscalls {
    window_create(title: string): number
    window_write(handle: number, text: string): number
    window_close(handle: number): number
    storage_usage(path: string): number
    ps_list(path: string): number
    reboot(): number
    users_lookup(query: string, path: string): number
    tty_get(): number
    tty_switch(ttyNumber: number): number
    sockets_list(path: string): number
    sockets_create(url: string, type: string, protocols: string, path: string): number
    sockets_close(id: string, path: string): number
    sockets_show(id: string, path: string): number
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

function kernelOf(proc: Process): Kernel {
  const kernel = kernelOfProcess.get(proc)
  if (!kernel) throw Object.assign(new Error('No kernel registered for this process'), { errno: Errno.ENOSYS })
  return kernel
}

function shellOf(proc: Process): Shell | undefined {
  return shellOfProcess.get(proc)
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

  define_syscall('window_create', async (proc: Process, title: string) => {
    const kernel = kernelOf(proc)
    const win = kernel.windows.create({ title: title || 'Untitled' })
    const handle = nextWindowHandle++
    windowHandles.set(handle, String(win.id))
    return handle
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
  // `storage_usage`/`ps_list` write their JSON into a real file under `/tmp` instead (real `/proc` is
  // `@zenfs/linux`'s synthetic, read-only `ProcFS` -- not a place this can write into): a worker-
  // hosted `df`/`ps` just `open`+`read`s the file back with the plain filesystem syscalls it already
  // has, no custom syscall needed on the read side at all. The write-then-signal-length return keeps
  // the caller from racing a read against an unfinished write.
  define_syscall('storage_usage', async (proc: Process, path: string) => {
    const kernel = kernelOf(proc)
    const usage = await kernel.storage.usage()
    const text = JSON.stringify(usage ?? {})
    await kernel.filesystem.fs.writeFile(path, text)
    return text.length
  })

  define_syscall('ps_list', async (proc: Process, path: string) => {
    const kernel = kernelOf(proc)
    const list = [...kernel.processes.all.entries()].map(([pid, p]) => ({ pid, command: p.command, status: p.status }))
    const text = JSON.stringify(list)
    await kernel.filesystem.fs.writeFile(path, text)
    return text.length
  })

  define_syscall('reboot', async (proc: Process) => {
    const kernel = kernelOf(proc)
    await kernel.reboot()
    return 0
  })

  // `kernel.activeTty` is a plain number already, so unlike `storage_usage`/`ps_list` this needs no
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
  // instances -- reached the same way `storage_usage`/`ps_list` reach other live `Kernel` state,
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
    await kernel.filesystem.fs.writeFile(path, text)
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

    await kernel.filesystem.fs.writeFile(path, text)
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

    await kernel.filesystem.fs.writeFile(path, text)
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

    await kernel.filesystem.fs.writeFile(path, text)
    return text.length
  })

  // `id`/`groups` need to resolve arbitrary usernames/uids against the live user registry
  // (`kernel.users`) -- no execve-compatible equivalent exists for that, and `groups` even supports
  // looking up a user other than the caller's own (`groups someoneelse`), so this can't be
  // pre-snapshotted into env at spawn time the way `id`/`groups`' *own*-process values could be.
  // `query` is a small JSON request object; the response (also JSON, written to `path` the same way
  // `storage_usage`/`ps_list` do, per this module's own doc comment on why a custom syscall can't
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
      const shell = shellOf(proc)
      const credentials = shell?.credentials
      const user = credentials ? kernel.users.get(credentials.uid) : undefined
      result = {
        uid: credentials?.uid ?? 0,
        gid: credentials?.gid ?? 0,
        euid: credentials?.euid ?? credentials?.uid ?? 0,
        egid: credentials?.egid ?? credentials?.gid ?? 0,
        groups: credentials?.groups ?? [],
        username: user?.username ?? 'root'
      }
    } else if (request.mode === 'byUid') {
      result = toRecord(request.uid)
    } else {
      const match = Array.from(kernel.users.all.values()).find(u => u.username === request.username)
      result = match ? toRecord(match.uid) : null
    }

    const text = JSON.stringify(result)
    await kernel.filesystem.fs.writeFile(path, text)
    return text.length
  })
}
