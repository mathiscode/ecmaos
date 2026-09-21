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

import { define_syscall, kill as zenfsKill, processes as zenfsProcesses, spawn as zenfsSpawn, type Process } from '@zenfs/linux'
import { Errno } from 'kerium'

import type { Kernel } from '#kernel.ts'
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
    storage_usage(path: string): number
    ps_list(path: string): number
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
    shell_set_theme(theme: string): number
    proc_spawn(command: string, argvJson: string, cwd: string): number
    proc_wait(pid: number): number
    proc_kill(pid: number, signal: number): number
    shell_exec(command: string): number
    terminal_clear_history(): number
    terminal_reload_history(): number
    system_format(argsJson: string, path: string): number
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

/** What `sockets_connect` learned about how each connection ended, until `sockets_result` collects it. */
interface SocketResult { opened: boolean, messages: number, code?: number, reason?: string }
const socketResults = new Map<string, SocketResult>()

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

  // Reads `@zenfs/linux`'s own real, module-global `processes` map (`process.js`) -- not
  // `kernel.processes` (the legacy `ProcessManager`, `tree/processes.ts`), which nothing created via
  // `executeViaExecve`/`spawn()` has ever been registered into. Every migrated coreutil, `crond`
  // (once it exists), and `proc_spawn`'s own children all show up here automatically, the same way a
  // real Linux process is visible in `/proc` the instant `fork()`+`execve()` return -- this was
  // previously reading a table real execve'd processes were never added to at all, so `ps` showing
  // (effectively) nothing for anything actually running was a real, if quiet, gap until this session.
  // Known, accepted trade-off: DOM apps/devices (`executeApp`/`executeDevice`) still run on the old
  // legacy model until M2 migrates them onto real `Process`es too, so they won't appear here either
  // -- this fixes the more commonly hit gap (ordinary commands), not every gap at once.
  define_syscall('ps_list', async (proc: Process, path: string) => {
    const kernel = kernelOf(proc)
    const list = Array.from(zenfsProcesses.values()).map(p => ({
      pid: p.pid,
      command: p.comm,
      status: p.code !== undefined ? 'exited' : p.stopped ? 'stopped' : 'running'
    }))
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

    await kernel.filesystem.fs.writeFile(path, text)
    return text.length
  })

  /** How a `sockets_connect` connection ended: `{ opened, messages, code?, reason? }`. Read once. */
  define_syscall('sockets_result', async (proc: Process, id: string, path: string) => {
    const kernel = kernelOf(proc)
    const info = socketResults.get(id)
    socketResults.delete(id)
    const text = JSON.stringify(info ?? { error: `connection not found: ${id}` })
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

    if (!shell || shell.credentials.suid !== 0) {
      text = JSON.stringify({ error: 'permission denied' })
      await kernel.filesystem.fs.writeFile(path, text)
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

        // `Users.remove()` (`tree/users.ts`) already rewrites /etc/passwd from its own in-memory map
        // once the user is deleted -- but it never touches /etc/shadow at all, so that still needs
        // manual cleanup here, exactly matching the legacy command (which did both, redundantly for
        // passwd, necessarily for shadow).
        await kernel.filesystem.fs.writeFile('/etc/passwd',
          (await kernel.filesystem.fs.readFile('/etc/passwd', 'utf8')).split('\n').filter(line => !line.startsWith(`${username}:`)).join('\n'))
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

    await kernel.filesystem.fs.writeFile(path, text)
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
    await kernel.filesystem.fs.writeFile(path, text)
    return text.length
  })

  // `shell.config.setTheme()` mutates the calling `Shell`'s own live `ShellConfig` and immediately
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

  // `spawn()`/`Process.wait()`/`kill()` (`@zenfs/linux`'s `process.js`/`fs/exec.js`) are real
  // `fork()`+`execve()`/`waitpid()`/`kill()` -- not main-thread-only capabilities like everything
  // above, they're plain functions any `Process` object can call. The only reason these need to be
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
  define_syscall('proc_spawn', async (proc: Process, command: string, argvJson: string, cwd: string) => {
    const kernel = kernelOf(proc)
    const shell = shellOf(proc)
    const argv = JSON.parse(argvJson) as string[]
    const child = await zenfsSpawn(proc, command, argv, shell?.envObject ?? proc.env, { cwd: cwd || proc.cwd })
    registerProcessKernel(child, kernel, shell)
    return child.pid
  })

  define_syscall('proc_wait', async (proc: Process, pid: number) => {
    return await proc.wait(pid)
  })

  define_syscall('proc_kill', async (_proc: Process, pid: number, signal: number) => {
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
  // get real pids visible in `ps` (see `ps_list`'s own doc comment above), even though the job as a
  // whole has no single pid of its own, the same limitation real `crond`'s `sh -c` child has for a
  // multi-stage pipeline.
  define_syscall('shell_exec', async (proc: Process, command: string) => {
    const kernel = kernelOf(proc)
    return await kernel.shell.execute(command)
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
    await shell.terminal.clearHistory(shell.credentials.uid)
    return 0
  })

  define_syscall('terminal_reload_history', async (proc: Process) => {
    const shell = shellOf(proc)
    if (!shell) return -Errno.ENOSYS
    await shell.terminal.reloadHistory(shell.credentials.uid)
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

    if (!shell || shell.credentials.suid !== 0) {
      text = JSON.stringify({ error: 'permission denied (requires root)' })
      await kernel.filesystem.fs.writeFile(path, text)
      return text.length
    }

    try {
      const args = JSON.parse(argsJson) as { indexedDB: boolean, localStorage: boolean, keep: string[] }

      const confirmation = await shell.terminal.readline('Type "yes" to continue, or anything else to cancel: ')
      if (confirmation.trim().toLowerCase() !== 'yes') {
        text = JSON.stringify({ cancelled: true })
        await kernel.filesystem.fs.writeFile(path, text)
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

    await kernel.filesystem.fs.writeFile(path, text)
    return text.length
  })
}
