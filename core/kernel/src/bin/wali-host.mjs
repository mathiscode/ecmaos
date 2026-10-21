/**
 * ecmaOS's half of the WALI host. `@zenfs/linux/uapi/wali` answers the `wali` imports of a module built against WALI's
 * musl (`utils/check-wali.sh`); `install()` adds what it lacks and replaces what ecmaOS does differently, on the same
 * table its `run()` links from. Its views of linear memory are private, so `wali.mjs` hands this one the memory once
 * the module is instantiated (`attach()`).
 *
 * What lives here:
 * - the environment, copied in the way argv is (`__cl_get_envc`, from the sysroot's musl patch), not through a file
 * - a descriptor's flags: `FD_CLOEXEC` and the open flags `F_GETFL` reports, which the kernel does not keep
 * - the `*at` calls relative to a real directory descriptor, resolved through `/proc/self/fd/N`
 * - `getdents64` from a position kept per descriptor (the kernel lists the whole directory each time)
 * - `mmap`, `munmap` and `mremap` over a free list at the top of linear memory, with private file mappings filled
 *   from the file
 * - processes: `posix_spawn` (`__ecmaos_spawn`, from the sysroot's musl patch), `wait4` and `execve` on the kernel's
 *   process calls, and the job-control ids
 * - signals: dispositions, the mask, pending signals, and handlers run when an import returns, with `EINTR` or a
 *   restart (`SA_RESTART`) for a call they interrupted, and `SIGPIPE` for a write nothing will read; `sleep` and the
 *   clocks
 * - sockets: stream sockets on the kernel's socket files (`tree/lib/socket-files.ts`), so a socket is one descriptor
 *   the kernel reads, writes and polls; `AF_UNIX`, and `AF_INET`/`AF_INET6` on loopback or through the gateway
 * - `epoll`, over the kernel's `poll`
 *
 * Numbers are Linux's: WALI's musl is Linux musl, so `errno` values and structures need no translation.
 */

import { syscall_raw, returned, pending, on_signal, off_signal } from '@zenfs/linux/uapi/base'
import { getdents } from '@zenfs/linux/uapi/fs'
import { environ, getpid } from '@zenfs/linux/uapi/process'

const ENOENT = 2, EINTR = 4, EBADF = 9, ENOMEM = 12, EFAULT = 14, EEXIST = 17, ENOTDIR = 20, EINVAL = 22, EPIPE = 32, ENOSYS = 38
const ENOPROTOOPT = 92, ESOCKTNOSUPPORT = 94, EOPNOTSUPP = 95, EAFNOSUPPORT = 97, ENOTCONN = 107
const AT_FDCWD = -100, AT_SYMLINK_NOFOLLOW = 0x100, AT_REMOVEDIR = 0x200, AT_EMPTY_PATH = 0x1000
const O_RDONLY = 0, O_WRONLY = 1, O_RDWR = 2, O_ACCMODE = 3, O_CLOEXEC = 0x80000
const F_DUPFD = 0, F_GETFD = 1, F_SETFD = 2, F_GETFL = 3, F_SETFL = 4, F_DUPFD_CLOEXEC = 1030
const F_GETLK = 5, F_SETLK = 6, F_SETLKW = 7
const FD_CLOEXEC = 1
/** What `F_SETFL` may change; the access mode and creation flags are fixed at open */
const SETFL_MASK = 0x400 /* O_APPEND */ | 0x800 /* O_NONBLOCK */ | 0x2000 /* O_ASYNC */ | 0x4000 /* O_DIRECT */ | 0x40000 /* O_NOATIME */
const MAP_SHARED = 0x01, MAP_FIXED = 0x10, MAP_ANONYMOUS = 0x20
const MREMAP_MAYMOVE = 1
const TCGETS = 0x5401, TIOCGWINSZ = 0x5413, FIONREAD = 0x541b
/** What an ioctl that answers with a structure copies back: `struct termios` and `struct winsize` */
const IOCTL_ANSWER_SIZE = { [TCGETS]: 60, [TIOCGWINSZ]: 8 }
/** `struct stat` on this target: musl's x86_64 layout */
const STAT_SIZE = 144
const PAGE = 4096, WASM_PAGE = 65536
const SEEK_SET = 0

const encoder = new TextEncoder()
const decoder = new TextDecoder()

let memory
/** The module's function table, through which a signal handler is called */
let table
const bytes = () => new Uint8Array(memory.buffer)
const view = () => new DataView(memory.buffer)

function readString(ptr) {
  const all = bytes()
  let end = ptr
  while (all[end]) end++
  // copied out: a decoder is not required to take a view of shared memory
  return decoder.decode(all.slice(ptr, end))
}

function putString(ptr, text) {
  const encoded = encoder.encode(text)
  const all = bytes()
  all.set(encoded, ptr)
  all[ptr + encoded.byteLength] = 0
}

/** A NULL-terminated array of strings, `argv` or `envp` */
function readStrings(ptr) {
  const list = []
  if (!ptr) return list
  for (let at = ptr; ; at += 4) {
    const item = view().getUint32(at, true)
    if (!item) return list
    list.push(readString(item))
  }
}

/** `NAME=value` strings as the object the kernel takes for an environment */
const environment_of = entries => Object.fromEntries(entries.map(entry => {
  const equals = entry.indexOf('=')
  return equals < 0 ? [entry, ''] : [entry.slice(0, equals), entry.slice(equals + 1)]
}))

const big = value => BigInt(value)
const num = value => typeof value === 'bigint' ? Number(value) : value

/** Copies what the last syscall left (a struct the kernel filled in) to a pointer */
function give(ptr, limit = Infinity) {
  const length = Math.min(returned.byteLength, limit)
  bytes().set(returned.subarray(0, length), ptr)
  return length
}

// --- the environment ---

let environment
const entries = () => (environment ??= Object.entries(environ()).map(([key, value]) => `${key}=${value}`))

// --- descriptors ---

/** Per descriptor: its open flags and whether it closes on exec. The kernel's table is the truth for what is open. */
const fds = new Map([[0, { flags: O_RDWR, cloexec: false }], [1, { flags: O_RDWR, cloexec: false }], [2, { flags: O_RDWR, cloexec: false }]])
const entryOf = fd => fds.get(fd) ?? { flags: O_RDWR, cloexec: false }

/** Records a descriptor the kernel just handed out */
function opened(fd, flags, cloexec = (flags & O_CLOEXEC) !== 0) {
  if (fd < 0) return fd
  forget(fd)
  fds.set(fd, { flags: flags & ~O_CLOEXEC, cloexec })
  return fd
}

/** How far `getdents64` has read each directory, as an index into the kernel's listing */
const positions = new Map()

/** Forgets what was known about a descriptor that has been closed or replaced */
function forget(fd) {
  fds.delete(fd)
  positions.delete(fd)
}

/** The descriptors open in this process, as procfs lists them: also the ones this host did not see made */
function openDescriptors() {
  const dir = syscall_raw('open', '/proc/self/fd', 0x10000 /* O_DIRECTORY */, 0)
  if (dir >= 0) {
    try {
      return getdents(dir).map(entry => Number(entry.name)).filter(fd => Number.isInteger(fd) && fd !== dir)
    } catch {
      // listed below instead
    } finally {
      syscall_raw('close', dir)
    }
  }
  return [...fds.keys()].filter(fd => syscall_raw('fstat', fd) >= 0)
}

/**
 * The path a `*at` call means. Relative to the working directory the kernel resolves it itself; relative to another
 * directory, the directory is named through procfs, which serves `/proc/self/fd/N` as a link to the open file.
 * @returns the path, or a negative errno
 */
function resolveAt(dirfd, pathPtr, flags = 0) {
  const path = pathPtr ? readString(pathPtr) : ''
  if (path.startsWith('/') || (dirfd === AT_FDCWD && path)) return path
  if (dirfd === AT_FDCWD) return (flags & AT_EMPTY_PATH) ? '.' : -ENOENT
  const length = syscall_raw('readlink', `/proc/self/fd/${dirfd}`)
  if (length < 0) return -EBADF
  const dir = decoder.decode(returned.slice(0, length))
  if (!path) return (flags & AT_EMPTY_PATH) ? dir : -ENOENT
  return dir.endsWith('/') ? dir + path : `${dir}/${path}`
}

/** Runs a path call on what a `*at` call resolved to, passing a failure to resolve straight back */
function at(dirfd, pathPtr, call, flags = 0) {
  const path = resolveAt(dirfd, pathPtr, flags)
  return typeof path === 'number' ? big(path) : big(call(path))
}

function stat(name, ptr, target) {
  const value = syscall_raw(name, target)
  if (value < 0) return value
  give(ptr, STAT_SIZE)
  return 0
}

function fcntl(fd, cmd, arg) {
  const entry = fds.get(fd)
  switch (cmd) {
    case F_DUPFD:
    case F_DUPFD_CLOEXEC: {
      // the kernel's dup takes the lowest free number; one at or above `arg` is found by trying the next ones
      const want = Math.max(0, arg)
      let copy = syscall_raw('dup', fd)
      const held = []
      while (copy >= 0 && copy < want) {
        held.push(copy)
        copy = syscall_raw('dup', fd)
      }
      for (const extra of held) syscall_raw('close', extra)
      return copy < 0 ? copy : opened(copy, entryOf(fd).flags, cmd === F_DUPFD_CLOEXEC)
    }
    case F_GETFD:
      return syscall_raw('fstat', fd) < 0 ? -EBADF : (entry?.cloexec ? FD_CLOEXEC : 0)
    case F_SETFD:
      if (syscall_raw('fstat', fd) < 0) return -EBADF
      fds.set(fd, { ...entryOf(fd), cloexec: (arg & FD_CLOEXEC) !== 0 })
      return 0
    // the status flags belong to the open file, which the kernel keeps: O_NONBLOCK there decides whether a read waits
    case F_GETFL: {
      const flags = syscall_raw('fd_getfl', fd)
      return flags < 0 ? flags : flags & (O_ACCMODE | SETFL_MASK)
    }
    case F_SETFL:
      return syscall_raw('fd_setfl', fd, arg)
    // Locks are advisory and every process here shares one kernel, which keeps none: taking one succeeds and asking
    // finds none held. Two processes writing the same file at once are not kept apart.
    case F_SETLK:
    case F_SETLKW:
      return 0
    case F_GETLK:
      view().setInt16(arg, 2 /* F_UNLCK */, true)
      return 0
    default:
      return -EINVAL
  }
}

// --- memory mappings ---

/**
 * Mappings live above the memory the module came up with. Freed ranges are kept, merged with their neighbours, and
 * used again first-fit; the memory only grows when nothing free is big enough. Lengths are in musl's 4 KiB pages.
 * (One process, one thread: a threaded process will need this state where every thread can reach it.)
 */
const free = []
let top = 0

const roundUp = (n, to) => Math.ceil(n / to) * to

function release(start, length) {
  free.push({ start, length })
  free.sort((a, b) => a.start - b.start)
  for (let i = 0; i < free.length - 1;) {
    if (free[i].start + free[i].length === free[i + 1].start) {
      free[i].length += free[i + 1].length
      free.splice(i + 1, 1)
    } else i++
  }
  const last = free.at(-1)
  if (last && last.start + last.length === top) {
    top = last.start
    free.pop()
  }
}

function allocate(length) {
  const index = free.findIndex(range => range.length >= length)
  if (index >= 0) {
    const range = free[index]
    const start = range.start
    if (range.length === length) free.splice(index, 1)
    else Object.assign(range, { start: start + length, length: range.length - length })
    bytes().fill(0, start, start + length)
    return start
  }
  const start = top
  const needed = start + length - memory.buffer.byteLength
  if (needed > 0) {
    try {
      memory.grow(Math.ceil(needed / WASM_PAGE))
    } catch {
      return -ENOMEM
    }
  }
  top = start + length
  return start
}

/** Fills a private mapping of a file with what the file holds there */
function fill(fd, start, length, offset) {
  for (let done = 0; done < length;) {
    const count = syscall_raw('read', fd, Math.min(length - done, 1 << 20), offset + done)
    if (count < 0) return count
    if (count === 0) break
    bytes().set(returned.subarray(0, count), start + done)
    done += count
  }
  return 0
}

function mmap(addr, length, _prot, flags, fd, offset) {
  if (!length) return -EINVAL
  if (flags & MAP_FIXED) return -ENOSYS
  // MAP_SHARED of a file is a later step: a private copy would silently lose writes
  if ((flags & MAP_SHARED) && !(flags & MAP_ANONYMOUS)) return -ENOSYS
  const size = roundUp(length, PAGE)
  const start = allocate(size)
  if (start < 0) return start
  if (!(flags & MAP_ANONYMOUS)) {
    const result = fill(fd, start, length, offset)
    if (result < 0) {
      release(start, size)
      return result
    }
  }
  return start
}

function mremap(addr, oldLength, newLength, flags) {
  const before = roundUp(oldLength, PAGE), after = roundUp(newLength, PAGE)
  if (after <= before) {
    if (after < before) release(addr + after, before - after)
    return addr
  }
  // grow in place into a free neighbour, or off the top
  const next = free.findIndex(range => range.start === addr + before)
  if (next >= 0 && free[next].length >= after - before) {
    const range = free[next]
    bytes().fill(0, range.start, range.start + after - before)
    if (range.length === after - before) free.splice(next, 1)
    else Object.assign(range, { start: range.start + after - before, length: range.length - (after - before) })
    return addr
  }
  if (addr + before === top) {
    const needed = addr + after - memory.buffer.byteLength
    if (needed > 0) {
      try { memory.grow(Math.ceil(needed / WASM_PAGE)) } catch { return -ENOMEM }
    }
    top = addr + after
    return addr
  }
  if (!(flags & MREMAP_MAYMOVE)) return -ENOMEM
  const moved = allocate(after)
  if (moved < 0) return moved
  bytes().copyWithin(moved, addr, addr + before)
  release(addr, before)
  return moved
}

// --- signals ---

/** This port's SIG_DFL and SIG_IGN: a table index can be any small number, so ignoring is -2, as a u32 */
const SIG_DFL = 0, SIG_IGN = 0xfffffffe
const SA_RESTART = 0x10000000n, SA_NODEFER = 0x40000000n, SA_RESETHAND = 0x80000000n
const SIGKILL = 9, SIGSTOP = 19
/** Signals whose default action is to do nothing */
const DEFAULT_IGNORED = new Set([17 /* SIGCHLD */, 18 /* SIGCONT */, 23 /* SIGURG */, 28 /* SIGWINCH */])
/** The signals the kernel raises on a thread: the standard ones, 1 to 31 */
const KERNEL_SIGNALS = 31
const bit = signal => 1n << BigInt(signal - 1)
const UNBLOCKABLE = bit(SIGKILL) | bit(SIGSTOP)

/** Per signal, what `rt_sigaction` set: `handler` is a table index, or SIG_DFL or SIG_IGN */
const actions = new Map()
const defaultAction = { handler: SIG_DFL, flags: 0n, restorer: 0, mask: 0n }
const actionOf = signal => actions.get(signal) ?? defaultAction
let mask = 0n
/** Raised and not yet delivered, as a sigset */
let raised = 0n
/** How many signals have been raised, so a call can tell whether one arrived while it ran */
let arrivals = 0
/** The signals the kernel hands to this process rather than taking its default action for */
const routed = new Set()

function record(signal) {
  raised |= bit(signal)
  arrivals++
}

/**
 * A signal comes to this process when it has a handler, is ignored, or is blocked (it then waits here, the kernel
 * knows no mask); otherwise the kernel takes its default action, terminating or stopping the process itself.
 */
function route(signal) {
  if (signal === SIGKILL || signal === SIGSTOP) return
  const wanted = actionOf(signal).handler !== SIG_DFL || (mask & bit(signal)) !== 0n
  if (wanted && !routed.has(signal)) {
    on_signal(signal, record)
    routed.add(signal)
  } else if (!wanted && routed.has(signal)) {
    off_signal(signal, record)
    routed.delete(signal)
  }
}

function routeAll() {
  for (let signal = 1; signal <= KERNEL_SIGNALS; signal++) route(signal)
}

/** Signals the kernel raised while the program was computing, which the next syscall would otherwise clear */
function collect() {
  const bits = pending()
  if (!bits) return
  for (let signal = 1; signal <= KERNEL_SIGNALS; signal++) {
    if ((bits & (1 << signal)) && routed.has(signal)) record(signal)
  }
}

/** The ignored signals and the mask as the kernel keeps them across an exec: sigsets of signals 1 to 31 */
function ignoredSet(reset = 0n) {
  let set = 0
  for (const [signal, action] of actions) {
    if (signal <= KERNEL_SIGNALS && action.handler === SIG_IGN && !(reset & bit(signal))) set |= 1 << (signal - 1)
  }
  return set
}
const kernelSet = sigset => Number(sigset & 0x7fffffffn)

/** What the process was started or exec'ed with: its ignored signals and its mask */
function inheritSignals() {
  const ignored = syscall_raw('proc_sigstate', 0)
  const blocked = syscall_raw('proc_sigstate', 1)
  for (let signal = 1; signal <= KERNEL_SIGNALS; signal++) {
    if (ignored > 0 && (ignored & (1 << (signal - 1)))) actions.set(signal, { ...defaultAction, handler: SIG_IGN })
  }
  if (blocked > 0) mask = BigInt(blocked) & ~UNBLOCKABLE
  routeAll()
}

/** `struct k_sigaction`, packed: handler (4), flags (8, a 64-bit long), restorer (4), mask (8) */
function readAction(ptr) {
  const dv = view()
  return {
    handler: dv.getUint32(ptr, true),
    flags: dv.getBigUint64(ptr + 4, true),
    restorer: dv.getUint32(ptr + 12, true),
    mask: dv.getBigUint64(ptr + 16, true)
  }
}

function writeAction(ptr, action) {
  const dv = view()
  dv.setUint32(ptr, action.handler, true)
  dv.setBigUint64(ptr + 4, action.flags, true)
  dv.setUint32(ptr + 12, action.restorer, true)
  dv.setBigUint64(ptr + 16, action.mask, true)
}

/** A `siginfo_t` for the handlers that take one: the signal, sent by a process (SI_USER) */
let siginfo = 0
function siginfoFor(signal) {
  if (!siginfo) siginfo = allocate(PAGE)
  bytes().fill(0, siginfo, siginfo + 128)
  view().setInt32(siginfo, signal, true)
  return siginfo
}

/**
 * Runs the handlers of the raised signals the mask lets through, lowest first, the way Linux does on the way back to
 * userspace. A blocked signal stays raised; an ignored one is dropped; one that was blocked with its default action
 * and is now let through gets that action from the kernel. The handler runs with its signal and `sa_mask` blocked,
 * and the mask is put back when it returns (not when it leaves by `siglongjmp`, which restores its own).
 * @returns how many handlers ran, and whether all of them asked for an interrupted call to be restarted
 */
function deliver() {
  let handled = 0, restart = true
  for (;;) {
    const ready = raised & ~mask
    if (!ready) return { handled, restart }
    let signal = 1
    while (!(ready & bit(signal))) signal++
    raised &= ~bit(signal)
    const action = actionOf(signal)
    if (action.handler === SIG_IGN) continue
    if (action.handler === SIG_DFL) {
      if (DEFAULT_IGNORED.has(signal)) continue
      route(signal)
      syscall_raw('kill', getpid(), signal)
      continue
    }
    handled++
    if (!(action.flags & SA_RESTART)) restart = false
    const saved = mask
    mask = (mask | action.mask | (action.flags & SA_NODEFER ? 0n : bit(signal))) & ~UNBLOCKABLE
    if (action.flags & SA_RESETHAND) actions.set(signal, defaultAction)
    routeAll()
    table.get(action.handler)(signal, siginfoFor(signal), 0)
    mask = saved
    routeAll()
  }
}

/** A signal this process sends itself: delivered before the call that sent it returns, as `raise` promises */
function raiseHere(signal) {
  if (!signal) return 0
  if (!routed.has(signal)) return syscall_raw('kill', getpid(), signal)
  record(signal)
  return 0
}

/** Waits until a handler has run (`pause`, `sigsuspend`): a wait on nothing, which a raised signal ends with EINTR */
function waitForHandler() {
  for (;;) {
    collect()
    if (deliver().handled) return -EINTR
    syscall_raw('poll', [], -1)
  }
}

/** Calls whose interruption is reported even when the handler asked for restarts, as Linux does for these */
const NEVER_RESTARTED = new Set(['SYS_poll', 'SYS_ppoll', 'SYS_select', 'SYS_pselect6', 'SYS_nanosleep', 'SYS_clock_nanosleep',
  'SYS_epoll_wait', 'SYS_epoll_pwait', 'SYS_rt_sigtimedwait'])
/** Calls that deliver for themselves and return EINTR on purpose */
const OWN_DELIVERY = new Set(['SYS_rt_sigsuspend', 'SYS_pause'])
/** Signal-sending calls: an EINTR means the signal reached this process too, after the call did its work */
const SENDS_SIGNALS = new Set(['SYS_kill', 'SYS_tkill', 'SYS_tgkill'])
/** Calls whose EPIPE raises SIGPIPE, as Linux's pipes and sockets do; for the sends, unless `MSG_NOSIGNAL` (the flags are their argument at this index) */
const WRITES = new Map([['SYS_write', -1], ['SYS_writev', -1], ['SYS_pwrite64', -1], ['SYS_pwritev', -1], ['SYS_sendfile', -1], ['SYS_sendto', 3], ['SYS_sendmsg', 2]])
const MSG_NOSIGNAL = 0x4000
const SIGPIPE = 13

/**
 * Every import, wrapped: signals are delivered when it returns. One the kernel woke with EINTR is resumed when no
 * handler ran (the signal was blocked or ignored, which Linux would not have interrupted it for), restarted when
 * every handler that ran has SA_RESTART, and otherwise fails with EINTR.
 */
function delivering(name, call) {
  return (...args) => {
    collect()
    for (;;) {
      const before = arrivals
      const result = call(...args)
      if (result === -BigInt(EPIPE) && WRITES.has(name)) {
        const flagsAt = WRITES.get(name)
        if (flagsAt < 0 || !(args[flagsAt] & MSG_NOSIGNAL)) raiseHere(SIGPIPE)
      }
      const interrupted = result === -BigInt(EINTR)
      const { handled, restart } = deliver()
      if (!interrupted || OWN_DELIVERY.has(name)) return result
      if (SENDS_SIGNALS.has(name)) return 0n
      if (!handled) {
        if (arrivals !== before) continue
        return result
      }
      if (restart && !NEVER_RESTARTED.has(name)) continue
      return result
    }
  }
}

// --- processes ---

const FDOP_CLOSE = 1, FDOP_DUP2 = 2, FDOP_OPEN = 3, FDOP_CHDIR = 4, FDOP_FCHDIR = 5
const POSIX_SPAWN_SETPGROUP = 2, POSIX_SPAWN_SETSIGDEF = 4, POSIX_SPAWN_SETSIGMASK = 8, POSIX_SPAWN_SETSID = 0x80
const WNOHANG = 1, WUNTRACED = 2
/** `struct rusage`: two timevals and fourteen longs, a long being 8 bytes here */
const RUSAGE_SIZE = 144
const S_IFMT = 0o170000, S_IFDIR = 0o040000

function getcwd() {
  const value = syscall_raw('getcwd')
  return value < 0 ? '/' : decoder.decode(returned.slice())
}

const absolute = (path, cwd) => path.startsWith('/') ? path : `${cwd.endsWith('/') ? cwd : `${cwd}/`}${path}`

/** The path an open descriptor names, through procfs */
function pathOf(fd) {
  const length = syscall_raw('readlink', `/proc/self/fd/${fd}`)
  return length < 0 ? length : decoder.decode(returned.slice(0, length))
}

/** Whether a path is a directory, or the errno that says why it cannot be one */
function directory(path) {
  const value = syscall_raw('stat', path)
  if (value < 0) return value
  const mode = new DataView(returned.buffer, returned.byteOffset).getUint32(24, true)
  return (mode & S_IFMT) === S_IFDIR ? 0 : -ENOTDIR
}

/**
 * `posix_spawn`: the child starts with a copy of this process's descriptor table, close-on-exec flags and all; the file
 * actions are replayed on that copy (a file to open is opened here and handed over, and `dup2` clears the flag on its
 * target, as it does in a forked child); then what is still close-on-exec goes, as the exec would close it, and the
 * kernel starts the program with exactly the rest. Its directory, process group, session and signals are what the
 * actions and attributes say.
 * @returns the child's pid, or a negative errno
 */
function spawn(pathPtr, argvPtr, envpPtr, opsPtr, count, flags, pgrp, defaultsPtr, maskPtr) {
  const path = readString(pathPtr)
  const argv = readStrings(argvPtr)
  const env = environment_of(readStrings(envpPtr))
  // child fd -> { source: this process's fd, cloexec }
  const children = new Map(openDescriptors().map(fd => [fd, { source: fd, cloexec: fds.get(fd)?.cloexec ?? false }]))
  let cwd = getcwd()
  const opened = []
  try {
    const dv = view()
    for (let i = 0; i < count; i++) {
      const op = opsPtr + i * 24
      const cmd = dv.getInt32(op, true), fd = dv.getInt32(op + 4, true), srcfd = dv.getInt32(op + 8, true)
      const oflag = dv.getInt32(op + 12, true), mode = dv.getInt32(op + 16, true)
      const opPath = () => readString(dv.getUint32(op + 20, true))
      switch (cmd) {
        case FDOP_CLOSE:
          children.delete(fd)
          break
        case FDOP_DUP2: {
          const source = children.get(srcfd)
          if (!source) return -EBADF
          children.set(fd, { source: source.source, cloexec: false })
          break
        }
        case FDOP_OPEN: {
          const file = syscall_raw('open', absolute(opPath(), cwd), oflag, mode)
          if (file < 0) return file
          opened.push(file)
          children.set(fd, { source: file, cloexec: (oflag & O_CLOEXEC) !== 0 })
          break
        }
        case FDOP_CHDIR: {
          const dir = absolute(opPath(), cwd)
          const check = directory(dir)
          if (check < 0) return check
          cwd = dir
          break
        }
        case FDOP_FCHDIR: {
          const source = children.get(fd)
          if (!source) return -EBADF
          const dir = pathOf(source.source)
          if (typeof dir === 'number') return dir
          const check = directory(dir)
          if (check < 0) return check
          cwd = dir
          break
        }
        default:
          return -EINVAL
      }
    }
    const kept = Object.fromEntries([...children].filter(([, entry]) => !entry.cloexec).map(([fd, entry]) => [fd, entry.source]))
    const resets = flags & POSIX_SPAWN_SETSIGDEF ? view().getBigUint64(defaultsPtr, true) : 0n
    const blocked = flags & POSIX_SPAWN_SETSIGMASK ? view().getBigUint64(maskPtr, true) : mask
    const options = {
      env,
      fds: kept,
      exactFds: true,
      signals: { ignored: ignoredSet(resets), blocked: kernelSet(blocked & ~UNBLOCKABLE) },
      ...(flags & POSIX_SPAWN_SETPGROUP ? { pgid: pgrp } : {}),
      ...(flags & POSIX_SPAWN_SETSID ? { setsid: true } : {})
    }
    return syscall_raw('proc_spawn', path, JSON.stringify(argv), cwd, JSON.stringify(options))
  } finally {
    for (const file of opened) syscall_raw('close', file)
  }
}

/** `wait4`: the kernel answers `pid * 65536 + status`, Linux's status word */
function wait4(pid, statusPtr, options, rusagePtr) {
  // a process group (0 for the caller's, -pgid for another) is waited for as any child
  const target = pid < -1 || pid === 0 ? -1 : pid
  const flags = options & (WNOHANG | WUNTRACED)
  let value = syscall_raw('proc_waitpid', target, flags)
  // the SIGCHLD raised as a child ends wakes the wait with EINTR; Linux returns that child, which is ready by then
  if (value === -EINTR && !(flags & WNOHANG)) {
    const ready = syscall_raw('proc_waitpid', target, flags | WNOHANG)
    if (ready > 0) value = ready
  }
  if (value <= 0) return value
  const child = Math.floor(value / 65536)
  if (statusPtr) view().setInt32(statusPtr, value % 65536, true)
  if (rusagePtr) bytes().fill(0, rusagePtr, rusagePtr + RUSAGE_SIZE)
  return child
}

/** `execve`: descriptors marked close-on-exec go, and the ignored signals and the mask carry over to the new image */
function execve(pathPtr, argvPtr, envpPtr) {
  const path = readString(pathPtr)
  const executable = syscall_raw('access', path, 1 /* X_OK */)
  if (executable < 0) return executable
  const argv = readStrings(argvPtr)
  const env = environment_of(readStrings(envpPtr))
  for (const [fd, entry] of [...fds]) {
    if (!entry.cloexec) continue
    syscall_raw('close', fd)
    forget(fd)
  }
  syscall_raw('proc_set_sigstate', ignoredSet(), kernelSet(mask))
  return syscall_raw('execve', path, argv, env)
}

// --- time ---

const CLOCK_REALTIME = 0, CLOCK_REALTIME_COARSE = 5, CLOCK_REALTIME_ALARM = 8, CLOCK_TAI = 11
const TIMER_ABSTIME = 1

/** A clock in milliseconds: the wall clock for the realtime ones, the page's monotonic clock for the rest */
const now = clock => (clock === CLOCK_REALTIME || clock === CLOCK_REALTIME_COARSE || clock === CLOCK_REALTIME_ALARM || clock === CLOCK_TAI)
  ? Date.now()
  : performance.now()

function readTimespec(ptr) {
  const dv = view()
  return Number(dv.getBigInt64(ptr, true)) * 1000 + dv.getInt32(ptr + 8, true) / 1e6
}

function writeTimespec(ptr, ms) {
  const dv = view()
  const whole = Math.floor(ms / 1000)
  dv.setBigInt64(ptr, BigInt(whole), true)
  dv.setBigInt64(ptr + 8, BigInt(Math.floor((ms - whole * 1000) * 1e6)), true)
}

/** Sleeps on a wait for nothing, which a raised signal ends with EINTR; the time left is written to `remain` */
function sleep(ms, remainPtr, clock) {
  if (ms <= 0) return 0
  const start = now(clock)
  const value = syscall_raw('poll', [], ms)
  if (value === -EINTR) {
    if (remainPtr) writeTimespec(remainPtr, Math.max(0, ms - (now(clock) - start)))
    return -EINTR
  }
  return 0
}

// --- sockets ---

const AF_UNSPEC = 0, AF_UNIX = 1, AF_INET = 2, AF_INET6 = 10
const SOCK_STREAM = 1, SOCK_TYPE_MASK = 0xf, SOCK_NONBLOCK = 0x800, SOCK_CLOEXEC = 0x80000
const MSG_PEEK = 0x2, MSG_DONTWAIT = 0x40, MSG_WAITALL = 0x100
const SOL_SOCKET = 1, SO_TYPE = 3, SO_ERROR = 4, SO_SNDBUF = 7, SO_RCVBUF = 8, SO_ACCEPTCONN = 30, SO_PROTOCOL = 38, SO_DOMAIN = 39
const IPPROTO_TCP = 6, IPPROTO_IPV6 = 41, IPV6_V6ONLY = 26
/** `struct msghdr` with a 64-bit `long`: name 0, namelen 4, iov 8, iovlen 12, control 20, controllen 24, flags 32 */
const MSG_IOV = 8, MSG_IOVLEN = 12, MSG_CONTROLLEN = 24, MSG_FLAGS = 32

/** What the kernel knows of a socket and what this host recorded about it, or a negative errno (ENOTSOCK) */
function socketInfo(fd) {
  const length = syscall_raw('sock_info', fd)
  return length < 0 ? length : JSON.parse(decoder.decode(returned.slice(0, length)))
}

const remember = (fd, info) => syscall_raw('sock_set', fd, JSON.stringify(info))

const ipv4Text = (all, at) => `${all[at]}.${all[at + 1]}.${all[at + 2]}.${all[at + 3]}`

function ipv6Text(all, at) {
  const words = []
  for (let i = 0; i < 8; i++) words.push((all[at + i * 2] << 8) | all[at + i * 2 + 1])
  // an IPv4 address mapped into IPv6 is shown as the IPv4 one
  if (words.slice(0, 5).every(word => !word) && words[5] === 0xffff) return ipv4Text(all, at + 12)
  return words.map(word => word.toString(16)).join(':').replace(/(^|:)0(:0)+(:|$)/, '::').replace(/:{3,}/, '::')
}

/**
 * A `struct sockaddr` as `{ family, path }` or `{ family, addr, port }`. A Unix path is made absolute, as the kernel
 * names listeners; an abstract one (a leading NUL) is `@name`.
 */
function readSockaddr(ptr, length) {
  if (!ptr || length < 2) return -EINVAL
  const all = bytes()
  const family = view().getUint16(ptr, true)
  if (family === AF_UNIX) {
    const raw = all.slice(ptr + 2, ptr + length)
    if (raw[0] === 0) return { family, path: `@${decoder.decode(raw.subarray(1)).replace(/\0+$/, '')}` }
    const end = raw.indexOf(0)
    const path = decoder.decode(end < 0 ? raw : raw.subarray(0, end))
    return path ? { family, path: absolute(path, getcwd()) } : -EINVAL
  }
  const port = (all[ptr + 2] << 8) | all[ptr + 3]
  if (family === AF_INET && length >= 16) return { family, addr: ipv4Text(all, ptr + 4), port }
  if (family === AF_INET6 && length >= 24) return { family, addr: ipv6Text(all, ptr + 8), port }
  return family === AF_UNSPEC ? { family } : -EAFNOSUPPORT
}

/** Writes an address as the family's `struct sockaddr`, as much as `*lengthPtr` has room for, and its full length there */
function writeSockaddr(ptr, lengthPtr, family, address = {}) {
  if (!ptr || !lengthPtr) return
  let data
  if (family === AF_UNIX) {
    const path = address.path ? encoder.encode(address.path.startsWith('@') ? `\0${address.path.slice(1)}` : address.path) : new Uint8Array()
    data = new Uint8Array(2 + path.byteLength + (path.byteLength && path[0] ? 1 : 0))
    data.set(path, 2)
  } else {
    data = new Uint8Array(family === AF_INET6 ? 28 : 16)
    data[2] = (address.port ?? 0) >> 8
    data[3] = (address.port ?? 0) & 0xff
    const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address.addr ?? '')
    if (family === AF_INET) data.set(v4 ? v4.slice(1).map(Number) : [127, 0, 0, 1], 4)
    else if (v4) data.set([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, ...v4.slice(1).map(Number)], 8)
    else data[23] = 1 // ::1, the only IPv6 address a peer here has
  }
  new DataView(data.buffer).setUint16(0, family, true)
  const room = view().getUint32(lengthPtr, true)
  bytes().set(data.subarray(0, Math.min(room, data.byteLength)), ptr)
  view().setUint32(lengthPtr, data.byteLength, true)
}

const isLoopback4 = addr => /^127\./.test(addr) || addr === '0.0.0.0'
const isLoopback6 = addr => addr === '::1' || addr === '::'

/** The listener's name a connection to an address reaches, or undefined for one beyond this machine */
function listenerKey(address) {
  if (address.family === AF_UNIX) return `unix:${address.path}`
  if (address.family === AF_INET && isLoopback4(address.addr)) return `inet:127.0.0.1:${address.port}`
  if (address.family === AF_INET6 && /^\d+\./.test(address.addr) && isLoopback4(address.addr)) return `inet:127.0.0.1:${address.port}`
  if (address.family === AF_INET6 && isLoopback6(address.addr)) return `inet6:${address.port}`
  return undefined
}

/** The family name the kernel claims an address under: an IPv6 socket takes IPv4 too unless `IPV6_V6ONLY` */
const claimFamily = info => info.family === AF_UNIX ? 'unix' : info.family === AF_INET ? 'inet' : info.v6only ? 'inet6' : 'inet46'

function socket(domain, type) {
  if (domain !== AF_UNIX && domain !== AF_INET && domain !== AF_INET6) return -EAFNOSUPPORT
  // datagram sockets are not here yet
  if ((type & SOCK_TYPE_MASK) !== SOCK_STREAM) return -ESOCKTNOSUPPORT
  const fd = syscall_raw('sock_open', type & SOCK_NONBLOCK)
  if (fd < 0) return fd
  opened(fd, O_RDWR | (type & SOCK_NONBLOCK), (type & SOCK_CLOEXEC) !== 0)
  remember(fd, { family: domain, type: SOCK_STREAM })
  return fd
}

function bind(fd, ptr, length) {
  const info = socketInfo(fd)
  if (typeof info === 'number') return info
  const address = readSockaddr(ptr, length)
  if (typeof address === 'number') return address
  if (address.family !== info.family) return -EAFNOSUPPORT
  const port = syscall_raw('sock_bind', fd, claimFamily(info), address.path ?? address.addr, address.port ?? 0)
  if (port < 0) return port
  remember(fd, { local: address.family === AF_UNIX ? { path: address.path } : { addr: address.addr, port } })
  return 0
}

function listen(fd, backlog) {
  const info = socketInfo(fd)
  if (typeof info === 'number') return info
  // an Internet socket listening without a bind gets an ephemeral port, as on Linux
  if (!info.bound && info.family !== AF_UNIX) {
    const port = syscall_raw('sock_bind', fd, claimFamily(info), '', 0)
    if (port < 0) return port
    remember(fd, { local: { addr: info.family === AF_INET ? '0.0.0.0' : '::', port } })
  }
  return syscall_raw('sock_listen', fd, backlog)
}

function accept(fd, ptr, lengthPtr, flags) {
  if (flags & ~(SOCK_NONBLOCK | SOCK_CLOEXEC)) return -EINVAL
  const made = syscall_raw('sock_accept', fd, flags & SOCK_NONBLOCK)
  if (made < 0) return made
  opened(made, O_RDWR | (flags & SOCK_NONBLOCK), (flags & SOCK_CLOEXEC) !== 0)
  if (ptr) {
    const info = socketInfo(made)
    writeSockaddr(ptr, lengthPtr, info.family, info.peer)
  }
  return made
}

function connect(fd, ptr, length) {
  const info = socketInfo(fd)
  if (typeof info === 'number') return info
  const address = readSockaddr(ptr, length)
  if (typeof address === 'number') return address
  if (address.family !== info.family && !(info.family === AF_INET6 && address.family === AF_INET)) return -EAFNOSUPPORT
  const key = listenerKey(address)
  const value = key ? syscall_raw('sock_connect', fd, key) : syscall_raw('sock_connect_out', fd, address.addr, address.port)
  if (value < 0) return value
  remember(fd, { peer: address.family === AF_UNIX ? { path: address.path } : { addr: address.addr, port: address.port } })
  return 0
}

function socketName(fd, ptr, lengthPtr, which) {
  const info = socketInfo(fd)
  if (typeof info === 'number') return info
  if (which === 'peer' && !info.connected) return -ENOTCONN
  const fallback = info.family === AF_INET6 ? { addr: '::', port: 0 } : { addr: '0.0.0.0', port: 0 }
  writeSockaddr(ptr, lengthPtr, info.family, info[which] ?? (info.family === AF_UNIX ? {} : fallback))
  return 0
}

/** `send` of one buffer: the kernel waits for room unless the socket or `flags` says not to */
function sendBytes(fd, data, flags) {
  return syscall_raw('sock_send', fd, data, flags & MSG_DONTWAIT)
}

/** `recv` into one buffer; `MSG_WAITALL` keeps reading until it is full or the stream ends */
function receiveInto(fd, ptr, length, flags) {
  let done = 0
  do {
    const count = syscall_raw('sock_recv', fd, length - done, flags & (MSG_PEEK | MSG_DONTWAIT))
    if (count < 0) return done ? done : count
    bytes().set(returned.subarray(0, count), ptr + done)
    done += count
    if (!count || (flags & MSG_PEEK)) break
  } while ((flags & MSG_WAITALL) && done < length)
  return done
}

/** The buffers a `struct msghdr`'s iovec array names, as `[ptr, length]` */
function iovecs(msgPtr) {
  const dv = view()
  const iov = dv.getUint32(msgPtr + MSG_IOV, true), count = dv.getInt32(msgPtr + MSG_IOVLEN, true)
  return Array.from({ length: count }, (_, i) => [dv.getUint32(iov + i * 8, true), dv.getUint32(iov + i * 8 + 4, true)])
}

function sendmsg(fd, msgPtr, flags) {
  // passing descriptors and credentials (SCM_RIGHTS, SCM_CREDENTIALS) is not here yet
  if (view().getUint32(msgPtr + MSG_CONTROLLEN, true)) return -EOPNOTSUPP
  const parts = iovecs(msgPtr).map(([ptr, length]) => bytes().slice(ptr, ptr + length))
  const data = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
  let at = 0
  for (const part of parts) { data.set(part, at); at += part.byteLength }
  return sendBytes(fd, data, flags)
}

function recvmsg(fd, msgPtr, flags) {
  const buffers = iovecs(msgPtr)
  const total = buffers.reduce((sum, [, length]) => sum + length, 0)
  const scratch = allocate(roundUp(Math.max(total, 1), PAGE))
  if (scratch < 0) return scratch
  try {
    const count = receiveInto(fd, scratch, total, flags)
    if (count < 0) return count
    let at = 0
    for (const [ptr, length] of buffers) {
      const part = Math.min(length, count - at)
      if (part <= 0) break
      bytes().copyWithin(ptr, scratch + at, scratch + at + part)
      at += part
    }
    const dv = view()
    dv.setUint32(msgPtr + 4, 0, true) // no sender address on a stream
    dv.setUint32(msgPtr + MSG_CONTROLLEN, 0, true)
    dv.setInt32(msgPtr + MSG_FLAGS, 0, true)
    return count
  } finally {
    release(scratch, roundUp(Math.max(total, 1), PAGE))
  }
}

function getsockopt(fd, level, name, valuePtr, lengthPtr) {
  const info = socketInfo(fd)
  if (typeof info === 'number') return info
  let value
  if (level === SOL_SOCKET) {
    value = { [SO_TYPE]: info.type, [SO_ERROR]: 0, [SO_DOMAIN]: info.family, [SO_ACCEPTCONN]: info.listening ? 1 : 0,
      [SO_PROTOCOL]: info.family === AF_UNIX ? 0 : IPPROTO_TCP, [SO_SNDBUF]: 65536, [SO_RCVBUF]: 65536 }[name] ?? 0
  } else if (level === IPPROTO_IPV6 && name === IPV6_V6ONLY) value = info.v6only ? 1 : 0
  else if (level === IPPROTO_TCP) value = 0
  else return -ENOPROTOOPT
  if (valuePtr && lengthPtr && view().getUint32(lengthPtr, true) >= 4) {
    view().setInt32(valuePtr, value, true)
    view().setUint32(lengthPtr, 4, true)
  }
  return 0
}

/** Options are taken and kept where they mean something here (`IPV6_V6ONLY`); the rest change nothing on a loopback stream */
function setsockopt(fd, level, name, valuePtr, length) {
  const info = socketInfo(fd)
  if (typeof info === 'number') return info
  if (level === IPPROTO_IPV6 && name === IPV6_V6ONLY && valuePtr && length >= 4) remember(fd, { v6only: view().getInt32(valuePtr, true) !== 0 })
  return 0
}

function socketpair(domain, type, svPtr) {
  if (domain !== AF_UNIX) return -EOPNOTSUPP
  if ((type & SOCK_TYPE_MASK) !== SOCK_STREAM) return -ESOCKTNOSUPPORT
  const value = syscall_raw('sock_pair', type & SOCK_NONBLOCK)
  if (value < 0) return value
  const answer = new DataView(returned.buffer, returned.byteOffset)
  const pair = [answer.getInt32(0, true), answer.getInt32(4, true)]
  pair.forEach((fd, i) => {
    opened(fd, O_RDWR | (type & SOCK_NONBLOCK), (type & SOCK_CLOEXEC) !== 0)
    remember(fd, { family: AF_UNIX, type: SOCK_STREAM, local: {}, peer: {} })
    view().setInt32(svPtr + i * 4, fd, true)
  })
  return 0
}

// --- epoll ---

const EPOLL_CTL_ADD = 1, EPOLL_CTL_DEL = 2, EPOLL_CTL_MOD = 3
const EPOLLERR = 0x8, EPOLLHUP = 0x10, EPOLLONESHOT = 1 << 30
/** `struct epoll_event`, packed: events (4), data (8) */
const EPOLL_EVENT_SIZE = 12

/**
 * An epoll instance is a descriptor (of `/dev/null`, so the number is the kernel's and closes like any other) and its
 * interest list, kept here and asked of the kernel's `poll` each wait. An edge-triggered entry is reported as a
 * level-triggered one would be: a program that reads until EAGAIN, as edge-triggered ones must, sees the same events.
 */
const epolls = new Map()

function epollCreate(flags) {
  if (flags & ~O_CLOEXEC) return -EINVAL
  const fd = syscall_raw('open', '/dev/null', O_RDONLY, 0)
  if (fd < 0) return fd
  opened(fd, O_RDONLY, (flags & O_CLOEXEC) !== 0)
  epolls.set(fd, new Map())
  return fd
}

function epollCtl(epfd, op, fd, eventPtr) {
  const interest = epolls.get(epfd)
  if (!interest) return syscall_raw('fstat', epfd) < 0 ? -EBADF : -EINVAL
  if (syscall_raw('fstat', fd) < 0) return -EBADF
  if (fd === epfd) return -EINVAL
  const dv = view()
  switch (op) {
    case EPOLL_CTL_ADD:
      if (interest.has(fd)) return -EEXIST
      interest.set(fd, { events: dv.getUint32(eventPtr, true), data: dv.getBigUint64(eventPtr + 4, true) })
      return 0
    case EPOLL_CTL_MOD:
      if (!interest.has(fd)) return -ENOENT
      interest.set(fd, { events: dv.getUint32(eventPtr, true), data: dv.getBigUint64(eventPtr + 4, true) })
      return 0
    case EPOLL_CTL_DEL:
      return interest.delete(fd) ? 0 : -ENOENT
    default:
      return -EINVAL
  }
}

function epollWait(epfd, eventsPtr, max, timeout, sigmaskPtr) {
  const interest = epolls.get(epfd)
  if (!interest) return -EINVAL
  if (max <= 0) return -EINVAL
  // a descriptor closed since it was added leaves the list, as its last close takes it out of Linux's
  const entries = [...interest].filter(([fd]) => fds.has(fd) || syscall_raw('fstat', fd) >= 0 || !interest.delete(fd))
    .filter(([, entry]) => !entry.disabled)
  const saved = mask
  if (sigmaskPtr) {
    mask = view().getBigUint64(sigmaskPtr, true) & ~UNBLOCKABLE
    routeAll()
  }
  try {
    const value = syscall_raw('poll', entries.map(([fd, entry]) => ({ fd, events: (entry.events & 0xffff) | EPOLLERR | EPOLLHUP })), timeout)
    if (value <= 0) return value
    const answer = new DataView(returned.buffer, returned.byteOffset)
    const dv = view()
    let count = 0
    for (let i = 0; i < entries.length && count < max; i++) {
      const revents = answer.getUint16(i * 2, true)
      if (!revents) continue
      const [, entry] = entries[i]
      dv.setUint32(eventsPtr + count * EPOLL_EVENT_SIZE, revents, true)
      dv.setBigUint64(eventsPtr + count * EPOLL_EVENT_SIZE + 4, entry.data, true)
      if (entry.events & EPOLLONESHOT) entry.disabled = true
      count++
    }
    return count
  } finally {
    if (sigmaskPtr) {
      mask = saved
      routeAll()
    }
  }
}

// --- the table ---

/** What ecmaOS adds to or replaces in the `wali` table */
const calls = {
  __cl_get_envc: () => entries().length,
  __cl_get_env_len: index => encoder.encode(entries()[index] ?? '').byteLength,
  __cl_copy_env: (ptr, index) => {
    putString(ptr, entries()[index] ?? '')
    return 0
  },

  SYS_open: (path, flags, mode) => big(opened(syscall_raw('open', readString(path), flags, mode), flags)),
  SYS_openat: (dirfd, path, flags, mode) => at(dirfd, path, resolved => opened(syscall_raw('open', resolved, flags, mode), flags)),
  SYS_close: fd => {
    const value = syscall_raw('close', fd)
    if (value >= 0) {
      forget(fd)
      epolls.delete(fd)
    }
    return big(value)
  },
  // `struct linux_dirent64`: ino (8), off (8), reclen (2), type (1), the name and its NUL, padded to 8
  SYS_getdents64: (fd, ptr, count) => {
    let entries
    try {
      entries = getdents(fd)
    } catch (error) {
      return big(-(error?.errno ?? EBADF))
    }
    const out = bytes(), dv = view()
    let offset = 0, index = positions.get(fd) ?? 0
    for (; index < entries.length; index++) {
      const entry = entries[index]
      const name = encoder.encode(entry.name)
      const reclen = (19 + name.length + 1 + 7) & ~7
      if (offset + reclen > count) break
      dv.setBigUint64(ptr + offset, BigInt(entry.ino ?? 0), true)
      dv.setBigUint64(ptr + offset + 8, BigInt(index + 1), true)
      dv.setUint16(ptr + offset + 16, reclen, true)
      out[ptr + offset + 18] = entry.type ?? 0
      out.set(name, ptr + offset + 19)
      out.fill(0, ptr + offset + 19 + name.length, ptr + offset + reclen)
      offset += reclen
    }
    if (offset === 0 && index < entries.length) return big(-EINVAL)
    positions.set(fd, index)
    return big(offset)
  },
  SYS_dup: fd => big(opened(syscall_raw('dup', fd), entryOf(fd).flags, false)),
  SYS_dup2: (from, to) => {
    if (from === to) return big(syscall_raw('fstat', from) < 0 ? -EBADF : to)
    const value = syscall_raw('dup2', from, to)
    return big(value < 0 ? value : opened(value, entryOf(from).flags, false))
  },
  SYS_dup3: (from, to, flags) => {
    if (from === to || (flags & ~O_CLOEXEC)) return big(-EINVAL)
    const value = syscall_raw('dup2', from, to)
    return big(value < 0 ? value : opened(value, entryOf(from).flags, (flags & O_CLOEXEC) !== 0))
  },
  SYS_fcntl: (fd, cmd, arg) => big(fcntl(fd, cmd, num(arg))),
  // the dependency copies everything the kernel answered to the pointer, past the end of the structure
  SYS_ioctl: (fd, request, ptr) => {
    // how much a socket has to read; the kernel's ioctl does not know sockets
    if (request === FIONREAD) {
      const info = socketInfo(fd)
      if (typeof info !== 'number') {
        if (ptr) view().setInt32(ptr, info.readable, true)
        return 0n
      }
    }
    const size = IOCTL_ANSWER_SIZE[request]
    if (size === undefined) return original.SYS_ioctl(fd, request, ptr)
    const value = syscall_raw('ioctl', fd, request, undefined)
    if (value < 0) return big(value)
    if (ptr) give(ptr, size)
    return 0n
  },

  SYS_newfstatat: (dirfd, path, ptr, flags) => {
    if (!ptr) return big(-EFAULT)
    const name = readString(path)
    if (!name && (flags & AT_EMPTY_PATH)) return big(stat('fstat', ptr, dirfd))
    return at(dirfd, path, resolved => stat(flags & AT_SYMLINK_NOFOLLOW ? 'lstat' : 'stat', ptr, resolved), flags)
  },
  SYS_fstatat: (dirfd, path, ptr, flags) => calls.SYS_newfstatat(dirfd, path, ptr, flags),
  SYS_faccessat: (dirfd, path, mode) => at(dirfd, path, resolved => syscall_raw('access', resolved, mode)),
  SYS_faccessat2: (dirfd, path, mode, flags) => at(dirfd, path, resolved => syscall_raw('access', resolved, mode), flags),
  SYS_mkdirat: (dirfd, path, mode) => at(dirfd, path, resolved => syscall_raw('mkdir', resolved, mode)),
  SYS_unlinkat: (dirfd, path, flags) => at(dirfd, path, resolved => syscall_raw(flags & AT_REMOVEDIR ? 'rmdir' : 'unlink', resolved)),
  SYS_fchmodat: (dirfd, path, mode) => at(dirfd, path, resolved => syscall_raw('chmod', resolved, mode)),
  SYS_fchownat: (dirfd, path, uid, gid, flags) => at(dirfd, path, resolved => syscall_raw('chown', resolved, uid, gid), flags),
  SYS_symlinkat: (target, dirfd, path) => at(dirfd, path, resolved => syscall_raw('symlink', readString(target), resolved)),
  SYS_readlinkat: (dirfd, path, ptr, size) => at(dirfd, path, resolved => {
    const length = syscall_raw('readlink', resolved)
    return length < 0 ? length : give(ptr, size)
  }),
  SYS_renameat: (olddirfd, oldPath, newdirfd, newPath) => {
    const from = resolveAt(olddirfd, oldPath), to = resolveAt(newdirfd, newPath)
    if (typeof from === 'number') return big(from)
    if (typeof to === 'number') return big(to)
    return big(syscall_raw('rename', from, to))
  },
  // only the plain rename: RENAME_NOREPLACE and RENAME_EXCHANGE need the kernel to do them at once
  SYS_renameat2: (olddirfd, oldPath, newdirfd, newPath, flags) => flags ? big(-EINVAL) : calls.SYS_renameat(olddirfd, oldPath, newdirfd, newPath),
  SYS_linkat: (olddirfd, oldPath, newdirfd, newPath) => {
    const from = resolveAt(olddirfd, oldPath), to = resolveAt(newdirfd, newPath)
    if (typeof from === 'number') return big(from)
    if (typeof to === 'number') return big(to)
    return big(syscall_raw('link', from, to))
  },

  __ecmaos_spawn: (path, argv, envp, ops, count, flags, pgrp, defaults, sigmask) => big(spawn(path, argv, envp, ops, count, flags, pgrp, defaults, sigmask)),
  SYS_wait4: (pid, status, options, rusage) => big(wait4(pid, status, options, rusage)),
  SYS_execve: (path, argv, envp) => big(execve(path, argv, envp)),
  // there is no fork: posix_spawn (and system and popen, which use it) start programs
  SYS_fork: () => big(-ENOSYS),
  SYS_vfork: () => big(-ENOSYS),
  SYS_setpgid: (pid, pgid) => big(syscall_raw('proc_setpgid', pid, pgid)),
  SYS_getpgid: pid => big(syscall_raw('proc_getpgid', pid)),
  SYS_getpgrp: () => big(syscall_raw('proc_getpgid', 0)),
  SYS_setsid: () => big(syscall_raw('proc_setsid')),
  SYS_getsid: pid => big(syscall_raw('proc_getsid', pid)),

  SYS_rt_sigaction: (signal, actPtr, oldPtr) => {
    if (signal < 1 || signal > 64 || (actPtr && (signal === SIGKILL || signal === SIGSTOP))) return big(-EINVAL)
    const next = actPtr ? readAction(actPtr) : undefined
    if (oldPtr) writeAction(oldPtr, actionOf(signal))
    if (next) {
      actions.set(signal, next)
      if (next.handler === SIG_IGN) raised &= ~bit(signal)
      if (signal <= KERNEL_SIGNALS) route(signal)
    }
    return 0n
  },
  SYS_rt_sigprocmask: (how, setPtr, oldPtr) => {
    const previous = mask
    if (setPtr) {
      const set = view().getBigUint64(setPtr, true)
      if (how === 0) mask |= set
      else if (how === 1) mask &= ~set
      else if (how === 2) mask = set
      else return big(-EINVAL)
      mask &= ~UNBLOCKABLE
      routeAll()
    }
    if (oldPtr) view().setBigUint64(oldPtr, previous, true)
    return 0n
  },
  SYS_rt_sigpending: ptr => {
    if (!ptr) return big(-EFAULT)
    collect()
    view().setBigUint64(ptr, raised & mask, true)
    return 0n
  },
  SYS_rt_sigsuspend: maskPtr => {
    const saved = mask
    mask = view().getBigUint64(maskPtr, true) & ~UNBLOCKABLE
    routeAll()
    const result = waitForHandler()
    mask = saved
    routeAll()
    return big(result)
  },
  SYS_pause: () => big(waitForHandler()),
  SYS_kill: (pid, signal) => {
    if (signal < 0 || signal > 64) return big(-EINVAL)
    if (pid === getpid()) return big(raiseHere(signal))
    if (pid > 0) return big(syscall_raw('proc_kill', pid, signal))
    if (pid === -1) return big(-ENOSYS)
    const group = pid === 0 ? syscall_raw('proc_getpgid', 0) : -pid
    return big(syscall_raw('proc_killpg', group, signal))
  },
  // one thread per process: a thread id is the pid
  SYS_tkill: (tid, signal) => tid === getpid() ? big(raiseHere(signal)) : calls.SYS_kill(tid, signal),
  SYS_tgkill: (tgid, tid, signal) => tid === getpid() ? big(raiseHere(signal)) : calls.SYS_kill(tid, signal),

  SYS_clock_gettime: (clock, ptr) => {
    if (ptr) writeTimespec(ptr, now(clock))
    return 0n
  },
  SYS_nanosleep: (requestPtr, remainPtr) => big(sleep(readTimespec(requestPtr), remainPtr, 1)),
  SYS_clock_nanosleep: (clock, flags, requestPtr, remainPtr) => {
    const request = readTimespec(requestPtr)
    // returns the error itself rather than -1 and errno
    return big(-sleep(flags & TIMER_ABSTIME ? request - now(clock) : request, flags & TIMER_ABSTIME ? 0 : remainPtr, clock))
  },

  SYS_socket: (domain, type) => big(socket(domain, type)),
  SYS_socketpair: (domain, type, _protocol, sv) => big(socketpair(domain, type, sv)),
  SYS_bind: (fd, ptr, length) => big(bind(fd, ptr, length)),
  SYS_listen: (fd, backlog) => big(listen(fd, backlog)),
  SYS_accept: (fd, ptr, lengthPtr) => big(accept(fd, ptr, lengthPtr, 0)),
  SYS_accept4: (fd, ptr, lengthPtr, flags) => big(accept(fd, ptr, lengthPtr, flags)),
  SYS_connect: (fd, ptr, length) => big(connect(fd, ptr, length)),
  SYS_getsockname: (fd, ptr, lengthPtr) => big(socketName(fd, ptr, lengthPtr, 'local')),
  SYS_getpeername: (fd, ptr, lengthPtr) => big(socketName(fd, ptr, lengthPtr, 'peer')),
  SYS_shutdown: (fd, how) => big(syscall_raw('sock_shutdown', fd, how)),
  // a stream has its peer already, so the address of `sendto` is not needed and `recvfrom` gives none
  SYS_sendto: (fd, ptr, length, flags) => big(sendBytes(fd, bytes().slice(ptr, ptr + length), flags)),
  SYS_recvfrom: (fd, ptr, length, flags, _addr, lengthPtr) => {
    const value = receiveInto(fd, ptr, length, flags)
    if (value >= 0 && lengthPtr) view().setUint32(lengthPtr, 0, true)
    return big(value)
  },
  SYS_sendmsg: (fd, msg, flags) => big(sendmsg(fd, msg, flags)),
  SYS_recvmsg: (fd, msg, flags) => big(recvmsg(fd, msg, flags)),
  SYS_getsockopt: (fd, level, name, value, lengthPtr) => big(getsockopt(fd, level, name, value, lengthPtr)),
  SYS_setsockopt: (fd, level, name, value, length) => big(setsockopt(fd, level, name, value, length)),

  SYS_epoll_create: size => big(size <= 0 ? -EINVAL : epollCreate(0)),
  SYS_epoll_create1: flags => big(epollCreate(flags)),
  SYS_epoll_ctl: (epfd, op, fd, event) => big(epollCtl(epfd, op, fd, event)),
  SYS_epoll_wait: (epfd, events, max, timeout) => big(epollWait(epfd, events, max, timeout, 0)),
  SYS_epoll_pwait: (epfd, events, max, timeout, sigmask) => big(epollWait(epfd, events, max, timeout, sigmask)),

  SYS_mmap: (addr, length, prot, flags, fd, offset) => big(mmap(addr, length, prot, flags, fd, num(offset))),
  SYS_munmap: (addr, length) => {
    if (addr % PAGE) return big(-EINVAL)
    release(addr, roundUp(length, PAGE))
    return 0n
  },
  SYS_mremap: (addr, oldLength, newLength, flags) => big(mremap(addr, oldLength, newLength, flags)),
  SYS_mprotect: () => 0n,
  SYS_madvise: () => 0n
}

/** Adds ecmaOS's calls to the dependency's table, before the module is linked */
/** The dependency's own calls that ecmaOS's wrap */
const original = {}

export function install(wali) {
  Object.assign(original, { SYS_ioctl: wali.SYS_ioctl })
  const { SYS_lseek } = wali
  // `rewinddir` is a seek to 0, which starts the listing again
  calls.SYS_lseek = (fd, offset, whence) => {
    if (offset === 0n && whence === SEEK_SET) positions.delete(fd)
    return SYS_lseek(fd, offset, whence)
  }
  // a pipe's ends are recorded with their flags, O_CLOEXEC above all (popen's ends must not reach its child)
  for (const name of ['SYS_pipe', 'SYS_pipe2']) {
    const make = wali[name]
    calls[name] = (ptr, flags = 0) => {
      const value = make(ptr, flags)
      if (value >= 0n) {
        opened(view().getInt32(ptr, true), O_RDONLY | flags)
        opened(view().getInt32(ptr + 4, true), O_WRONLY | flags)
      }
      return value
    }
  }
  Object.assign(wali, calls)
  for (const [name, call] of Object.entries(wali)) {
    if (typeof call === 'function' && name !== '__proc_exit') wali[name] = delivering(name, call)
  }
  inheritSignals()
}

/** Gives this half the module's memory and function table, once it is instantiated */
export function attach(instance) {
  memory = instance.exports.memory
  table = instance.exports.__indirect_function_table
  top = roundUp(memory.buffer.byteLength, PAGE)
}
