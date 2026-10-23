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
 *   from the file, and shared mappings of files and devices kept in step with them at calls (`msync` too)
 * - processes: `posix_spawn` (`__ecmaos_spawn`, from the sysroot's musl patch), `wait4` and `execve` on the kernel's
 *   process calls, and the job-control ids
 * - signals: dispositions, the mask, pending signals, and handlers run when an import returns, with `EINTR` or a
 *   restart (`SA_RESTART`) for a call they interrupted, and `SIGPIPE` for a write nothing will read; a program off
 *   computing calls in from its loops when the kernel has set its signal word (`__ecmaos_poll`); the alternate signal
 *   stack (`sigaltstack`); `sleep` and the clocks
 * - sockets: stream sockets on the kernel's socket files (`tree/lib/socket-files.ts`), so a socket is one descriptor
 *   the kernel reads, writes and polls; `AF_UNIX`, and `AF_INET`/`AF_INET6` on loopback or through the gateway
 * - `epoll`, over the kernel's `poll`
 * - System V IPC, on the kernel's queues, semaphores and segments (`tree/lib/sysv-ipc.ts`), a segment mapped as a file
 * - threads' locks: the futexes, the priority-inheritance ones (`FUTEX_LOCK_PI`) among them, and the robust list a
 *   thread's process-shared robust locks are given up from when it ends (`set_robust_list`)
 *
 * Numbers are Linux's: WALI's musl is Linux musl, so `errno` values and structures need no translation.
 */

import { syscall_raw, returned, pending, on_signal, off_signal, init } from '@zenfs/linux/uapi/base'
import { getdents } from '@zenfs/linux/uapi/fs'
import { environ, getpid } from '@zenfs/linux/uapi/process'
import { absolute, environment_of, getcwd, openDescriptors, spawn as spawnShared } from './spawn.mjs'

const EPERM = 1, ENOENT = 2, ESRCH = 3, EINTR = 4, EBADF = 9, ENOMEM = 12, EFAULT = 14, EEXIST = 17, ENODEV = 19, EINVAL = 22, EMFILE = 24, EPIPE = 32, ENOSYS = 38
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
/** This thread's stack pointer, which the program exports (`utils/wali/signal-checks.mjs`) for `SA_ONSTACK` */
let stackPointer
const bytes = () => new Uint8Array(memory.buffer)

/**
 * What the process's threads share, in one SharedArrayBuffer the first thread makes and each new one is given: the
 * allocator's lock, top and free ranges, a version for the signal dispositions, a close-on-exec bit per descriptor,
 * the dispositions themselves, the futexes' wake counters (see `futex`), the resource limits and the sealed ranges (see
 * `releaseRange`). Everything else here (the mask, pending signals, epoll instances, directory
 * positions, shared mappings) is the thread's own.
 */
const LOCK = 0, VERSION = 1, TOP = 2, FREE_COUNT = 3, SEALED_COUNT = 4, HEADER_WORDS = 16
const MAX_RANGES = 16384, MAX_SEALED = 1024, MAX_FDS = 65536, SIGNALS = 65, FUTEX_BUCKETS = 256, RESOURCES = 16
const RLIMIT_NOFILE = 7, RLIM_INFINITY = 0xffffffffffffffffn
function sharedState(buffer) {
  const rangesAt = HEADER_WORDS, cloexecAt = rangesAt + MAX_RANGES * 2, actionsAt = cloexecAt + MAX_FDS / 32
  const wakesAt = actionsAt + SIGNALS * 6, limitsAt = wakesAt + FUTEX_BUCKETS, sealedAt = limitsAt + RESOURCES * 4
  const fresh = !buffer
  buffer ??= new SharedArrayBuffer((sealedAt + MAX_SEALED * 2) * 4)
  const limits = new BigUint64Array(buffer, limitsAt * 4, RESOURCES * 2)
  if (fresh) {
    // each resource's soft and hard limit: none, but for descriptors, which have Linux's usual 1024 and a hard
    // limit of what this host keeps flags for
    limits.fill(RLIM_INFINITY)
    limits[RLIMIT_NOFILE * 2] = 1024n
    limits[RLIMIT_NOFILE * 2 + 1] = BigInt(MAX_FDS)
  }
  return {
    limits,
    buffer,
    words: new Int32Array(buffer),
    addresses: new Uint32Array(buffer),
    ranges: new Uint32Array(buffer, rangesAt * 4, MAX_RANGES * 2),
    sealed: new Uint32Array(buffer, sealedAt * 4, MAX_SEALED * 2),
    cloexec: new Int32Array(buffer, cloexecAt * 4, MAX_FDS / 32),
    actions: new Uint32Array(buffer, actionsAt * 4, SIGNALS * 6),
    wakes: new Int32Array(buffer, wakesAt * 4, FUTEX_BUCKETS)
  }
}
let state
/** For a thread other than the first: the process's id and this thread's */
let thread
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

/**
 * Whether each descriptor closes on exec (`FD_CLOEXEC`), which the kernel does not keep: a bit per descriptor in the
 * state the process's threads share. The kernel's table is the truth for what is open, and the open file's status
 * flags are the kernel's too (`fd_getfl`).
 */
const isCloexec = fd => fd >= 0 && fd < MAX_FDS && (Atomics.load(state.cloexec, fd >> 5) & (1 << (fd & 31))) !== 0

function setCloexec(fd, on) {
  if (fd < 0 || fd >= MAX_FDS) return
  if (on) Atomics.or(state.cloexec, fd >> 5, 1 << (fd & 31))
  else Atomics.and(state.cloexec, fd >> 5, ~(1 << (fd & 31)))
}

/** Records a descriptor the kernel just handed out, closing on exec if `flags` has `O_CLOEXEC` or `cloexec` says so */
function opened(fd, flags, cloexec = (flags & O_CLOEXEC) !== 0) {
  if (fd < 0) return fd
  forget(fd)
  setCloexec(fd, cloexec)
  return fd
}

/** The soft limit on descriptors: one at or past it may not be had */
const descriptorLimit = () => Number(Atomics.load(state.limits, RLIMIT_NOFILE * 2))

/** Descriptors the program asked for, given back if any is past RLIMIT_NOFILE: then EMFILE, else the first */
function withinLimit(...fds) {
  if (fds.some(fd => fd < 0)) return fds.find(fd => fd < 0)
  if (fds.every(fd => fd < descriptorLimit())) return fds[0]
  for (const fd of fds) {
    syscall_raw('close', fd)
    forget(fd)
  }
  return -EMFILE
}

/** `prlimit64` (and getrlimit and setrlimit on it), for this process: `struct rlimit` is two 64-bit numbers */
function prlimit(pid, resource, newPtr, oldPtr) {
  if (pid !== 0 && pid !== getpid()) return pid > 0 ? -EPERM : -ESRCH
  if (resource < 0 || resource >= RESOURCES) return -EINVAL
  const dv = view()
  if (newPtr) {
    const soft = dv.getBigUint64(newPtr, true), hard = dv.getBigUint64(newPtr + 8, true)
    if (soft > hard) return -EINVAL
    if (resource === RLIMIT_NOFILE && hard > BigInt(MAX_FDS)) return -EPERM
  }
  if (oldPtr) {
    dv.setBigUint64(oldPtr, Atomics.load(state.limits, resource * 2), true)
    dv.setBigUint64(oldPtr + 8, Atomics.load(state.limits, resource * 2 + 1), true)
  }
  if (newPtr) {
    Atomics.store(state.limits, resource * 2, dv.getBigUint64(newPtr, true))
    Atomics.store(state.limits, resource * 2 + 1, dv.getBigUint64(newPtr + 8, true))
  }
  return 0
}

/** How far `getdents64` has read each directory, as an index into the kernel's listing */
const positions = new Map()

/** Forgets what was known about a descriptor that has been closed or replaced */
function forget(fd) {
  setCloexec(fd, false)
  positions.delete(fd)
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
  switch (cmd) {
    case F_DUPFD:
    case F_DUPFD_CLOEXEC: {
      // the kernel's dup takes the lowest free number; one at or above `arg` is found by trying the next ones
      const want = Math.max(0, arg)
      if (want >= descriptorLimit()) return -EINVAL
      let copy = syscall_raw('dup', fd)
      const held = []
      while (copy >= 0 && copy < want) {
        held.push(copy)
        copy = syscall_raw('dup', fd)
      }
      for (const extra of held) syscall_raw('close', extra)
      return withinLimit(opened(copy, 0, cmd === F_DUPFD_CLOEXEC))
    }
    case F_GETFD:
      return syscall_raw('fstat', fd) < 0 ? -EBADF : (isCloexec(fd) ? FD_CLOEXEC : 0)
    case F_SETFD:
      if (syscall_raw('fstat', fd) < 0) return -EBADF
      setCloexec(fd, (arg & FD_CLOEXEC) !== 0)
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

/**
 * The ioctls the kernel's devices answer with bytes or take bytes for: `EVIOC*` (an input device), `FBIO*` (a
 * framebuffer) and the GL devices' (`tree/lib/gl.ts`). The kernel leaves the answer in the return region and gives its
 * length; a request that sets something carries the bytes it points to. Also the controlling terminal's, on the
 * kernel's process calls. @returns the result, or undefined for a request that is not one of these
 */
const TIOCSCTTY = 0x540e, TIOCNOTTY = 0x5422, TIOCGSID = 0x5429
const FBIOPUT_VSCREENINFO = 0x4601, FBIO_SETCURSOR = 0x46f0, FBIO_SETWINSTATE = 0x46f2, FBIO_SETCLIPBOARD = 0x46f3, FBIO_SETCURSORIMAGE = 0x46f6
/** How many bytes a setting request's argument is */
const IOCTL_ARGUMENT_SIZE = { [FBIOPUT_VSCREENINFO]: 160, [FBIO_SETCURSOR]: 64, [FBIO_SETWINSTATE]: 4, [FBIO_SETCLIPBOARD]: 4096, [FBIO_SETCURSORIMAGE]: 16 + 64 * 64 * 4 }

const FBIOGET_FSCREENINFO = 0x4602

/**
 * `struct fb_fix_screeninfo` has `unsigned long` fields, which are 8 bytes here: the kernel's answer (4-byte longs, as
 * the Emscripten programs have them) is moved into this target's layout, field by field
 */
function fixScreenInfo(ptr, length) {
  const answer = new DataView(returned.buffer, returned.byteOffset, length)
  const out = new Uint8Array(80)
  const dv = new DataView(out.buffer)
  out.set(returned.subarray(0, 16))
  dv.setBigUint64(16, BigInt(answer.getUint32(16, true)), true) // smem_start
  for (const [from, to] of [[20, 24], [24, 28], [28, 32], [32, 36], [44, 48], [56, 68]]) dv.setUint32(to, answer.getUint32(from, true), true)
  for (const [from, to] of [[36, 40], [38, 42], [40, 44], [60, 72], [62, 74], [64, 76]]) dv.setUint16(to, answer.getUint16(from, true), true)
  dv.setBigUint64(56, BigInt(answer.getUint32(48, true)), true) // mmio_start
  dv.setUint32(64, answer.getUint32(52, true), true) // mmio_len
  bytes().set(out, ptr)
}

const TIOCGPTN = 0x80045430, TIOCSPTLCK = 0x40045431, TIOCSWINSZ = 0x5414

function deviceIoctl(fd, request, ptr) {
  // a pty master's number and its lock: an int each, through the pointer
  if (request === TIOCGPTN) {
    const number = syscall_raw('ioctl', fd, request, undefined)
    if (number < 0) return number
    if (ptr) view().setInt32(ptr, number, true)
    return 0
  }
  if (request === TIOCSPTLCK) return syscall_raw('ioctl', fd, request, ptr ? view().getInt32(ptr, true) : 0)
  // the kernel's terminals take a size as `{ rows, cols }`
  if (request === TIOCSWINSZ) {
    if (!ptr) return -EFAULT
    return syscall_raw('ioctl', fd, request, { rows: view().getUint16(ptr, true), cols: view().getUint16(ptr + 2, true) })
  }
  if (request === TIOCSCTTY) return syscall_raw('proc_ctty', 0, fd, ptr)
  if (request === TIOCNOTTY) return syscall_raw('proc_ctty', 1, fd, 0)
  if (request === TIOCGSID) {
    const sid = syscall_raw('proc_ctty', 2, fd, 0)
    if (sid < 0) return sid
    if (ptr) view().setInt32(ptr, sid, true)
    return 0
  }
  const type = (request >>> 8) & 0xff
  if (type !== 0x45 && type !== 0x46 && type !== 0x47) return undefined
  const size = IOCTL_ARGUMENT_SIZE[request] ?? (type === 0x47 ? 8 : 0)
  const argument = ptr && size ? bytes().slice(ptr, ptr + size) : undefined
  const length = syscall_raw('ioctl', fd, request, argument)
  if (length < 0) return length
  if (request === FBIOGET_FSCREENINFO && ptr) {
    fixScreenInfo(ptr, length)
    return 0
  }
  if (length > 0 && ptr) {
    // a request that names its size (`_IOC_SIZE`) gets no more than that
    const named = (request >>> 16) & 0x3fff
    give(ptr, named || length)
  }
  // `fbdev` and GL requests give 0; an event device's give the length of what it answered
  return type === 0x46 || type === 0x47 ? 0 : length
}

// --- memory mappings ---

/**
 * Mappings live above the memory the module came up with. Freed ranges are kept, merged with their neighbours, and
 * used again first-fit; the memory only grows when nothing free is big enough. Lengths are in musl's 4 KiB pages.
 * What is free is zeroes, as is all above the top, so a new mapping needs no clearing.
 */
/** The free ranges, the top and the sealed ranges, loaded from the shared state while the allocator's lock is held (see `locked`) */
let free = []
let top = 0
let sealed = []

/** Takes [start, end) out of a list of ranges, returning the parts of it the list had */
function cut(list, start, end) {
  const taken = []
  for (let i = 0; i < list.length;) {
    const range = list[i], to = range.start + range.length
    if (to <= start || range.start >= end) { i++; continue }
    taken.push({ start: Math.max(start, range.start), length: Math.min(end, to) - Math.max(start, range.start) })
    const rest = [{ start: range.start, length: start - range.start }, { start: end, length: to - end }].filter(piece => piece.length > 0)
    list.splice(i, 1, ...rest)
    i += rest.length
  }
  return taken
}

const roundUp = (n, to) => Math.ceil(n / to) * to

/**
 * A released range is cleared, but for the parts still sealed: an anonymous mapping made PROT_NONE and never given
 * access by mprotect, which nothing can have written (libc-test's vmfill maps and unmaps gigabytes of them while it
 * finds out how much there is, and clearing those again each time took seconds).
 */
function releaseRange(start, length) {
  const kept = cut(sealed, start, start + length)
  let at = start
  for (const range of [...kept, { start: start + length, length: 0 }]) {
    if (range.start > at) bytes().fill(0, at, range.start)
    at = range.start + range.length
  }
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

function allocateRange(length) {
  const index = free.findIndex(range => range.length >= length)
  if (index >= 0) {
    const range = free[index]
    const start = range.start
    if (range.length === length) free.splice(index, 1)
    else Object.assign(range, { start: start + length, length: range.length - length })
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

/**
 * The allocator is the process's, shared by its threads: its free ranges and top live in the shared state, and each
 * change is made under its lock, with the list loaded here first and stored back after. A call that makes another
 * (a move that allocates and releases) holds the lock once.
 */
let depth = 0
function locked(change) {
  if (depth++ === 0) {
    while (Atomics.compareExchange(state.words, LOCK, 0, 1) !== 0) Atomics.wait(state.words, LOCK, 1, 1)
    top = Atomics.load(state.addresses, TOP)
    const count = Atomics.load(state.addresses, FREE_COUNT)
    free = Array.from({ length: count }, (_, i) => ({ start: state.ranges[i * 2], length: state.ranges[i * 2 + 1] }))
    sealed = Array.from({ length: Atomics.load(state.addresses, SEALED_COUNT) }, (_, i) => ({ start: state.sealed[i * 2], length: state.sealed[i * 2 + 1] }))
  }
  try {
    return change()
  } finally {
    if (--depth === 0) {
      if (free.length > MAX_RANGES) free.splice(0, free.length - MAX_RANGES) // the lowest ranges, kept by nothing, are lost
      free.forEach((range, i) => { state.ranges[i * 2] = range.start; state.ranges[i * 2 + 1] = range.length })
      Atomics.store(state.addresses, FREE_COUNT, free.length)
      // a range forgotten is only cleared when released, as any other is
      if (sealed.length > MAX_SEALED) sealed.splice(0, sealed.length - MAX_SEALED)
      sealed.forEach((range, i) => { state.sealed[i * 2] = range.start; state.sealed[i * 2 + 1] = range.length })
      Atomics.store(state.addresses, SEALED_COUNT, sealed.length)
      Atomics.store(state.addresses, TOP, top)
      Atomics.store(state.words, LOCK, 0)
      Atomics.notify(state.words, LOCK, 1)
    }
  }
}
const release = (start, length) => locked(() => releaseRange(start, length))
const allocate = length => locked(() => allocateRange(length))
const resize = (addr, oldLength, newLength, flags) => locked(() => resizeRange(addr, oldLength, newLength, flags))

function mmap(addr, length, prot, flags, fd, offset) {
  if (!length) return -EINVAL
  if (flags & MAP_FIXED) return -ENOSYS
  const shared = (flags & MAP_SHARED) && !(flags & MAP_ANONYMOUS)
  let kind
  if (shared) {
    kind = fileKind(fd)
    if (kind < 0) return kind
  }
  const size = roundUp(length, PAGE)
  const start = locked(() => {
    const at = allocateRange(size)
    if (at >= 0 && prot === PROT_NONE && (flags & MAP_ANONYMOUS)) sealed.push({ start: at, length: size })
    return at
  })
  if (start < 0) return start
  if (!(flags & MAP_ANONYMOUS)) {
    const result = fill(fd, start, length, offset)
    if (result < 0) {
      release(start, size)
      return result
    }
  }
  if (shared) {
    const own = syscall_raw('dup', fd)
    if (own < 0) {
      release(start, size)
      return own
    }
    // the mapping's own descriptor, which a child or a new image does not get
    opened(own, O_RDWR, true)
    const mapping = { ptr: start, length, prot, file: { fd: own, refs: 1 }, offset, shadow: bytes().slice(start, start + length), regular: kind === S_IFREG }
    mappings.set(start, mapping)
  }
  return start
}

function resizeRange(addr, oldLength, newLength, flags) {
  const before = roundUp(oldLength, PAGE), after = roundUp(newLength, PAGE)
  if (after <= before) {
    if (after < before) release(addr + after, before - after)
    return addr
  }
  // grow in place into a free neighbour, or off the top
  const next = free.findIndex(range => range.start === addr + before)
  if (next >= 0 && free[next].length >= after - before) {
    const range = free[next]
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

/**
 * `mremap`: a shared mapping is written out first and follows its pages, taking what the file holds for any it grows
 * by
 */
function mremap(addr, oldLength, newLength, flags) {
  const mapping = mappings.get(addr)
  if (mapping) flushMapping(mapping)
  const moved = resize(addr, oldLength, newLength, flags)
  if (!mapping || moved < 0) return moved
  mappings.delete(addr)
  const shadow = new Uint8Array(newLength)
  shadow.set(mapping.shadow.subarray(0, Math.min(mapping.length, newLength)))
  if (newLength > mapping.length) {
    fill(mapping.file.fd, moved + mapping.length, newLength - mapping.length, mapping.offset + mapping.length)
    shadow.set(bytes().subarray(moved + mapping.length, moved + newLength), mapping.length)
  }
  mappings.set(moved, { ...mapping, ptr: moved, length: newLength, shadow })
  return moved
}

// --- shared file mappings ---

/**
 * Linear memory is the program's alone, so a shared mapping of a file or a device (a framebuffer) cannot be the
 * object's own pages. It is a region filled from the object with a copy of what was filled (the shadow), kept in step
 * at the calls where the object could be seen or changed by someone else: pages the program changed (memory differs
 * from the shadow) are written to the object before them, and, after a call that waits or reads, pages another writer
 * changed (the object differs from the shadow while memory still equals it) are brought in. A program that draws into
 * a mapped framebuffer and makes no call is seen when it next sleeps, polls, writes, reads the clock, or exits. This is
 * what `wasi-preview1.mjs` does for the Emscripten programs.
 */
const PROT_NONE = 0, PROT_WRITE = 2
const MS_INVALIDATE = 2
const S_IFMT = 0o170000, S_IFREG = 0o100000, S_IFCHR = 0o020000
/** address -> { ptr, length, prot, file: { fd, refs } (its own descriptor), offset, shadow, regular, stamp } */
const mappings = new Map()

/** A descriptor's file type, for what may be mapped shared: a regular file or a character device */
function fileKind(fd) {
  if (syscall_raw('fstat', fd) < 0) return -EBADF
  const mode = new DataView(returned.buffer, returned.byteOffset).getUint32(24, true) & S_IFMT
  return mode === S_IFREG || mode === S_IFCHR ? mode : -ENODEV
}

const O_CREAT = 0o100, O_EXCL = 0o200
const MFD_CLOEXEC = 1, MFD_ALLOW_SEALING = 2, MFD_NOEXEC_SEAL = 8, MFD_EXEC = 0x10
const FALLOC_FL_KEEP_SIZE = 1

/**
 * `memfd_create`: a file in memory that has no name, which a program sizes, maps and hands to another (a Wayland
 * client's wl_shm pool). It is a file made in /dev/shm and unlinked at once; seals are not kept.
 */
function memfdCreate(flags) {
  if (flags & ~(MFD_CLOEXEC | MFD_ALLOW_SEALING | MFD_NOEXEC_SEAL | MFD_EXEC)) return -EINVAL
  for (;;) {
    const path = `/dev/shm/.memfd-${getpid()}-${Math.random().toString(36).slice(2)}`
    const fd = syscall_raw('open', path, O_RDWR | O_CREAT | O_EXCL, 0o600)
    if (fd === -EEXIST) continue
    if (fd < 0) return fd
    syscall_raw('unlink', path)
    return withinLimit(opened(fd, O_RDWR, (flags & MFD_CLOEXEC) !== 0))
  }
}

/**
 * `fallocate` with mode 0 or `FALLOC_FL_KEEP_SIZE`: the file has room for the range, so it grows to its end if it is
 * shorter (the other modes punch, collapse or zero ranges, which the file systems here do not)
 */
function fallocate(fd, mode, offset, length) {
  if (offset < 0 || length <= 0) return -EINVAL
  if (mode & ~FALLOC_FL_KEEP_SIZE) return -EOPNOTSUPP
  const kind = fileKind(fd)
  if (kind < 0 && kind !== -ENODEV) return kind
  if (kind !== S_IFREG) return -ENODEV
  const size = stampOf(fd)?.size ?? 0
  if ((mode & FALLOC_FL_KEEP_SIZE) || size >= offset + length) return 0
  return syscall_raw('ftruncate', fd, offset + length)
}

/** What the object holds under a mapping, read fresh */
function readBacking(mapping) {
  const into = new Uint8Array(mapping.length)
  for (let done = 0; done < mapping.length;) {
    const count = syscall_raw('read', mapping.file.fd, Math.min(mapping.length - done, 1 << 20), mapping.offset + done)
    if (count <= 0) break
    into.set(returned.subarray(0, count), done)
    done += count
  }
  return into
}

/** Whether `a[aAt, aAt + n)` and `b[bAt, bAt + n)` differ; whole words while both are aligned, which they are for a page */
function differ(a, aAt, b, bAt, n) {
  let i = 0
  if (((a.byteOffset + aAt) | (b.byteOffset + bAt)) % 4 === 0) {
    const a32 = new Uint32Array(a.buffer, a.byteOffset + aAt, n >> 2)
    const b32 = new Uint32Array(b.buffer, b.byteOffset + bAt, n >> 2)
    for (; i < a32.length; i++) if (a32[i] !== b32[i]) return true
    i <<= 2
  }
  for (; i < n; i++) if (a[aAt + i] !== b[bAt + i]) return true
  return false
}

/** A regular file's size, modification and change times, as `struct stat` has them, and its modification time in ms */
function stampOf(fd) {
  if (syscall_raw('fstat', fd) < 0) return undefined
  const dv = new DataView(returned.buffer, returned.byteOffset)
  const mtime = Number(dv.getBigInt64(88, true)) * 1000 + Number(dv.getBigInt64(96, true)) / 1e6
  return { key: `${dv.getBigInt64(48, true)}:${mtime}:${dv.getBigInt64(104, true)}:${dv.getBigInt64(112, true)}`, size: Number(dv.getBigInt64(48, true)), mtime }
}

/** Writes the pages of a mapping the program changed to its object */
function flushMapping(mapping) {
  if (!(mapping.prot & PROT_WRITE)) return
  const memory = bytes()
  // a regular file keeps its size: bytes past its end are not written (a file does not grow by being mapped)
  const limit = mapping.regular ? Math.max(0, Math.min(mapping.length, (stampOf(mapping.file.fd)?.size ?? 0) - mapping.offset)) : mapping.length
  let runStart = -1
  const flushRun = end => {
    if (runStart < 0) return
    const stop = Math.min(end, limit)
    if (stop > runStart) {
      const data = memory.slice(mapping.ptr + runStart, mapping.ptr + stop)
      syscall_raw('write', mapping.file.fd, data, mapping.offset + runStart)
      mapping.shadow.set(data, runStart)
    }
    runStart = -1
  }
  for (let at = 0; at < mapping.length; at += PAGE) {
    const end = Math.min(at + PAGE, mapping.length)
    if (!differ(memory, mapping.ptr + at, mapping.shadow, at, end - at)) flushRun(at)
    else if (runStart < 0) runStart = at
  }
  flushRun(mapping.length)
}

/** Brings in the pages another writer changed and the program has not */
function refreshMapping(mapping) {
  const memory = bytes()
  // A regular file whose size and times are as when last read, and were stamped before this millisecond, was not
  // written since (a write at this millisecond could still share the stamp, so that is read in full)
  if (mapping.regular) {
    const stamp = stampOf(mapping.file.fd)
    if (stamp && stamp.key === mapping.stamp && Date.now() > stamp.mtime + 1) return
    mapping.stamp = stamp?.key
  }
  const fresh = readBacking(mapping)
  for (let at = 0; at < mapping.length; at += PAGE) {
    const end = Math.min(at + PAGE, mapping.length)
    if (!differ(fresh, at, mapping.shadow, at, end - at)) continue
    if (!differ(memory, mapping.ptr + at, mapping.shadow, at, end - at)) {
      memory.set(fresh.subarray(at, end), mapping.ptr + at)
      mapping.shadow.set(fresh.subarray(at, end), at)
    }
  }
}

const overlapping = (addr, length) => [...mappings.values()].filter(m => m.ptr < addr + length && addr < m.ptr + m.length)

function msync(addr, length, flags) {
  if (addr % PAGE) return -EINVAL
  for (const mapping of overlapping(addr, length)) {
    flushMapping(mapping)
    if (flags & MS_INVALIDATE) refreshMapping(mapping)
  }
  return 0
}

/** `mprotect`: only unseals (see `releaseRange`); the memory is not protected */
function mprotect(addr, length, prot) {
  if (addr % PAGE) return -EINVAL
  if (prot !== PROT_NONE) locked(() => cut(sealed, addr, addr + roundUp(length, PAGE)))
  return 0
}

/** `munmap`: the pages are written out first; what is left of a mapping unmapped in part stays mapped */
function munmap(addr, length) {
  if (addr % PAGE) return -EINVAL
  const end = addr + roundUp(length, PAGE)
  for (const mapping of overlapping(addr, end - addr)) {
    flushMapping(mapping)
    mappings.delete(mapping.ptr)
    mapping.file.refs--
    const pieces = [[mapping.ptr, Math.min(addr, mapping.ptr + mapping.length)], [Math.max(end, mapping.ptr), mapping.ptr + mapping.length]]
    for (const [from, to] of pieces) {
      if (to <= from) continue
      const at = from - mapping.ptr
      mapping.file.refs++
      mappings.set(from, { ...mapping, ptr: from, length: to - from, offset: mapping.offset + at, shadow: mapping.shadow.slice(at, to - mapping.ptr) })
    }
    if (!mapping.file.refs) {
      syscall_raw('close', mapping.file.fd)
      forget(mapping.file.fd)
    }
  }
  release(addr, end - addr)
  for (const at of attachments.keys()) if (at >= addr && at < end) attachments.delete(at)
  return 0
}

const flushAll = () => { for (const mapping of mappings.values()) flushMapping(mapping) }
const refreshAll = () => { for (const mapping of mappings.values()) refreshMapping(mapping) }

/** Calls before which the program's changes are written out: another process could look at the object next */
const FLUSH_BEFORE = new Set(['SYS_write', 'SYS_writev', 'SYS_pwrite64', 'SYS_pwritev', 'SYS_fsync', 'SYS_fdatasync', 'SYS_close',
  'SYS_ioctl', 'SYS_ftruncate', 'SYS_fallocate', 'SYS_sendto', 'SYS_sendmsg', 'SYS_kill', 'SYS_execve', '__ecmaos_spawn',
  'SYS_exit', 'SYS_exit_group', '__proc_exit'])
/** Calls that wait or read: changes go out before them, and other writers' come in after */
const REFRESH_AFTER = new Set(['SYS_read', 'SYS_readv', 'SYS_pread64', 'SYS_preadv', 'SYS_poll', 'SYS_ppoll', 'SYS_select',
  'SYS_pselect6', 'SYS_epoll_wait', 'SYS_epoll_pwait', 'SYS_recvfrom', 'SYS_recvmsg', 'SYS_nanosleep', 'SYS_clock_nanosleep',
  'SYS_wait4', 'SYS_pause', 'SYS_rt_sigsuspend', 'SYS_futex', 'SYS_semop', 'SYS_semtimedop', 'SYS_msgsnd', 'SYS_msgrcv', 'SYS_shmdt'])
/** The clock is how a program that calls nothing else paces its frames, so reading it writes out at most every 16 ms */
const FLUSH_THROTTLED = new Set(['SYS_clock_gettime', 'SYS_gettimeofday'])
let lastClockFlush = 0

/** An import with the shared mappings kept in step around it */
function mapped(name, call) {
  const before = FLUSH_BEFORE.has(name) || REFRESH_AFTER.has(name), after = REFRESH_AFTER.has(name), throttled = FLUSH_THROTTLED.has(name)
  if (!before && !throttled) return call
  return (...args) => {
    if (!mappings.size) return call(...args)
    if (before) flushAll()
    else {
      const now = Date.now()
      if (now - lastClockFlush >= 16) {
        lastClockFlush = now
        flushAll()
      }
    }
    try {
      return call(...args)
    } finally {
      if (after) refreshAll()
    }
  }
}

// --- signals ---

/** This port's SIG_DFL and SIG_IGN: a table index can be any small number, so ignoring is -2, as a u32 */
const SIG_DFL = 0, SIG_IGN = 0xfffffffe
const SA_ONSTACK = 0x08000000n, SA_RESTART = 0x10000000n, SA_NODEFER = 0x40000000n, SA_RESETHAND = 0x80000000n
const SIGKILL = 9, SIGSTOP = 19
/** Signals whose default action is to do nothing */
const DEFAULT_IGNORED = new Set([17 /* SIGCHLD */, 18 /* SIGCONT */, 23 /* SIGURG */, 28 /* SIGWINCH */])
/** The signals the kernel raises on a thread: the standard ones, 1 to 31 */
const KERNEL_SIGNALS = 31
/** The real-time signals, which the kernel queues for the thread, every one sent delivered (`tree/lib/wali-signals.ts`) */
const SIGRTMIN = 32, SIGRTMAX = 64
const bit = signal => 1n << BigInt(signal - 1)
const UNBLOCKABLE = bit(SIGKILL) | bit(SIGSTOP)

/**
 * Per signal, what `rt_sigaction` set: `handler` is a table index, or SIG_DFL or SIG_IGN. Dispositions are the
 * process's, so they live in the shared state, six words a signal; a change bumps a version each thread checks as a
 * call comes in, to route the signals it should again (the mask and pending signals are each thread's own).
 */
const defaultAction = { handler: SIG_DFL, flags: 0n, restorer: 0, mask: 0n }
const ACTION_WORDS = 6
function actionOf(signal) {
  const at = signal * ACTION_WORDS, words = state.actions
  return {
    handler: words[at],
    flags: BigInt(words[at + 1]) | (BigInt(words[at + 2]) << 32n),
    restorer: words[at + 3],
    mask: BigInt(words[at + 4]) | (BigInt(words[at + 5]) << 32n)
  }
}
function setAction(signal, action) {
  const at = signal * ACTION_WORDS, words = state.actions
  words[at] = action.handler
  words[at + 1] = Number(action.flags & 0xffffffffn)
  words[at + 2] = Number(action.flags >> 32n)
  words[at + 3] = action.restorer
  words[at + 4] = Number(action.mask & 0xffffffffn)
  words[at + 5] = Number(action.mask >> 32n)
  seenVersion = Atomics.add(state.words, VERSION, 1) + 1
}
let seenVersion = 0
/** Where the process's signal word is, in the program's memory (`attach`), for a program whose loops read one */
let signalWord = 0
let mask = 0n
/** Raised and not yet delivered, as a sigset */
let raised = 0n
/** How many signals have been raised, so a call can tell whether one arrived while it ran */
let arrivals = 0
/** How many of each real-time signal are raised: they queue, where a standard one sent again merges */
const queued = new Map()
/** The signals the kernel hands to this process rather than taking its default action for */
const routed = new Set()

function record(signal) {
  raised |= bit(signal)
  if (signal >= SIGRTMIN) queued.set(signal, (queued.get(signal) ?? 0) + 1)
  arrivals++
}

/** Takes one of a raised signal for delivery: the last of a real-time one, or a standard one */
function take(signal) {
  const count = queued.get(signal) ?? 0
  if (count > 1) return queued.set(signal, count - 1)
  queued.delete(signal)
  raised &= ~bit(signal)
}

/** Drops a raised signal, every one of it queued (one that comes to be ignored) */
function drop(signal) {
  queued.delete(signal)
  raised &= ~bit(signal)
}

/**
 * A signal comes to this process when it has a handler, is ignored, or is blocked (it then waits here, the kernel
 * knows no mask); otherwise the kernel takes its default action, terminating or stopping the process itself.
 */
function route(signal) {
  if (signal >= SIGRTMIN) return publishRealTime()
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
  publishRealTime()
}

/** The real-time signals the kernel queues for this thread rather than ending the process: those it routes, as above */
let realTime = -1n
function publishRealTime() {
  let set = 0n
  for (let signal = SIGRTMIN; signal <= SIGRTMAX; signal++) {
    if (actionOf(signal).handler !== SIG_DFL || (mask & bit(signal)) !== 0n) set |= 1n << BigInt(signal - SIGRTMIN)
  }
  if (set === realTime) return
  realTime = set
  syscall_raw('proc_rt_sigstate', Number(set & 0xffffffffn), Number(set >> 32n))
}
const takesRealTime = signal => ((realTime >> BigInt(signal - SIGRTMIN)) & 1n) !== 0n

/**
 * Tells the kernel which signals are ignored and blocked now: what an exec keeps, and what decides whether reading the
 * terminal from the background is EIO rather than `SIGTTIN`
 */
let published = ''
function publish() {
  const ignored = ignoredSet(), blocked = kernelSet(mask)
  if (`${ignored}:${blocked}` === published) return
  published = `${ignored}:${blocked}`
  syscall_raw('proc_set_sigstate', ignored, blocked)
}

/**
 * Signals the kernel raised while the program was computing, which the next syscall would otherwise clear. A program
 * with a signal word (`attach`) has them cleared from the page at once, by a syscall, or the next import would take
 * them again (and the word, which stays set while a thread has some, would keep the others' loops calling in)
 */
function collect() {
  // another thread changed a disposition
  const version = Atomics.load(state.words, VERSION)
  if (version !== seenVersion) {
    seenVersion = version
    routeAll()
  }
  const bits = pending()
  if (!bits) return
  for (let signal = 1; signal <= KERNEL_SIGNALS; signal++) {
    if ((bits & (1 << signal)) && routed.has(signal)) record(signal)
  }
  // bit 0 marks real-time signals queued in the kernel
  if (signalWord || (bits & 1)) takeQueued()
}

/**
 * Takes this thread's real-time signals off the kernel's queue, which also clears its page and has the kernel look
 * again at the signal word. A page's bit 0 is cleared, unread, by a syscall it arrives during (which the dependency
 * delivers the standard signals of), so the queue is also looked at after a call that a signal interrupted
 */
function takeQueued() {
  const count = syscall_raw('proc_signal_poll')
  for (let i = 0; i < count; i++) record(returned[i])
}

/** The ignored signals and the mask as the kernel keeps them across an exec: sigsets of signals 1 to 31 */
function ignoredSet(reset = 0n) {
  let set = 0
  for (let signal = 1; signal <= KERNEL_SIGNALS; signal++) {
    if (actionOf(signal).handler === SIG_IGN && !(reset & bit(signal))) set |= 1 << (signal - 1)
  }
  return set
}
const kernelSet = sigset => Number(sigset & 0x7fffffffn)

/** What the process was started or exec'ed with: its ignored signals and its mask */
function inheritSignals() {
  const ignored = syscall_raw('proc_sigstate', 0)
  const blocked = syscall_raw('proc_sigstate', 1)
  for (let signal = 1; signal <= KERNEL_SIGNALS; signal++) {
    if (ignored > 0 && (ignored & (1 << (signal - 1)))) setAction(signal, { ...defaultAction, handler: SIG_IGN })
  }
  if (blocked > 0) mask = BigInt(blocked) & ~UNBLOCKABLE
  routeAll()
  published = `${ignoredSet()}:${kernelSet(mask)}`
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
    take(signal)
    const action = actionOf(signal)
    if (action.handler === SIG_IGN) continue
    if (action.handler === SIG_DFL) {
      if (DEFAULT_IGNORED.has(signal)) continue
      route(signal)
      syscall_raw(signal >= SIGRTMIN ? 'proc_kill' : 'kill', getpid(), signal)
      continue
    }
    handled++
    if (!(action.flags & SA_RESTART)) restart = false
    const saved = mask
    mask = (mask | action.mask | (action.flags & SA_NODEFER ? 0n : bit(signal))) & ~UNBLOCKABLE
    if (action.flags & SA_RESETHAND) setAction(signal, defaultAction)
    routeAll()
    const left = action.flags & SA_ONSTACK ? toAltStack() : undefined
    table.get(action.handler)(signal, siginfoFor(signal), 0)
    left?.()
    mask = saved
    routeAll()
  }
}

const SS_ONSTACK = 1, SS_DISABLE = 2, SS_AUTODISARM = 0x80000000, MINSIGSTKSZ = 2048
/**
 * This thread's alternate signal stack (`sigaltstack`), where a handler with `SA_ONSTACK` runs: its stack pointer is
 * moved to the top of it for the call, unless it is there already. A thread starts with none, as on Linux. A program
 * built before its stack pointer was exported runs such a handler where it is
 */
let altStack = { sp: 0, size: 0, flags: SS_DISABLE }
function onAltStack() {
  const sp = stackPointer ? stackPointer.value >>> 0 : 0
  return !!sp && altStack.flags !== SS_DISABLE && sp > altStack.sp && sp <= altStack.sp + altStack.size
}

/**
 * Moves the stack pointer to the alternate stack, if there is one to move to
 * @returns what puts it back when the handler returns (one that leaves by `siglongjmp` has its stack pointer restored
 * where it lands), with the stack itself, which `SS_AUTODISARM` took away for the handler
 */
function toAltStack() {
  if (!stackPointer || altStack.flags === SS_DISABLE || onAltStack()) return undefined
  const saved = stackPointer.value, stack = altStack
  stackPointer.value = (stack.sp + stack.size) & ~15
  if (stack.flags & SS_AUTODISARM) altStack = { sp: 0, size: 0, flags: SS_DISABLE }
  return () => {
    stackPointer.value = saved
    altStack = stack
  }
}

/**
 * `sigaltstack`: a `stack_t` is the stack's address, its flags and its size, a word each. The one in use cannot be
 * changed from a handler running on it
 */
function sigaltstack(ssPtr, oldPtr) {
  const dv = view(), previous = altStack, on = onAltStack()
  if (ssPtr) {
    const sp = dv.getUint32(ssPtr, true), flags = dv.getUint32(ssPtr + 4, true), size = dv.getUint32(ssPtr + 8, true)
    const mode = flags & ~SS_AUTODISARM
    if (mode !== 0 && mode !== SS_DISABLE && mode !== SS_ONSTACK) return -EINVAL
    if (on) return -EPERM
    if (mode === SS_DISABLE) altStack = { sp: 0, size: 0, flags: SS_DISABLE }
    else if (size < MINSIGSTKSZ) return -ENOMEM
    else altStack = { sp, size, flags: flags & SS_AUTODISARM }
  }
  if (oldPtr) {
    dv.setUint32(oldPtr, previous.sp, true)
    dv.setUint32(oldPtr + 4, (on ? SS_ONSTACK : 0) | previous.flags, true)
    dv.setUint32(oldPtr + 8, previous.size, true)
  }
  return 0
}

/** A signal this process sends itself: delivered before the call that sent it returns, as `raise` promises */
function raiseHere(signal) {
  if (!signal) return 0
  if (signal >= SIGRTMIN && !takesRealTime(signal)) return syscall_raw('proc_kill', getpid(), signal)
  if (signal < SIGRTMIN && !routed.has(signal)) return syscall_raw('kill', getpid(), signal)
  record(signal)
  return 0
}

/** Waits until a handler has run (`pause`, `sigsuspend`): a wait on nothing, which a raised signal ends with EINTR */
function waitForHandler() {
  for (;;) {
    collect()
    if (deliver().handled) return -EINTR
    if (syscall_raw('poll', [], -1) === -EINTR) takeQueued()
  }
}

/** Calls whose interruption is reported even when the handler asked for restarts, as Linux does for these */
const NEVER_RESTARTED = new Set(['SYS_poll', 'SYS_ppoll', 'SYS_select', 'SYS_pselect6', 'SYS_nanosleep', 'SYS_clock_nanosleep',
  'SYS_epoll_wait', 'SYS_epoll_pwait', 'SYS_rt_sigtimedwait', 'SYS_msgsnd', 'SYS_msgrcv', 'SYS_semop', 'SYS_semtimedop'])
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
      if (interrupted) takeQueued()
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

const WNOHANG = 1, WUNTRACED = 2
/** `struct rusage`: two timevals and fourteen longs, a long being 8 bytes here */
const RUSAGE_SIZE = 144

const spawnMemory = { view: () => view(), string: ptr => readString(ptr), strings: ptr => readStrings(ptr) }
const spawnSignals = { ignored: resets => ignoredSet(resets), mask: () => mask }

/** `posix_spawn` (`spawn.mjs`, shared with the Emscripten programs' host) */
const spawn = (...args) => spawnShared(spawnMemory, spawnSignals, isCloexec, ...args)

/** `wait4`: the kernel answers `pid * 65536 + status`, Linux's status word */
function wait4(pid, statusPtr, options, rusagePtr) {
  // a process group (0 for the caller's, -pgid for another) is waited for as any child
  const target = pid < -1 || pid === 0 ? -1 : pid
  const flags = options & (WNOHANG | WUNTRACED)
  let value = syscall_raw('proc_waitpid', target, flags)
  // the SIGCHLD raised as a child ends wakes the wait with EINTR; Linux returns that child, which is ready by then
  if (value === -EINTR && !(flags & WNOHANG)) {
    takeQueued()
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
  for (const fd of openDescriptors()) {
    if (!isCloexec(fd)) continue
    syscall_raw('close', fd)
    forget(fd)
  }
  syscall_raw('proc_set_sigstate', ignoredSet(), kernelSet(mask))
  return syscall_raw('execve', path, argv, env)
}

// --- time ---

const CLOCK_REALTIME = 0, CLOCK_REALTIME_COARSE = 5, CLOCK_REALTIME_ALARM = 8, CLOCK_TAI = 11
const TIMER_ABSTIME = 1

/**
 * The wall clock in milliseconds, finer than `Date.now()`'s whole ones: the monotonic clock's fraction, kept within the
 * millisecond `Date.now()` says it is (so it agrees with the kernel's times, and follows the wall clock when it is set
 * or the two drift apart), never going back while `Date.now()` does not. A program that times a wait by the wall clock
 * takes a millisecond's tick, which every reading would otherwise cross whole, as no time passing (Vim's `inchar_loop`
 * did, its wait falling to -1, forever)
 */
let realtimeOffset = performance.timeOrigin
function realtime() {
  const ms = Date.now(), time = realtimeOffset + performance.now()
  if (time >= ms && time < ms + 1) return time
  const kept = time < ms ? ms : ms + 0.999999
  realtimeOffset += kept - time
  return kept
}

/** A clock in milliseconds: the wall clock for the realtime ones, the page's monotonic clock for the rest */
const now = clock => (clock === CLOCK_REALTIME || clock === CLOCK_REALTIME_COARSE || clock === CLOCK_REALTIME_ALARM || clock === CLOCK_TAI)
  ? realtime()
  : performance.now()

const UTIME_NOW = 0x3fffffff, UTIME_OMIT = 0x3ffffffe

/**
 * `utimensat`, and `futimens`, which names no path and works on the open file (one that is unlinked too): the two
 * timespecs, either of which can be UTIME_NOW or UTIME_OMIT, become the kernel's `utimes` or `futimes` in seconds;
 * an omitted time is the file's own, from `stat`
 */
function utimensat(dirfd, pathPtr, timesPtr, flags) {
  const path = pathPtr ? resolveAt(dirfd, pathPtr, flags) : dirfd
  if (typeof path === 'number' && pathPtr) return path
  if (!pathPtr && syscall_raw('fstat', dirfd) < 0) return -EBADF
  const now = Date.now() / 1000
  const time = index => {
    if (!timesPtr) return now
    const dv = view(), at = timesPtr + index * 16, nsec = Number(dv.getBigInt64(at + 8, true))
    if (nsec === UTIME_NOW) return now
    if (nsec === UTIME_OMIT) return undefined
    if (nsec < 0 || nsec > 999999999) return null
    return Number(dv.getBigInt64(at, true)) + nsec / 1e9
  }
  let atime = time(0), mtime = time(1)
  if (atime === null || mtime === null) return -EINVAL
  if (atime === undefined || mtime === undefined) {
    const value = syscall_raw(pathPtr ? 'stat' : 'fstat', path)
    if (value < 0) return value
    const dv = new DataView(returned.buffer, returned.byteOffset)
    const statTime = at => Number(dv.getBigInt64(at, true)) + Number(dv.getBigInt64(at + 8, true)) / 1e9
    atime ??= statTime(72)
    mtime ??= statTime(88)
  }
  // `utimes` takes seconds; `futimes` sets the open file's times as they are kept, in milliseconds
  return pathPtr ? syscall_raw('utimes', path, atime, mtime) : syscall_raw('futimes', path, atime * 1000, mtime * 1000)
}

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
const SOCK_STREAM = 1, SOCK_DGRAM = 2, SOCK_TYPE_MASK = 0xf, SOCK_NONBLOCK = 0x800, SOCK_CLOEXEC = 0x80000
const MSG_PEEK = 0x2, MSG_TRUNC = 0x20, MSG_DONTWAIT = 0x40, MSG_WAITALL = 0x100
const SOL_SOCKET = 1, SO_TYPE = 3, SO_ERROR = 4, SO_SNDBUF = 7, SO_RCVBUF = 8, SO_PASSCRED = 16, SO_PEERCRED = 17, SO_ACCEPTCONN = 30, SO_PROTOCOL = 38, SO_DOMAIN = 39
const SCM_RIGHTS = 1, SCM_CREDENTIALS = 2, MSG_CTRUNC = 0x8, MSG_CMSG_CLOEXEC = 0x40000000
const IPPROTO_TCP = 6, IPPROTO_UDP = 17, IPPROTO_IPV6 = 41, IPV6_V6ONLY = 26
/** `struct msghdr` with a 64-bit `long`: name 0, namelen 4, iov 8, iovlen 12, control 20, controllen 24, flags 32 */
const MSG_NAMELEN = 4, MSG_IOV = 8, MSG_IOVLEN = 12, MSG_CONTROL = 20, MSG_CONTROLLEN = 24, MSG_FLAGS = 32
/** `struct cmsghdr`: len 0 (a `socklen_t` and padding), level 8, type 12, data 16; each is aligned to 4 */
const CMSG_HEADER = 16
const cmsgSpace = length => (CMSG_HEADER + length + 3) & ~3
/** `struct ucred`: pid, uid, gid */
const UCRED_SIZE = 12

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

/**
 * Writes an address as the family's `struct sockaddr`, as much as `*lengthPtr` has room for, and its full length there.
 * `raw` is the address's 16 bytes, as a datagram's sender comes (an IPv4 one mapped); without it, an IPv6 address
 * other than a mapped IPv4 one is `::1`, the only one a connection's peer here has.
 */
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
    if (address.raw) data.set(family === AF_INET ? address.raw.subarray(12) : address.raw, family === AF_INET ? 4 : 8)
    else if (family === AF_INET) data.set(v4 ? v4.slice(1).map(Number) : [127, 0, 0, 1], 4)
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
  // streams of every family, and UDP (the kernel's datagram sockets); Unix datagram sockets are not here yet
  const kind = type & SOCK_TYPE_MASK
  if (kind !== SOCK_STREAM && !(kind === SOCK_DGRAM && domain !== AF_UNIX)) return -ESOCKTNOSUPPORT
  const fd = syscall_raw('sock_open', type & SOCK_NONBLOCK, kind === SOCK_DGRAM ? 1 : 0)
  if (fd < 0) return fd
  opened(fd, O_RDWR | (type & SOCK_NONBLOCK), (type & SOCK_CLOEXEC) !== 0)
  if (withinLimit(fd) < 0) return -EMFILE
  remember(fd, { family: domain, type: kind })
  return fd
}

/** An IPv6 stream socket's `bind` and `connect` take a `sockaddr_in6`'s length whatever the family; Linux checks that first */
const shortForSix = (info, length) => info.family === AF_INET6 && info.type === SOCK_STREAM && length < 24

function bind(fd, ptr, length) {
  const info = socketInfo(fd)
  if (typeof info === 'number') return info
  if (shortForSix(info, length)) return -EINVAL
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
  if (withinLimit(made) < 0) return -EMFILE
  if (ptr) {
    const info = socketInfo(made)
    writeSockaddr(ptr, lengthPtr, info.family, info.peer)
  }
  return made
}

function connect(fd, ptr, length) {
  const info = socketInfo(fd)
  if (typeof info === 'number') return info
  if (shortForSix(info, length)) return -EINVAL
  const address = readSockaddr(ptr, length)
  if (typeof address === 'number') return address
  // a datagram socket's peer is where its sends go and the only one it hears; AF_UNSPEC undoes it
  if (info.type === SOCK_DGRAM && address.family === AF_UNSPEC) return syscall_raw('sock_peer', fd, '', 0)
  if (address.family !== info.family && !(info.family === AF_INET6 && address.family === AF_INET)) return -EAFNOSUPPORT
  if (info.type === SOCK_DGRAM) return syscall_raw('sock_peer', fd, address.addr, address.port)
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

/** `sendto` with an address: a datagram goes there; a stream has its peer already, and the address is not looked at */
function sendTo(fd, data, flags, addrPtr, addrLength) {
  if (!addrPtr) return sendBytes(fd, data, flags)
  const address = readSockaddr(addrPtr, addrLength)
  if (typeof address === 'number') return address
  if (address.family === AF_UNIX) return sendBytes(fd, data, flags)
  return syscall_raw('sock_sendto', fd, data, address.family, address.addr ?? '', address.port ?? 0, flags & MSG_DONTWAIT)
}

/** What the kernel puts before what `sock_recvfrom` received (`main-thread-syscalls.ts`) */
const RECVFROM_HEADER = 24

/**
 * `recvfrom` into one buffer with room for the sender (`addrPtr`, `*lengthPtr` long). A datagram socket's next datagram
 * comes with who sent it; a stream's peer is fixed, so it gets no address. @returns `{ count, full }`, `full` being a
 * datagram's whole length (more than `count` when it was cut), or a negative errno
 */
function receiveFrom(fd, ptr, length, flags, addrPtr, lengthPtr) {
  const value = syscall_raw('sock_recvfrom', fd, length, flags & (MSG_PEEK | MSG_DONTWAIT))
  if (value < 0) return value
  const answer = new DataView(returned.buffer, returned.byteOffset)
  const count = value - RECVFROM_HEADER
  bytes().set(returned.subarray(RECVFROM_HEADER, value), ptr)
  if (!returned[6]) {
    if (lengthPtr) view().setUint32(lengthPtr, 0, true)
    if ((flags & MSG_WAITALL) && count && count < length) {
      const more = receiveInto(fd, ptr + count, length - count, flags)
      return { count: more < 0 ? count : count + more, full: 0 }
    }
    return { count, full: count }
  }
  const raw = returned.slice(8, 24)
  writeSockaddr(addrPtr, lengthPtr, returned[7], { addr: ipv6Text(raw, 0), raw, port: answer.getUint16(4, false) })
  return { count, full: answer.getUint32(0, true) }
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

/**
 * The descriptors an outgoing control buffer passes (`SCM_RIGHTS`), or a negative errno. `SCM_CREDENTIALS` is taken
 * and not needed: the receiver is given the sender's own, which is all Linux lets an unprivileged sender claim.
 */
function rightsOf(controlPtr, controlLength) {
  const dv = view()
  const fds = []
  for (let at = controlPtr; at + CMSG_HEADER <= controlPtr + controlLength;) {
    const length = dv.getUint32(at, true)
    if (length < CMSG_HEADER || at + length > controlPtr + controlLength) return -EINVAL
    const level = dv.getInt32(at + 8, true), type = dv.getInt32(at + 12, true)
    if (level !== SOL_SOCKET || (type !== SCM_RIGHTS && type !== SCM_CREDENTIALS)) return -EINVAL
    if (type === SCM_RIGHTS) for (let p = at + CMSG_HEADER; p + 4 <= at + length; p += 4) fds.push(dv.getInt32(p, true))
    at += (length + 3) & ~3
  }
  return fds
}

function sendmsg(fd, msgPtr, flags) {
  const controlLength = view().getUint32(msgPtr + MSG_CONTROLLEN, true)
  const fds = controlLength ? rightsOf(view().getUint32(msgPtr + MSG_CONTROL, true), controlLength) : []
  if (typeof fds === 'number') return fds
  const parts = iovecs(msgPtr).map(([ptr, length]) => bytes().slice(ptr, ptr + length))
  const data = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
  let at = 0
  for (const part of parts) { data.set(part, at); at += part.byteLength }
  // descriptors go with the bytes, on a local stream only (the kernel says EINVAL for any other socket)
  if (fds.length) return syscall_raw('sock_sendmsg', fd, data, JSON.stringify(fds), flags & MSG_DONTWAIT)
  return sendTo(fd, data, flags, view().getUint32(msgPtr, true), view().getUint32(msgPtr + MSG_NAMELEN, true))
}

/** What the kernel puts before the data `sock_recvmsg` received: the count of descriptors, flags (1 some were cut, 2 credentials follow), pid, uid and gid, then the descriptors */
const RIGHTS_HEADER = 20

/**
 * `recvmsg` with a control buffer on a local stream: the descriptors that came with the bytes are put in this
 * process's table and named in an `SCM_RIGHTS` message, after an `SCM_CREDENTIALS` one when `SO_PASSCRED` is on (the
 * order Linux writes them in). What does not fit is cut, and `MSG_CTRUNC` says so.
 */
function recvmsgRights(fd, msgPtr, flags, controlPtr, controlLength, info) {
  const buffers = iovecs(msgPtr)
  const total = buffers.reduce((sum, [, length]) => sum + length, 0)
  const credentialSpace = info.passcred ? cmsgSpace(UCRED_SIZE) : 0
  const room = Math.max(0, Math.floor((controlLength - credentialSpace - CMSG_HEADER) / 4))
  const value = syscall_raw('sock_recvmsg', fd, total, flags & (MSG_PEEK | MSG_DONTWAIT), room)
  if (value < 0) return value
  const answer = new DataView(returned.buffer, returned.byteOffset)
  const given = answer.getUint32(0, true), got = answer.getUint32(4, true)
  const dataAt = RIGHTS_HEADER + 4 * given
  let at = dataAt
  for (const [ptr, length] of buffers) {
    const part = Math.min(length, value - at)
    if (part <= 0) break
    bytes().set(returned.subarray(at, at + part), ptr)
    at += part
  }
  const dv = view()
  let used = 0, msgFlags = got & 1 ? MSG_CTRUNC : 0
  const cmsg = (type, length) => {
    dv.setUint32(controlPtr + used, CMSG_HEADER + length, true)
    dv.setUint32(controlPtr + used + 4, 0, true)
    dv.setInt32(controlPtr + used + 8, SOL_SOCKET, true)
    dv.setInt32(controlPtr + used + 12, type, true)
    const data = controlPtr + used + CMSG_HEADER
    used += cmsgSpace(length)
    return data
  }
  if (got & 2) {
    if (controlLength - used >= CMSG_HEADER + UCRED_SIZE) {
      const data = cmsg(SCM_CREDENTIALS, UCRED_SIZE)
      for (let i = 0; i < 3; i++) dv.setInt32(data + i * 4, answer.getInt32(8 + i * 4, true), true)
    } else msgFlags |= MSG_CTRUNC
  }
  if (given) {
    const data = cmsg(SCM_RIGHTS, 4 * given)
    for (let i = 0; i < given; i++) {
      const received = answer.getInt32(RIGHTS_HEADER + 4 * i, true)
      opened(received, 0, (flags & MSG_CMSG_CLOEXEC) !== 0)
      dv.setInt32(data + 4 * i, received, true)
    }
  }
  dv.setUint32(msgPtr + MSG_NAMELEN, 0, true)
  dv.setUint32(msgPtr + MSG_CONTROLLEN, Math.min(used, controlLength), true)
  dv.setInt32(msgPtr + MSG_FLAGS, msgFlags, true)
  return value - dataAt
}

function recvmsg(fd, msgPtr, flags) {
  const controlPtr = view().getUint32(msgPtr + MSG_CONTROL, true), controlLength = view().getUint32(msgPtr + MSG_CONTROLLEN, true)
  // only a local stream carries descriptors and credentials; any other socket's control buffer comes back empty
  if (controlPtr && controlLength) {
    const info = socketInfo(fd)
    if (typeof info === 'number') return info
    if (info.family === AF_UNIX && info.type === SOCK_STREAM) return recvmsgRights(fd, msgPtr, flags, controlPtr, controlLength, info)
  }
  const buffers = iovecs(msgPtr)
  const total = buffers.reduce((sum, [, length]) => sum + length, 0)
  const scratch = allocate(roundUp(Math.max(total, 1), PAGE))
  if (scratch < 0) return scratch
  try {
    // the sender's name and a cut datagram (MSG_TRUNC) need the kernel's recvfrom; a plain read does not
    const namePtr = view().getUint32(msgPtr, true)
    let count, full
    if (namePtr || (flags & MSG_TRUNC)) {
      const got = receiveFrom(fd, scratch, total, flags, namePtr, namePtr ? msgPtr + MSG_NAMELEN : 0)
      if (typeof got === 'number') return got
      count = got.count
      full = got.full
    } else {
      count = receiveInto(fd, scratch, total, flags)
      if (count < 0) return count
      full = count
    }
    let at = 0
    for (const [ptr, length] of buffers) {
      const part = Math.min(length, count - at)
      if (part <= 0) break
      bytes().copyWithin(ptr, scratch + at, scratch + at + part)
      at += part
    }
    const dv = view()
    if (!namePtr) dv.setUint32(msgPtr + MSG_NAMELEN, 0, true)
    dv.setUint32(msgPtr + MSG_CONTROLLEN, 0, true)
    dv.setInt32(msgPtr + MSG_FLAGS, full > count ? MSG_TRUNC : 0, true)
    return flags & MSG_TRUNC ? full : count
  } finally {
    release(scratch, roundUp(Math.max(total, 1), PAGE))
  }
}

function getsockopt(fd, level, name, valuePtr, lengthPtr) {
  const info = socketInfo(fd)
  if (typeof info === 'number') return info
  // the program at the other end of a local connection, as `struct ucred`
  if (level === SOL_SOCKET && name === SO_PEERCRED) {
    const cred = info.peercred ?? { pid: 0, uid: -1, gid: -1 }
    if (!valuePtr || !lengthPtr || view().getUint32(lengthPtr, true) < UCRED_SIZE) return -EINVAL
    ;[cred.pid, cred.uid, cred.gid].forEach((part, i) => view().setInt32(valuePtr + i * 4, part, true))
    view().setUint32(lengthPtr, UCRED_SIZE, true)
    return 0
  }
  let value
  if (level === SOL_SOCKET) {
    value = { [SO_TYPE]: info.type, [SO_PASSCRED]: info.passcred ? 1 : 0, [SO_ERROR]: 0, [SO_DOMAIN]: info.family, [SO_ACCEPTCONN]: info.listening ? 1 : 0,
      [SO_PROTOCOL]: info.family === AF_UNIX ? 0 : info.type === SOCK_DGRAM ? IPPROTO_UDP : IPPROTO_TCP, [SO_SNDBUF]: 65536, [SO_RCVBUF]: 65536 }[name] ?? 0
  } else if (level === IPPROTO_IPV6 && name === IPV6_V6ONLY) value = info.v6only ? 1 : 0
  else if (level === IPPROTO_TCP) value = 0
  else return -ENOPROTOOPT
  if (valuePtr && lengthPtr && view().getUint32(lengthPtr, true) >= 4) {
    view().setInt32(valuePtr, value, true)
    view().setUint32(lengthPtr, 4, true)
  }
  return 0
}

/** Options are taken and kept where they mean something here (`IPV6_V6ONLY`, `SO_PASSCRED`); the rest change nothing on a loopback stream */
function setsockopt(fd, level, name, valuePtr, length) {
  const info = socketInfo(fd)
  if (typeof info === 'number') return info
  if (level === IPPROTO_IPV6 && name === IPV6_V6ONLY && valuePtr && length >= 4) remember(fd, { v6only: view().getInt32(valuePtr, true) !== 0 })
  if (level === SOL_SOCKET && name === SO_PASSCRED && valuePtr && length >= 4) remember(fd, { passcred: view().getInt32(valuePtr, true) !== 0 })
  return 0
}

function socketpair(domain, type, svPtr) {
  if (domain !== AF_UNIX) return -EOPNOTSUPP
  if ((type & SOCK_TYPE_MASK) !== SOCK_STREAM) return -ESOCKTNOSUPPORT
  const value = syscall_raw('sock_pair', type & SOCK_NONBLOCK)
  if (value < 0) return value
  const answer = new DataView(returned.buffer, returned.byteOffset)
  const pair = [answer.getInt32(0, true), answer.getInt32(4, true)]
  if (withinLimit(...pair) < 0) return -EMFILE
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
  if (withinLimit(fd) < 0) return -EMFILE
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
  const entries = [...interest].filter(([fd]) => syscall_raw('fstat', fd) >= 0 || !interest.delete(fd))
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

// --- System V IPC ---

/**
 * Message queues, semaphore sets and shared memory segments are the kernel's (`tree/lib/sysv-ipc.ts`); here their C
 * structures are read and laid out. A segment is attached by mapping the descriptor the kernel opens for it shared, as a
 * file is (see above), so another process's changes come in at the calls a program synchronizes with (a semaphore, a
 * message, a futex, a read) and its own go out before them. It is placed where the allocator has room: `shmat` at an
 * address of the program's choosing is not there, as `MAP_FIXED` is not.
 */
const IPC_64 = 0x100
const IPC_SET = 1, IPC_INFO = 3, SHM_INFO = 14, GETALL = 13, SETALL = 17
const SHM_RDONLY = 0o10000
const PROT_READ = 1
/** Each `*_STAT` structure: its size, and after its `struct ipc_perm` (48 bytes) each field's offset and width */
const IPC_STAT_LAYOUT = {
  msg: [120, { stime: [48, 8], rtime: [56, 8], ctime: [64, 8], cbytes: [72, 8], qnum: [80, 8], qbytes: [88, 8], lspid: [96, 4], lrpid: [100, 4] }],
  sem: [88, { otime: [48, 8], ctime: [56, 8], nsems: [64, 2] }],
  shm: [112, { segsz: [48, 4], atime: [56, 8], dtime: [64, 8], ctime: [72, 8], cpid: [80, 4], lpid: [84, 4], nattch: [88, 8] }]
}
const ints = names => Object.fromEntries(names.map((name, i) => [name, [i * 4, 4]]))
/** `struct msginfo` and `struct seminfo` are ints; `struct shminfo` is longs, and `struct shm_info` longs after an int */
const IPC_INFO_LAYOUT = {
  msg: [32, ints(['msgpool', 'msgmap', 'msgmax', 'msgmnb', 'msgmni', 'msgssz', 'msgtql', 'msgseg'])],
  sem: [40, ints(['semmap', 'semmni', 'semmns', 'semmnu', 'semmsl', 'semopm', 'semume', 'semusz', 'semvmx', 'semaem'])],
  shm: [72, { shmmax: [0, 8], shmmin: [8, 8], shmmni: [16, 8], shmseg: [24, 8], shmall: [32, 8] }],
  shmUsage: [48, { used_ids: [0, 4], shm_tot: [8, 8], shm_rss: [16, 8], shm_swp: [24, 8], swap_attempts: [32, 8], swap_successes: [40, 8] }]
}
/** Each attached segment's address, and its size */
const attachments = new Map()

/** Lays out what the kernel answered (JSON in the region) as a C structure at `ptr` */
function layOut(ptr, [size, fields], answer) {
  bytes().fill(0, ptr, ptr + size)
  const dv = view()
  if (answer.perm) {
    const { key, uid, gid, cuid, cgid, mode, seq } = answer.perm
    dv.setInt32(ptr, key, true)
    for (const [at, value] of [[4, uid], [8, gid], [12, cuid], [16, cgid], [20, mode], [24, seq]]) dv.setUint32(ptr + at, value, true)
  }
  for (const [name, [at, width]] of Object.entries(fields)) {
    const value = answer[name] ?? 0
    if (width === 8) dv.setBigInt64(ptr + at, BigInt(value), true)
    else if (width === 4) dv.setInt32(ptr + at, value, true)
    else dv.setUint16(ptr + at, value, true)
  }
}

const ipcAnswer = () => JSON.parse(decoder.decode(returned.slice()))

/** `msgctl`, `semctl` and `shmctl`; `arg` is semctl's fourth argument (a value or a pointer) or the others' buffer */
function ipcControl(kind, id, cmd, arg, num = 0) {
  cmd &= ~IPC_64
  const dv = view()
  let given = kind === 'sem' ? [num, arg] : undefined
  if (cmd === IPC_SET) {
    given = { uid: dv.getUint32(arg + 4, true), gid: dv.getUint32(arg + 8, true), mode: dv.getUint32(arg + 20, true) }
    if (kind === 'msg') given.qbytes = Number(dv.getBigUint64(arg + 88, true))
  } else if (kind === 'sem' && cmd === SETALL) {
    const count = syscall_raw('sem_count', id)
    if (count < 0) return count
    given = Array.from({ length: count }, (_, i) => dv.getUint16(arg + i * 2, true))
  }
  const result = syscall_raw('ipc_ctl', kind, id, cmd, given)
  if (result < 0 || !returned.byteLength) return result
  const answer = ipcAnswer()
  if (kind === 'sem' && cmd === GETALL) answer.forEach((value, i) => view().setUint16(arg + i * 2, value, true))
  else if (cmd === IPC_INFO || answer.perm === undefined) layOut(arg, IPC_INFO_LAYOUT[kind === 'shm' && cmd === SHM_INFO ? 'shmUsage' : kind], answer)
  else layOut(arg, IPC_STAT_LAYOUT[kind], answer)
  return result
}

/** `msgrcv`: the message's type (a `long`) and text go to `struct msgbuf` */
function msgReceive(id, ptr, size, type, flags) {
  const length = syscall_raw('msg_receive', id, size, Number(type), flags)
  if (length < 0) return length
  bytes().set(returned.subarray(0, 8 + length), ptr)
  return length
}

/** `semop` and `semtimedop`: `struct sembuf` is a semaphore's number, the change and the flags, two bytes each */
function semop(id, ptr, count, timeoutPtr) {
  const dv = view(), ops = []
  for (let i = 0; i < count; i++) ops.push(dv.getUint16(ptr + i * 6, true), dv.getInt16(ptr + i * 6 + 2, true), dv.getUint16(ptr + i * 6 + 4, true))
  let timeout = -1
  if (timeoutPtr) {
    const nanoseconds = Number(dv.getBigInt64(timeoutPtr + 8, true))
    timeout = readTimespec(timeoutPtr)
    if (timeout < 0 || nanoseconds < 0 || nanoseconds >= 1e9) return -EINVAL
  }
  return syscall_raw('sem_op', id, ops, timeout)
}

/** `shmat`: the segment's descriptor, mapped shared and then closed (the mapping keeps its own) */
function shmat(id, addr, flags) {
  if (addr) return -EINVAL
  const fd = syscall_raw('shm_attach', id, flags)
  if (fd < 0) return fd
  syscall_raw('fstat', fd)
  const size = Number(new DataView(returned.buffer, returned.byteOffset).getBigInt64(48, true))
  const at = mmap(0, size, PROT_READ | (flags & SHM_RDONLY ? 0 : PROT_WRITE), MAP_SHARED, fd, 0)
  syscall_raw('close', fd)
  if (at >= 0) attachments.set(at, size)
  return at
}

function shmdt(addr) {
  const size = attachments.get(addr)
  if (size === undefined) return -EINVAL
  return munmap(addr, size)
}

// --- threads ---

const FUTEX_WAIT = 0, FUTEX_WAKE = 1, FUTEX_REQUEUE = 3, FUTEX_CMP_REQUEUE = 4, FUTEX_LOCK_PI = 6, FUTEX_UNLOCK_PI = 7, FUTEX_TRYLOCK_PI = 8
const FUTEX_WAIT_BITSET = 9, FUTEX_WAKE_BITSET = 10, FUTEX_PRIVATE = 128, FUTEX_CLOCK_REALTIME = 256
/** A lock's word under the priority-inheritance and robust protocols: its owner's thread id, and these */
const FUTEX_WAITERS = 0x80000000 | 0, FUTEX_OWNER_DIED = 0x40000000, FUTEX_TID_MASK = 0x3fffffff
const EAGAIN = 11, EDEADLK = 35, ETIMEDOUT = 110

/**
 * After a call that ends this thread: the kernel is stopping its worker, and the program must not run on meanwhile
 * (code after a call that does not return is unreachable)
 */
function ended() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
}

/**
 * `pthread_create`: the kernel starts a thread of this process (`proc_thread`), a worker with its own instance of the
 * program on this memory, which runs `__wasm_thread_start_libc` with `arg`. @returns its thread id
 */
function spawnThread(arg) {
  return syscall_raw('proc_thread', init.exe, init.interpreter, memory, state.buffer, arg)
}

/**
 * A futex, on the memory every thread shares. A wait goes in slices so a signal for this thread ends it with EINTR, as on
 * Linux; a timeout is relative for `FUTEX_WAIT` and a point on the clock for `FUTEX_WAIT_BITSET`. A waiter cannot be
 * moved to another address, so a requeue (which musl's condition variables hand their waiters to the mutex with) wakes
 * every waiter instead: a futex's users take a wakeup as a reason to look again, never as a promise.
 */
function futex(ptr, op, value, timeoutPtr, _ptr2, value3) {
  const cmd = op & ~(FUTEX_PRIVATE | FUTEX_CLOCK_REALTIME)
  const words = new Int32Array(memory.buffer)
  const bucket = (ptr >>> 2) % FUTEX_BUCKETS
  if (cmd === FUTEX_WAKE || cmd === FUTEX_WAKE_BITSET) return Math.min(wakeAll(ptr), value)
  if (cmd === FUTEX_REQUEUE || cmd === FUTEX_CMP_REQUEUE) {
    if (cmd === FUTEX_CMP_REQUEUE && Atomics.load(words, ptr >> 2) !== value3) return -EAGAIN
    return wakeAll(ptr)
  }
  // a priority-inheritance lock's timeout is always a point on the realtime clock
  if (cmd === FUTEX_LOCK_PI || cmd === FUTEX_TRYLOCK_PI)
    return lockPi(ptr, cmd === FUTEX_TRYLOCK_PI, timeoutPtr ? performance.now() + readTimespec(timeoutPtr) - now(CLOCK_REALTIME) : Infinity)
  if (cmd === FUTEX_UNLOCK_PI) return unlockPi(ptr)
  if (cmd !== FUTEX_WAIT && cmd !== FUTEX_WAIT_BITSET) return -ENOSYS
  let deadline = Infinity
  if (timeoutPtr) {
    const time = readTimespec(timeoutPtr)
    deadline = performance.now() + (cmd === FUTEX_WAIT ? time : time - now(op & FUTEX_CLOCK_REALTIME ? CLOCK_REALTIME : 1))
  }
  // As Linux does, the word is compared once, on the way in; after that only a wake (or a signal, or the time) ends
  // the wait, whatever the word becomes. The counter is read before the comparison, so a wake that follows the
  // comparison has moved it and is not missed.
  const seen = Atomics.load(state.wakes, bucket)
  if (Atomics.load(words, ptr >> 2) !== value) return -EAGAIN
  for (;;) {
    const left = deadline - performance.now()
    if (left <= 0) return -ETIMEDOUT
    if (Atomics.wait(state.wakes, bucket, seen, Math.min(left, 50)) !== 'timed-out') return 0
    collect()
    if (raised & ~mask) return -EINTR
  }
}

/**
 * A wake counts on the address's bucket and wakes every thread waiting there; each checks its own word again, as after
 * any wake (a requeue wakes them all too). @returns how many it woke
 */
function wakeAll(ptr) {
  const bucket = (ptr >>> 2) % FUTEX_BUCKETS
  Atomics.add(state.wakes, bucket, 1)
  return Atomics.notify(state.wakes, bucket)
}

/** Whether the thread `tid` (of any process: a process-shared lock's owner may be another's) has ended */
const threadEnded = tid => syscall_raw('proc_kill', tid, 0) === -ESRCH

/**
 * `FUTEX_LOCK_PI` and `FUTEX_TRYLOCK_PI`. There are no priorities here to lend an owner, so what is left is the
 * protocol: the lock is the caller's when its word has no owner, or when its owner has ended (marked
 * `FUTEX_OWNER_DIED`, as Linux hands a dead owner's lock on); else the caller marks it `FUTEX_WAITERS`, so the owner's
 * unlock comes here, and waits. Where Linux would hand the lock to one waiter, the unlock frees it and wakes them all to
 * take it; one that has waited keeps `FUTEX_WAITERS` on it as it does, for any other. An owner that ends without
 * unlocking wakes nobody, so a wait looks at whether it lives in slices.
 */
function lockPi(ptr, trying, deadline) {
  const words = new Int32Array(memory.buffer), at = ptr >> 2, tid = getpid()
  const bucket = (ptr >>> 2) % FUTEX_BUCKETS
  let waited = false, look = false
  for (;;) {
    const seen = Atomics.load(state.wakes, bucket)
    const word = Atomics.load(words, at), owner = word & FUTEX_TID_MASK
    if (owner === tid) return -EDEADLK
    const gone = owner && look && threadEnded(owner)
    look = false
    if (!owner || gone) {
      const taken = tid | (gone ? FUTEX_OWNER_DIED : word & FUTEX_OWNER_DIED) | (waited ? FUTEX_WAITERS : 0)
      if (Atomics.compareExchange(words, at, word, taken) === word) return 0
      continue
    }
    if (trying) return -EAGAIN
    if (!(word & FUTEX_WAITERS) && Atomics.compareExchange(words, at, word, word | FUTEX_WAITERS) !== word) continue
    waited = true
    const left = deadline - performance.now()
    if (left <= 0) return -ETIMEDOUT
    if (Atomics.wait(state.wakes, bucket, seen, Math.min(left, 50)) === 'timed-out') {
      collect()
      if (raised & ~mask) return -EINTR
      look = true
    }
  }
}

/** `FUTEX_UNLOCK_PI`: frees a lock the caller owns, and wakes its waiters to take it */
function unlockPi(ptr) {
  const words = new Int32Array(memory.buffer), at = ptr >> 2, tid = getpid()
  for (let word = Atomics.load(words, at); ;) {
    if ((word & FUTEX_TID_MASK) !== tid) return -EPERM
    const was = Atomics.compareExchange(words, at, word, 0)
    if (was === word) break
    word = was
  }
  wakeAll(ptr)
  return 0
}

/**
 * The thread's robust list (`set_robust_list`): `struct robust_list_head`, whose `head` is a list of the robust locks
 * it holds, each entry `off` bytes from its lock's word, and `pending` one it is taking or letting go of. musl's
 * `pthread_exit` gives up what is on it itself; a thread that ends another way has it given up here, as Linux does.
 * On this target the structure is a pointer, a `long` and a pointer: `head` at 0, `off` at 8, `pending` at 16.
 */
let robustList = 0
const ROBUST_LIST_SIZE = 24, ROBUST_LIST_LIMIT = 2048

/** A dead thread's robust locks: each it owned is marked `FUTEX_OWNER_DIED`, and a waiter woken to take it */
function releaseRobust() {
  if (!robustList) return
  const dv = view(), tid = getpid(), words = new Int32Array(memory.buffer)
  const off = Number(dv.getBigInt64(robustList + 8, true))
  const release = entry => {
    const at = ((entry & ~1) + off) >> 2
    for (let word = Atomics.load(words, at); (word & FUTEX_TID_MASK) === tid;) {
      const was = Atomics.compareExchange(words, at, word, (word & FUTEX_WAITERS) | FUTEX_OWNER_DIED)
      if (was !== word) {
        word = was
        continue
      }
      if (word & FUTEX_WAITERS) wakeAll((entry & ~1) + off)
      break
    }
  }
  const pending = dv.getUint32(robustList + 16, true)
  for (let entry = dv.getUint32(robustList, true), count = 0; entry !== robustList && entry && count < ROBUST_LIST_LIMIT; count++) {
    const next = dv.getUint32(entry & ~1, true)
    if (entry !== pending) release(entry)
    entry = next
  }
  if (pending) release(pending)
  robustList = 0
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

  SYS_open: (path, flags, mode) => big(withinLimit(opened(syscall_raw('open', readString(path), flags, mode), flags))),
  SYS_openat: (dirfd, path, flags, mode) => at(dirfd, path, resolved => withinLimit(opened(syscall_raw('open', resolved, flags, mode), flags))),
  SYS_memfd_create: (_name, flags) => big(memfdCreate(num(flags))),
  SYS_fallocate: (fd, mode, offset, length) => big(fallocate(fd, num(mode), num(offset), num(length))),
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
  SYS_dup: fd => big(withinLimit(opened(syscall_raw('dup', fd), 0, false))),
  SYS_dup2: (from, to) => {
    if (to >= descriptorLimit()) return big(-EBADF)
    if (from === to) return big(syscall_raw('fstat', from) < 0 ? -EBADF : to)
    const value = syscall_raw('dup2', from, to)
    return big(value < 0 ? value : opened(value, 0, false))
  },
  SYS_dup3: (from, to, flags) => {
    if (from === to || (flags & ~O_CLOEXEC)) return big(-EINVAL)
    if (to >= descriptorLimit()) return big(-EBADF)
    const value = syscall_raw('dup2', from, to)
    return big(value < 0 ? value : opened(value, 0, (flags & O_CLOEXEC) !== 0))
  },
  // musl reads the argument as an `unsigned long`, 8 bytes here, where the caller passed an int or a pointer (4 bytes):
  // the upper half is whatever lies beyond it on the stack, and every fcntl argument fits in the lower
  SYS_fcntl: (fd, cmd, arg) => big(fcntl(fd, cmd, Number(BigInt.asUintN(32, BigInt(arg))))),
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
    const device = deviceIoctl(fd, request >>> 0, ptr)
    if (device !== undefined) return big(device)
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
  SYS_utimensat: (dirfd, path, times, flags) => big(utimensat(dirfd, path, times, flags)),
  SYS_prlimit64: (pid, resource, newPtr, oldPtr) => big(prlimit(pid, resource, newPtr, oldPtr)),
  SYS_getrlimit: (resource, ptr) => big(prlimit(0, resource, 0, ptr)),
  SYS_setrlimit: (resource, ptr) => big(prlimit(0, resource, ptr, 0)),
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
  // fork is `forkCall`, for a program built with Asyncify; any other has none, and posix_spawn (and system and popen,
  // which use it) start programs
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
      setAction(signal, next)
      if (next.handler === SIG_IGN) drop(signal)
      route(signal)
      publish()
    }
    return 0n
  },
  SYS_sigaltstack: (ssPtr, oldPtr) => big(sigaltstack(ssPtr, oldPtr)),
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
      publish()
    }
    if (oldPtr) view().setBigUint64(oldPtr, previous, true)
    return 0n
  },
  // what the program's loops call when the kernel set the process's signal word (utils/wali/signal-checks.mjs), so a
  // program off computing still gets its signals: they are delivered as this returns, as for any import. The kernel
  // clears the word in the call once no thread has signals waiting, and holds the call while the process is stopped,
  // which it waits out here
  __ecmaos_poll: () => {
    collect()
    takeQueued()
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
  // `sigqueue`: the signal is sent; the value with it does not go along
  SYS_rt_sigqueueinfo: (pid, signal) => calls.SYS_kill(pid, signal),
  SYS_rt_tgsigqueueinfo: (tgid, tid, signal) => calls.SYS_tgkill(tgid, tid, signal),
  // `sigwaitinfo` and `sigtimedwait`: takes one of the set's signals from those raised, waiting for one (the set is
  // blocked, so the kernel hands them over rather than acting on them); a signal with a handler ends the wait (EINTR)
  SYS_rt_sigtimedwait: (setPtr, infoPtr, timeoutPtr) => {
    const set = view().getBigUint64(setPtr, true) & ~UNBLOCKABLE
    const deadline = timeoutPtr ? performance.now() + readTimespec(timeoutPtr) : Infinity
    for (;;) {
      collect()
      const ready = raised & set
      if (ready) {
        let signal = 1
        while (!(ready & bit(signal))) signal++
        take(signal)
        if (infoPtr) {
          bytes().fill(0, infoPtr, infoPtr + 128)
          view().setInt32(infoPtr, signal, true)
        }
        return big(signal)
      }
      if (raised & ~mask) return big(-EINTR)
      const left = deadline - performance.now()
      if (left <= 0) return big(-EAGAIN)
      if (syscall_raw('poll', [], left === Infinity ? -1 : Math.ceil(left)) === -EINTR) takeQueued()
    }
  },

  SYS_clock_gettime: (clock, ptr) => {
    if (ptr) writeTimespec(ptr, now(clock))
    return 0n
  },
  SYS_gettimeofday: ptr => {
    if (ptr) {
      const time = realtime(), seconds = Math.floor(time / 1000), dv = view()
      dv.setBigInt64(ptr, BigInt(seconds), true)
      dv.setBigInt64(ptr + 8, BigInt(Math.floor((time - seconds * 1000) * 1000)), true)
    }
    return 0n
  },
  // a microsecond: the clocks are read finer than a millisecond, though a browser rounds them to a few microseconds
  SYS_clock_getres: (_clock, ptr) => {
    if (ptr) writeTimespec(ptr, 0.001)
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
  SYS_sendto: (fd, ptr, length, flags, addrPtr, addrLength) => big(sendTo(fd, bytes().slice(ptr, ptr + length), flags, addrPtr, addrLength)),
  // the kernel's recvfrom only when there is a sender to name or a datagram's full length to tell
  SYS_recvfrom: (fd, ptr, length, flags, addrPtr, lengthPtr) => {
    if (!addrPtr && !(flags & MSG_TRUNC)) return big(receiveInto(fd, ptr, length, flags))
    const got = receiveFrom(fd, ptr, length, flags, addrPtr, lengthPtr)
    return big(typeof got === 'number' ? got : flags & MSG_TRUNC ? got.full : got.count)
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

  __wasm_thread_spawn: (_start, arg) => spawnThread(arg),
  // a detached thread's end: its stack goes back to the allocator, and the thread ends without running on it again
  __ecmaos_unmapself: (base, size) => {
    release(base, roundUp(size, PAGE))
    ended(syscall_raw('exit', 0))
  },
  SYS_getpid: () => big(thread ? thread.tgid : getpid()),
  SYS_gettid: () => big(getpid()),
  SYS_futex: (ptr, op, value, timeout, ptr2, value3) => big(futex(ptr, op, value, timeout, ptr2, value3)),
  SYS_set_robust_list: (head, length) => {
    if (length !== ROBUST_LIST_SIZE) return big(-EINVAL)
    robustList = head
    return 0n
  },
  // another thread's list is in its own half of the host, out of this one's reach
  SYS_get_robust_list: (tid, headPtr, lengthPtr) => {
    if (tid && tid !== getpid()) return big(-EPERM)
    view().setUint32(headPtr, robustList, true)
    view().setUint32(lengthPtr, ROBUST_LIST_SIZE, true)
    return 0n
  },

  SYS_msgget: (key, flags) => big(syscall_raw('ipc_get', 'msg', key, 0, flags)),
  SYS_msgsnd: (id, ptr, size, flags) => big(syscall_raw('msg_send', id, Number(view().getBigInt64(ptr, true)), bytes().slice(ptr + 8, ptr + 8 + size), flags)),
  SYS_msgrcv: (id, ptr, size, type, flags) => big(msgReceive(id, ptr, size, type, flags)),
  SYS_msgctl: (id, cmd, ptr) => big(ipcControl('msg', id, cmd, ptr)),
  SYS_semget: (key, count, flags) => big(syscall_raw('ipc_get', 'sem', key, count, flags)),
  SYS_semop: (id, ptr, count) => big(semop(id, ptr, count, 0)),
  SYS_semtimedop: (id, ptr, count, timeoutPtr) => big(semop(id, ptr, count, timeoutPtr)),
  SYS_semctl: (id, num, cmd, arg) => big(ipcControl('sem', id, cmd, arg, num)),
  SYS_shmget: (key, size, flags) => big(syscall_raw('ipc_get', 'shm', key, size, flags)),
  SYS_shmat: (id, addr, flags) => big(shmat(id, addr, flags)),
  SYS_shmdt: addr => big(shmdt(addr)),
  SYS_shmctl: (id, cmd, ptr) => big(ipcControl('shm', id, cmd, ptr)),

  SYS_mmap: (addr, length, prot, flags, fd, offset) => big(mmap(addr, length, prot, flags, fd, num(offset))),
  SYS_munmap: (addr, length) => big(munmap(addr, length)),
  SYS_msync: (addr, length, flags) => big(msync(addr, length, flags)),
  SYS_mremap: (addr, oldLength, newLength, flags) => big(mremap(addr, oldLength, newLength, flags)),
  SYS_mprotect: (addr, length, prot) => big(mprotect(addr, length, prot)),
  SYS_madvise: () => 0n
}

/** Adds ecmaOS's calls to the dependency's table, before the module is linked */
/** The dependency's own calls that ecmaOS's wrap */
const original = {}

export function install(wali, start) {
  forked = !!start?.fork
  thread = start && !forked && { tgid: start.tgid, tid: getpid() }
  state = sharedState(start?.shared)
  if (thread) {
    // exit() in any thread ends the process, and its threads with it
    calls.SYS_exit_group = code => ended(syscall_raw('proc_exit_group', code))
    calls.__proc_exit = code => ended(syscall_raw('proc_exit_group', code))
  }
  Object.assign(original, { SYS_ioctl: wali.SYS_ioctl })
  const { SYS_lseek, SYS_exit } = wali
  // a thread's end gives up the robust locks it still holds
  calls.SYS_exit = code => {
    releaseRobust()
    return SYS_exit(code)
  }
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
        const ends = [view().getInt32(ptr, true), view().getInt32(ptr + 4, true)]
        opened(ends[0], O_RDONLY | flags)
        opened(ends[1], O_WRONLY | flags)
        if (withinLimit(...ends) < 0) return BigInt(-EMFILE)
      }
      return value
    }
  }
  Object.assign(wali, calls)
  for (const [name, call] of Object.entries(wali)) {
    if (typeof call !== 'function') continue
    wali[name] = name === '__proc_exit' ? mapped(name, call) : delivering(name, mapped(name, call))
  }
  // not wrapped: no handler may run between the call that starts the unwind and the stack being gone
  wali.SYS_fork = forkCall
  // a new thread takes the process's dispositions as they are; its mask comes from pthread_create
  if (thread) {
    seenVersion = Atomics.load(state.words, VERSION)
    routeAll()
  } else inheritSignals()
}

/** Gives this half the module's memory and function table, once it is instantiated */
export function attach(instance) {
  memory = instance.exports.memory
  table = instance.exports.__indirect_function_table
  stackPointer = instance.exports.__ecmaos_stack_pointer
  if (!thread && !forked) Atomics.store(state.addresses, TOP, roundUp(memory.buffer.byteLength, PAGE))
  // the word the program's loops read, which the kernel sets as it raises a signal on one of its threads, or stops it
  const word = instance.exports.__ecmaos_signal_word
  if (word) {
    signalWord = word.value
    syscall_raw('proc_signal_word', memory.buffer, signalWord)
  }
}

// --- fork ---

/**
 * `fork` on a program built with Asyncify (`asyncify-imports` naming `wali.SYS_fork`): the call returns twice, once in
 * each process. The wasm stack cannot be copied, so the call starts an unwind, which saves the frames into a buffer in
 * linear memory and returns out of `_start`; `drive()` then copies the memory, the host's shared state and the stack
 * pointer to a new process (`proc_fork`), and rewinds this one and the child into the call, which returns the child's
 * pid in the first and 0 in the other. Only the calling thread exists in the child. What the kernel does not carry
 * over: shared file mappings.
 */
const ASYNCIFY_UNWINDING = 1, ASYNCIFY_REWINDING = 2
const FORK_BUFFER = 256 * 1024
/** The instance's exports, once `drive()` has them: a program without Asyncify cannot fork */
let asyncify
/** The most pages the program's memory may grow to, which the child's copy is given too */
let memoryMaximum
/** The program's other mutable globals (its thread pointer, above all), exported by `utils/wali/signal-checks.mjs` as `__ecmaos_global_<n>` */
let programGlobals = []
/** Where the unwind saves the frames, in the program's memory (so a copy of it has them) */
let forkBuffer = 0
let forkResult = 0
/** Whether this process is a fork's child */
let forked = false

function forkCall() {
  if (!asyncify) return big(-ENOSYS)
  if (asyncify.asyncify_get_state() === ASYNCIFY_REWINDING) {
    asyncify.asyncify_stop_rewind()
    return big(forkResult)
  }
  if (!forkBuffer) {
    const at = allocate(FORK_BUFFER)
    if (at < 0) return big(-ENOMEM)
    forkBuffer = at
  }
  view().setUint32(forkBuffer, forkBuffer + 8, true)
  view().setUint32(forkBuffer + 4, forkBuffer + FORK_BUFFER, true)
  asyncify.asyncify_start_unwind(forkBuffer)
  return 0n
}

/** The child's copy of the memory and of what the threads share, handed to the kernel with what else it needs to start */
function startChild() {
  const copy = new WebAssembly.Memory({ initial: memory.buffer.byteLength / WASM_PAGE, maximum: memoryMaximum, shared: true })
  new Uint8Array(copy.buffer).set(bytes())
  const shared = new SharedArrayBuffer(state.buffer.byteLength)
  new Uint8Array(shared).set(new Uint8Array(state.buffer))
  const options = {
    buffer: forkBuffer,
    sp: stackPointer.value,
    // an i64 goes as text: JSON has no such number
    globals: programGlobals.map(([name, global]) => [name, typeof global.value === 'bigint' ? `${global.value}n` : global.value]),
    mask: String(mask),
    signals: { ignored: ignoredSet(), blocked: kernelSet(mask) }
  }
  return syscall_raw('proc_fork', init.exe, init.interpreter, copy, shared, JSON.stringify(options))
}

/**
 * Replaces `_start` of a program built with Asyncify by one that carries out its forks: each time the program unwinds
 * for one, the child is started and the program rewound to return from the call. In the child (`fork`, from the
 * kernel), the first thing is a rewind into the call. @returns the new `_start`, or undefined for a program without Asyncify
 */
export function drive(instance, limits, fork) {
  const exports = instance.exports
  if (typeof exports.asyncify_start_unwind !== 'function') return undefined
  asyncify = exports
  memoryMaximum = limits?.maximum
  programGlobals = Object.entries(exports).filter(([name]) => name.startsWith('__ecmaos_global_'))
  return () => {
    if (fork) {
      stackPointer.value = fork.sp
      for (const [name, value] of fork.globals) exports[name].value = typeof value === 'string' ? BigInt(value.slice(0, -1)) : value
      mask = BigInt(fork.mask)
      routeAll()
      forkBuffer = fork.buffer
      forkResult = 0
      exports.asyncify_start_rewind(forkBuffer)
    }
    for (;;) {
      exports._start()
      if (exports.asyncify_get_state() !== ASYNCIFY_UNWINDING) return
      exports.asyncify_stop_unwind()
      forkResult = startChild()
      exports.asyncify_start_rewind(forkBuffer)
    }
  }
}
