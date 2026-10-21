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
 *
 * Numbers are Linux's: WALI's musl is Linux musl, so `errno` values and structures need no translation.
 */

import { syscall_raw, returned } from '@zenfs/linux/uapi/base'
import { getdents } from '@zenfs/linux/uapi/fs'
import { environ } from '@zenfs/linux/uapi/process'

const EBADF = 9, ENOMEM = 12, EFAULT = 14, EINVAL = 22, ENOSYS = 38
const AT_FDCWD = -100, AT_SYMLINK_NOFOLLOW = 0x100, AT_REMOVEDIR = 0x200, AT_EMPTY_PATH = 0x1000
const O_RDWR = 2, O_CLOEXEC = 0x80000
const F_DUPFD = 0, F_GETFD = 1, F_SETFD = 2, F_GETFL = 3, F_SETFL = 4, F_DUPFD_CLOEXEC = 1030
const F_GETLK = 5, F_SETLK = 6, F_SETLKW = 7
const FD_CLOEXEC = 1
/** What `F_SETFL` may change; the access mode and creation flags are fixed at open */
const SETFL_MASK = 0x400 /* O_APPEND */ | 0x800 /* O_NONBLOCK */ | 0x2000 /* O_ASYNC */ | 0x4000 /* O_DIRECT */ | 0x40000 /* O_NOATIME */
const MAP_SHARED = 0x01, MAP_FIXED = 0x10, MAP_ANONYMOUS = 0x20
const MREMAP_MAYMOVE = 1
const TCGETS = 0x5401, TIOCGWINSZ = 0x5413
/** What an ioctl that answers with a structure copies back: `struct termios` and `struct winsize` */
const IOCTL_ANSWER_SIZE = { [TCGETS]: 60, [TIOCGWINSZ]: 8 }
/** `struct stat` on this target: musl's x86_64 layout */
const STAT_SIZE = 144
const PAGE = 4096, WASM_PAGE = 65536
const SEEK_SET = 0

const encoder = new TextEncoder()
const decoder = new TextDecoder()

let memory
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

/** The descriptors a child inherits: open ones without `FD_CLOEXEC`, for `posix_spawn` */
export function inheritable() {
  return [...fds].filter(([, entry]) => !entry.cloexec).map(([fd]) => fd)
}

/**
 * The path a `*at` call means. Relative to the working directory the kernel resolves it itself; relative to another
 * directory, the directory is named through procfs, which serves `/proc/self/fd/N` as a link to the open file.
 * @returns the path, or a negative errno
 */
function resolveAt(dirfd, pathPtr, flags = 0) {
  const path = pathPtr ? readString(pathPtr) : ''
  if (path.startsWith('/') || (dirfd === AT_FDCWD && path)) return path
  if (dirfd === AT_FDCWD) return (flags & AT_EMPTY_PATH) ? '.' : -2 /* ENOENT */
  const length = syscall_raw('readlink', `/proc/self/fd/${dirfd}`)
  if (length < 0) return -EBADF
  const dir = decoder.decode(returned.slice(0, length))
  if (!path) return (flags & AT_EMPTY_PATH) ? dir : -2
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
    case F_GETFL:
      return syscall_raw('fstat', fd) < 0 ? -EBADF : entryOf(fd).flags
    case F_SETFL: {
      if (syscall_raw('fstat', fd) < 0) return -EBADF
      const current = entryOf(fd)
      fds.set(fd, { ...current, flags: (current.flags & ~SETFL_MASK) | (arg & SETFL_MASK) })
      return 0
    }
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
    if (value >= 0) forget(fd)
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

export function install(table) {
  Object.assign(original, { SYS_ioctl: table.SYS_ioctl })
  const { SYS_lseek } = table
  // `rewinddir` is a seek to 0, which starts the listing again
  calls.SYS_lseek = (fd, offset, whence) => {
    if (offset === 0n && whence === SEEK_SET) positions.delete(fd)
    return SYS_lseek(fd, offset, whence)
  }
  Object.assign(table, calls)
}

/** Gives this half the module's memory, once it is instantiated */
export function attach(instanceMemory) {
  memory = instanceMemory
  top = roundUp(memory.buffer.byteLength, PAGE)
}
