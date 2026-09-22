/**
 * WASI preview1 for `/bin/wali`: a translation of `wasi_snapshot_preview1`, and of the
 * emscripten-proprietary `env.__syscall_*` ABI an ordinary (non-`STANDALONE_WASM`) `emcc` build
 * uses for file I/O, onto the real `@zenfs/linux` syscalls -- so a `wasm32-wasip1` program or a
 * plain `emcc` build runs as a real worker-hosted Process (killable, on a real pid, with real
 * pipes and a real tty) instead of on the main thread inside `Kernel.executeWasm`, where a tight
 * loop freezes the tab and `^C` cannot reach it.
 *
 * Scope is the portable core of preview1 (args/environ, clocks, random, the fd and path calls,
 * `poll_oneoff`, `proc_exit`) plus the `env.__syscall_*` names `IMPLEMENTED_SYSCALLS` lists in
 * `tree/wasm.ts`. Sockets and `epoll` answer ENOSYS/ENOTTY. Both an exported and an imported
 * memory are supported (`runPreview1`'s own `detectMemoryImport` reads the import's declared size
 * straight out of the binary and creates it, since the JS reflection API doesn't expose memory
 * limits). Preview2 components are not routed here; see `canRunInWorker` in `tree/wasm.ts`.
 *
 * A wasi fd and a real fd share one numbering: 0-2 are the process's own stdio fds, and the `/`
 * and `.` preopens are opened for real right here (not reserved at fixed numbers 3/4), so whatever
 * real fds they land on can never collide with one `env.__syscall_openat` later hands out into the
 * very same real fd space -- unlike `wasi_snapshot_preview1.path_open`, which allocates its own
 * fd numbers starting at `nextFd`, `__syscall_openat` returns a real fd directly. A collision here
 * was a real bug, caught by hand with a real `emcc` build (`tests/tree/wasi/fixtures/emcc-hello.c`):
 * a program's own file happened to open onto the fd the '.' preopen's fixed slot reserved, and
 * every `fd_write` to it silently hit the preopen's directory entry instead, throwing before the
 * write ever reached the real file -- caught with a durable, syscall-level trace (console output
 * from a worker close to its own exit is not reliable in this test environment; the eventual
 * fix -- opening the preopens for real up front -- came from that trace, not from guessing).
 */

import { open, read, write, close, lseek, ftruncate, fsync, fdatasync, stat, lstat, fstat, getdents, mkdir, rmdir, unlink, rename, link, symlink, readlink, getcwd, chdir, chmod, fchmod, chown, fchown, utimes, access, dup2 } from '@zenfs/linux/uapi/fs'
import { argv, environ } from '@zenfs/linux/uapi/process'
import { syscall, copyOut } from '@zenfs/linux/uapi/base'

const ESUCCESS = 0
const EBADF = 8
const EIO = 29
const ENOSYS = 52

// errno name (what a failed syscall throws as `error.code`) -> the WASI errno number
const ERRNO = {
  E2BIG: 1, EACCES: 2, EADDRINUSE: 3, EADDRNOTAVAIL: 4, EAGAIN: 6, EBADF: 8, EBUSY: 10, ECONNREFUSED: 14,
  EEXIST: 20, EFBIG: 22, EINTR: 27, EINVAL: 28, EIO: 29, EISDIR: 31, ELOOP: 32, EMFILE: 33, ENAMETOOLONG: 37,
  ENODEV: 43, ENOENT: 44, ENOMEM: 48, ENOSPC: 51, ENOSYS: 52, ENOTDIR: 54, ENOTEMPTY: 55, ENOTSUP: 58,
  ENOTTY: 59, ENXIO: 60, EPERM: 63, EPIPE: 64, ERANGE: 68, EROFS: 69, ESPIPE: 70, EXDEV: 75,
}

// Same errno names, but the real Linux numbers emscripten's musl expects back from a `__syscall_*`
// (which returns `-errno` on the plain Linux ABI, not a WASI errno) -- distinct table because the
// two numberings disagree on nearly every value (e.g. WASI's EIO is 29, Linux's is 5).
const LINUX_ERRNO = {
  EPERM: 1, ENOENT: 2, ESRCH: 3, EINTR: 4, EIO: 5, ENXIO: 6, E2BIG: 7, EBADF: 9, EAGAIN: 11, ENOMEM: 12,
  EACCES: 13, EBUSY: 16, EEXIST: 17, EXDEV: 18, ENODEV: 19, ENOTDIR: 20, EISDIR: 21, EINVAL: 22, EMFILE: 24,
  ENOTTY: 25, EFBIG: 27, ENOSPC: 28, ESPIPE: 29, EROFS: 30, EPIPE: 32, ERANGE: 34, ENAMETOOLONG: 36,
  ENOSYS: 38, ENOTEMPTY: 39, ELOOP: 40, ENOTSUP: 95, EADDRINUSE: 98, EADDRNOTAVAIL: 99, ECONNREFUSED: 111,
}

// open(2) flags (Linux values)
const O_RDONLY = 0
const O_WRONLY = 1
const O_RDWR = 2
const O_CREAT = 0x40
const O_EXCL = 0x80
const O_TRUNC = 0x200
const O_APPEND = 0x400
const O_DIRECTORY = 0x10000

// wasi oflags
const OFLAGS_CREAT = 1
const OFLAGS_DIRECTORY = 2
const OFLAGS_EXCL = 4
const OFLAGS_TRUNC = 8
// wasi fdflags
const FDFLAGS_APPEND = 1

const S_IFMT = 0xf000
const FILETYPE = { unknown: 0, block: 1, char: 2, dir: 3, file: 4, socket: 6, link: 7 }

const POLLIN = 0x1
const POLLOUT = 0x4

class ProcExit {
  constructor(code) {
    this.code = code
  }
}

function errnoOf(error) {
  return ERRNO[error?.code] ?? EIO
}

function filetypeOf(mode) {
  switch (mode & S_IFMT) {
    case 0x8000: return FILETYPE.file
    case 0x4000: return FILETYPE.dir
    case 0x2000: return FILETYPE.char
    case 0x6000: return FILETYPE.block
    case 0xa000: return FILETYPE.link
    case 0xc000: return FILETYPE.socket
    default: return FILETYPE.unknown
  }
}

/** Resolves `.` and `..` lexically, the way a path passed to a preopened directory is confined. */
function normalize(path) {
  const out = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

/** `poll(2)` on the real fds, returning each one's `revents`; same wrapper `/bin/node` exposes. */
function pollFds(fds, timeout) {
  syscall('poll', fds, timeout)
  const { view } = copyOut(class { constructor(buffer, offset) { this.view = new DataView(buffer, offset) } })
  return fds.map((_, i) => view.getUint16(i * 2, true))
}

/** A sleep the worker's own termination interrupts (`kill`, `^C`): the wait is on a private buffer. */
function sleepMs(ms) {
  if (ms <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Builds the `wasi_snapshot_preview1` import object for one instance. `getMemory` is late-bound. */
export function createPreview1(getMemory) {
  const cwd = getcwd()
  const args = argv()
  const env = Object.entries(environ()).map(([key, value]) => `${key}=${value}`)
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  // The preopens are opened *eagerly*, right here, so they get real fd numbers from the same real
  // allocator env.__syscall_openat (below) hands out into -- not the fixed 3/4 a lazy-open used to
  // reserve. That fixed numbering was a real bug: a program using env.__syscall_openat opens into
  // the very same real fd space (unlike wasi path_open's own wasi-fd numbers starting at `nextFd`),
  // so a real file that happened to land on fd 4 collided with the '.' preopen's reserved slot --
  // fd_write(4, ...) matched the stale directory entry and threw before ever reaching the real
  // file, a silent, hard-to-trace failure caught by hand with a real emcc build (see
  // tests/tree/wasi/fixtures/emcc-hello.c). Opening for real here, before anything else can, is
  // what guarantees uniqueness: real fd allocation never reuses a number that's still open.
  const preopenRoot = open('/', O_RDONLY | O_DIRECTORY)
  const preopenCwd = open(cwd, O_RDONLY | O_DIRECTORY)
  const fds = new Map([
    [0, { fd: 0, path: null, dir: false }],
    [1, { fd: 1, path: null, dir: false }],
    [2, { fd: 2, path: null, dir: false }],
    [preopenRoot, { fd: preopenRoot, path: '/', dir: true, preopen: '/' }],
    [preopenCwd, { fd: preopenCwd, path: cwd, dir: true, preopen: '.' }],
  ])
  let nextFd = Math.max(preopenRoot, preopenCwd) + 1

  const view = () => new DataView(getMemory().buffer)
  const bytes = () => new Uint8Array(getMemory().buffer)
  const readString = (ptr, len) => decoder.decode(bytes().subarray(ptr, ptr + len))

  /** Runs `fn`, turning a thrown syscall error into a WASI errno. */
  const guard = (fn) => {
    try {
      return fn() ?? ESUCCESS
    } catch (error) {
      if (error instanceof ProcExit) throw error
      return errnoOf(error)
    }
  }

  const readCString = (ptr) => {
    let end = ptr
    while (bytes()[end] !== 0) end++
    return decoder.decode(bytes().subarray(ptr, end))
  }

  // A real fd this instance saw only through `env.__syscall_openat` (below) has never been
  // registered here -- fd_write/fd_read/fd_close etc. still need to reach it, so an unknown
  // non-negative fd is treated as a plain, already-open file rather than EBADF. `fds` stays the
  // source of truth for fd 0-4 and anything opened through path_open.
  const entryOf = (fd) => fds.get(fd) ?? (fd >= 0 ? { fd, path: null, dir: false } : undefined)

  /** The real fd behind a wasi fd; a directory preopen opens lazily so `fd_readdir` can list it. */
  function realFd(entry) {
    if (entry.fd === null) entry.fd = open(entry.path, O_RDONLY | O_DIRECTORY)
    return entry.fd
  }

  function iovecs(ptr, count) {
    const dv = view()
    const list = []
    for (let i = 0; i < count; i++) list.push([dv.getUint32(ptr + i * 8, true), dv.getUint32(ptr + i * 8 + 4, true)])
    return list
  }

  function writeFilestat(ptr, st) {
    const dv = view()
    const ns = (ms) => BigInt(Math.trunc(ms * 1e6))
    dv.setBigUint64(ptr, BigInt(st.dev ?? 0), true)
    dv.setBigUint64(ptr + 8, BigInt(st.ino ?? 0), true)
    dv.setUint8(ptr + 16, filetypeOf(st.mode))
    dv.setBigUint64(ptr + 24, BigInt(st.nlink ?? 1), true)
    dv.setBigUint64(ptr + 32, BigInt(st.size ?? 0), true)
    dv.setBigUint64(ptr + 40, ns(st.atimeMs ?? 0), true)
    dv.setBigUint64(ptr + 48, ns(st.mtimeMs ?? 0), true)
    dv.setBigUint64(ptr + 56, ns(st.ctimeMs ?? 0), true)
  }

  function pathOf(dirFd, ptr, len) {
    const dir = entryOf(dirFd)
    if (!dir || !dir.dir) return null
    const rel = readString(ptr, len)
    return rel.startsWith('/') ? normalize(rel) : normalize(`${dir.path}/${rel}`)
  }

  /** Reads from `fd` into the iovecs, stopping at a short read the way a stream would. */
  function readInto(realfd, iov, position) {
    let total = 0
    for (const [ptr, len] of iov) {
      if (len === 0) continue
      const buffer = new Uint8Array(len)
      const n = read(realfd, buffer, position === undefined ? -1 : position + total)
      if (n <= 0) break
      bytes().set(buffer.subarray(0, n), ptr)
      total += n
      if (n < len) break
    }
    return total
  }

  function writeFrom(realfd, iov, position) {
    let total = 0
    for (const [ptr, len] of iov) {
      if (len === 0) continue
      const chunk = bytes().slice(ptr, ptr + len)
      let done = 0
      while (done < len) {
        const n = write(realfd, chunk.subarray(done), position === undefined ? -1 : position + total + done)
        if (n <= 0) break
        done += n
      }
      total += done
    }
    return total
  }

  const wasi = {
    args_sizes_get(argcPtr, sizePtr) {
      const dv = view()
      dv.setUint32(argcPtr, args.length, true)
      dv.setUint32(sizePtr, args.reduce((sum, arg) => sum + encoder.encode(arg).length + 1, 0), true)
      return ESUCCESS
    },
    args_get(argvPtr, bufPtr) {
      const dv = view()
      let offset = bufPtr
      args.forEach((arg, i) => {
        dv.setUint32(argvPtr + i * 4, offset, true)
        const encoded = encoder.encode(arg)
        bytes().set(encoded, offset)
        bytes()[offset + encoded.length] = 0
        offset += encoded.length + 1
      })
      return ESUCCESS
    },
    environ_sizes_get(countPtr, sizePtr) {
      const dv = view()
      dv.setUint32(countPtr, env.length, true)
      dv.setUint32(sizePtr, env.reduce((sum, item) => sum + encoder.encode(item).length + 1, 0), true)
      return ESUCCESS
    },
    environ_get(environPtr, bufPtr) {
      const dv = view()
      let offset = bufPtr
      env.forEach((item, i) => {
        dv.setUint32(environPtr + i * 4, offset, true)
        const encoded = encoder.encode(item)
        bytes().set(encoded, offset)
        bytes()[offset + encoded.length] = 0
        offset += encoded.length + 1
      })
      return ESUCCESS
    },

    clock_res_get(id, resPtr) {
      view().setBigUint64(resPtr, id === 0 ? 1000n : 1000n, true)
      return ESUCCESS
    },
    clock_time_get(id, _precision, timePtr) {
      const now = id === 0
        ? BigInt(Math.round(Date.now())) * 1000000n
        : BigInt(Math.round(performance.now() * 1e6))
      view().setBigUint64(timePtr, now, true)
      return ESUCCESS
    },
    random_get(ptr, len) {
      const out = bytes().subarray(ptr, ptr + len)
      // getRandomValues caps a single call at 65536 bytes
      for (let i = 0; i < len; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(i + 65536, len)))
      return ESUCCESS
    },
    sched_yield: () => ESUCCESS,
    proc_exit(code) {
      throw new ProcExit(code)
    },
    proc_raise: () => ENOSYS,

    fd_close(fd) {
      const entry = entryOf(fd)
      if (!entry) return EBADF
      if (fd <= 2) return ESUCCESS
      return guard(() => {
        if (entry.fd !== null) close(entry.fd)
        fds.delete(fd)
      })
    },
    fd_read(fd, iovPtr, iovCnt, nreadPtr) {
      const entry = entryOf(fd)
      if (!entry) return EBADF
      return guard(() => {
        const n = readInto(realFd(entry), iovecs(iovPtr, iovCnt))
        view().setUint32(nreadPtr, n, true)
      })
    },
    fd_pread(fd, iovPtr, iovCnt, offset, nreadPtr) {
      const entry = entryOf(fd)
      if (!entry) return EBADF
      return guard(() => {
        const n = readInto(realFd(entry), iovecs(iovPtr, iovCnt), Number(offset))
        view().setUint32(nreadPtr, n, true)
      })
    },
    fd_write(fd, iovPtr, iovCnt, nwrittenPtr) {
      const entry = entryOf(fd)
      if (!entry) return EBADF
      return guard(() => {
        const n = writeFrom(realFd(entry), iovecs(iovPtr, iovCnt))
        view().setUint32(nwrittenPtr, n, true)
      })
    },
    fd_pwrite(fd, iovPtr, iovCnt, offset, nwrittenPtr) {
      const entry = entryOf(fd)
      if (!entry) return EBADF
      return guard(() => {
        const n = writeFrom(realFd(entry), iovecs(iovPtr, iovCnt), Number(offset))
        view().setUint32(nwrittenPtr, n, true)
      })
    },
    fd_seek(fd, offset, whence, newOffsetPtr) {
      const entry = entryOf(fd)
      if (!entry) return EBADF
      // wasi whence: 0 SET, 1 CUR, 2 END -- the same numbers lseek(2) uses
      return guard(() => {
        view().setBigUint64(newOffsetPtr, BigInt(lseek(realFd(entry), Number(offset), whence)), true)
      })
    },
    fd_tell(fd, offsetPtr) {
      const entry = entryOf(fd)
      if (!entry) return EBADF
      return guard(() => {
        view().setBigUint64(offsetPtr, BigInt(lseek(realFd(entry), 0, 1)), true)
      })
    },
    fd_sync(fd) {
      const entry = entryOf(fd)
      if (!entry) return EBADF
      return guard(() => fsync(realFd(entry)))
    },
    fd_datasync(fd) {
      const entry = entryOf(fd)
      if (!entry) return EBADF
      return guard(() => fdatasync(realFd(entry)))
    },
    fd_advise: () => ESUCCESS,
    fd_allocate: () => ESUCCESS,
    fd_renumber(from, to) {
      const entry = entryOf(from)
      if (!entry || !entryOf(to)) return EBADF
      const target = entryOf(to)
      if (target.fd !== null && to > 2) guard(() => close(target.fd))
      fds.set(to, entry)
      fds.delete(from)
      return ESUCCESS
    },

    fd_fdstat_get(fd, ptr) {
      const entry = entryOf(fd)
      if (!entry) return EBADF
      return guard(() => {
        const st = fd <= 2 ? fstat(entry.fd) : entry.fd !== null ? fstat(entry.fd) : stat(entry.path)
        const dv = view()
        dv.setUint8(ptr, filetypeOf(st.mode))
        dv.setUint16(ptr + 2, 0, true)
        dv.setBigUint64(ptr + 8, 0xffffffffffffffffn, true)
        dv.setBigUint64(ptr + 16, 0xffffffffffffffffn, true)
      })
    },
    fd_fdstat_set_flags: () => ESUCCESS,
    fd_fdstat_set_rights: () => ESUCCESS,
    fd_filestat_get(fd, ptr) {
      const entry = entryOf(fd)
      if (!entry) return EBADF
      return guard(() => writeFilestat(ptr, entry.fd !== null ? fstat(entry.fd) : stat(entry.path)))
    },
    fd_filestat_set_size(fd, size) {
      const entry = entryOf(fd)
      if (!entry) return EBADF
      return guard(() => ftruncate(realFd(entry), Number(size)))
    },
    fd_filestat_set_times: () => ESUCCESS,

    fd_prestat_get(fd, ptr) {
      const entry = entryOf(fd)
      if (!entry?.preopen) return EBADF
      const dv = view()
      dv.setUint8(ptr, 0)
      dv.setUint32(ptr + 4, encoder.encode(entry.preopen).length, true)
      return ESUCCESS
    },
    fd_prestat_dir_name(fd, ptr, len) {
      const entry = entryOf(fd)
      if (!entry?.preopen) return EBADF
      bytes().set(encoder.encode(entry.preopen).subarray(0, len), ptr)
      return ESUCCESS
    },

    fd_readdir(fd, bufPtr, bufLen, cookie, usedPtr) {
      const entry = entryOf(fd)
      if (!entry) return EBADF
      return guard(() => {
        if (!entry.listing) {
          const found = getdents(realFd(entry))
          const names = new Set(found.map(item => item.name))
          const extra = ['.', '..'].filter(name => !names.has(name)).map(name => ({ ino: 0, type: 4, name }))
          entry.listing = [...extra, ...found]
        }
        const dv = view()
        const out = bytes()
        let offset = 0
        for (let i = Number(cookie); i < entry.listing.length; i++) {
          const item = entry.listing[i]
          const name = encoder.encode(item.name)
          const header = new Uint8Array(24)
          const hv = new DataView(header.buffer)
          hv.setBigUint64(0, BigInt(i + 1), true)
          hv.setBigUint64(8, BigInt(item.ino ?? 0), true)
          hv.setUint32(16, name.length, true)
          // DT_* -> filetype: DT_DIR 4, DT_REG 8, DT_LNK 10, DT_CHR 2, DT_BLK 6
          hv.setUint8(20, { 4: FILETYPE.dir, 8: FILETYPE.file, 10: FILETYPE.link, 2: FILETYPE.char, 6: FILETYPE.block }[item.type] ?? FILETYPE.unknown)
          const record = new Uint8Array(24 + name.length)
          record.set(header)
          record.set(name, 24)
          const room = bufLen - offset
          out.set(record.subarray(0, Math.min(record.length, room)), bufPtr + offset)
          offset += Math.min(record.length, room)
          if (record.length > room) break
        }
        dv.setUint32(usedPtr, offset, true)
      })
    },

    path_open(dirFd, _dirflags, pathPtr, pathLen, oflags, _rightsBase, _rightsInheriting, fdflags, fdPtr) {
      const path = pathOf(dirFd, pathPtr, pathLen)
      if (path === null) return entryOf(dirFd) ? 54 : EBADF
      return guard(() => {
        let flags = O_RDWR
        if (oflags & OFLAGS_CREAT) flags |= O_CREAT
        if (oflags & OFLAGS_EXCL) flags |= O_EXCL
        if (oflags & OFLAGS_TRUNC) flags |= O_TRUNC
        if (oflags & OFLAGS_DIRECTORY) flags = O_RDONLY | O_DIRECTORY
        if (fdflags & FDFLAGS_APPEND) flags |= O_APPEND
        let real
        try {
          real = open(path, flags, 0o644)
        } catch (error) {
          // A read-only file cannot be opened O_RDWR; wasi rights are not tracked, so retry as read-only
          if (error?.code === 'EACCES' || error?.code === 'EROFS' || error?.code === 'EISDIR') real = open(path, O_RDONLY | (oflags & OFLAGS_DIRECTORY ? O_DIRECTORY : 0))
          else throw error
        }
        const isDir = filetypeOf(fstat(real).mode) === FILETYPE.dir
        const wasiFd = nextFd++
        fds.set(wasiFd, { fd: real, path, dir: isDir })
        view().setUint32(fdPtr, wasiFd, true)
      })
    },
    path_create_directory(dirFd, ptr, len) {
      const path = pathOf(dirFd, ptr, len)
      if (path === null) return EBADF
      return guard(() => mkdir(path, 0o755))
    },
    path_remove_directory(dirFd, ptr, len) {
      const path = pathOf(dirFd, ptr, len)
      if (path === null) return EBADF
      return guard(() => rmdir(path))
    },
    path_unlink_file(dirFd, ptr, len) {
      const path = pathOf(dirFd, ptr, len)
      if (path === null) return EBADF
      return guard(() => unlink(path))
    },
    path_rename(oldFd, oldPtr, oldLen, newFd, newPtr, newLen) {
      const from = pathOf(oldFd, oldPtr, oldLen)
      const to = pathOf(newFd, newPtr, newLen)
      if (from === null || to === null) return EBADF
      return guard(() => rename(from, to))
    },
    path_symlink(oldPtr, oldLen, dirFd, newPtr, newLen) {
      const target = readString(oldPtr, oldLen)
      const path = pathOf(dirFd, newPtr, newLen)
      if (path === null) return EBADF
      return guard(() => symlink(target, path))
    },
    path_readlink(dirFd, ptr, len, bufPtr, bufLen, usedPtr) {
      const path = pathOf(dirFd, ptr, len)
      if (path === null) return EBADF
      return guard(() => {
        const target = encoder.encode(readlink(path)).subarray(0, bufLen)
        bytes().set(target, bufPtr)
        view().setUint32(usedPtr, target.length, true)
      })
    },
    path_filestat_get(dirFd, flags, ptr, len, statPtr) {
      const path = pathOf(dirFd, ptr, len)
      if (path === null) return EBADF
      // wasi lookupflags bit 0 is SYMLINK_FOLLOW
      return guard(() => writeFilestat(statPtr, (flags & 1) ? stat(path) : lstat(path)))
    },
    path_filestat_set_times: () => ESUCCESS,
    path_link: () => ENOSYS,

    poll_oneoff(inPtr, outPtr, nsubs, neventsPtr) {
      const dv = view()
      const subs = []
      for (let i = 0; i < nsubs; i++) {
        const base = inPtr + i * 48
        const userdata = dv.getBigUint64(base, true)
        const tag = dv.getUint8(base + 8)
        if (tag === 0) {
          const flags = dv.getUint16(base + 40, true)
          const timeout = dv.getBigUint64(base + 24, true)
          const id = dv.getUint32(base + 16, true)
          const nowNs = id === 0 ? BigInt(Date.now()) * 1000000n : BigInt(Math.round(performance.now() * 1e6))
          const wait = flags & 1 ? timeout - nowNs : timeout
          subs.push({ userdata, tag, ms: Number(wait > 0n ? wait : 0n) / 1e6 })
        } else {
          subs.push({ userdata, tag, fd: dv.getUint32(base + 16, true) })
        }
      }

      const fdSubs = subs.filter(sub => sub.tag !== 0)
      const clockSubs = subs.filter(sub => sub.tag === 0)
      const soonest = clockSubs.length ? Math.min(...clockSubs.map(sub => sub.ms)) : -1
      const ready = []

      const pollable = fdSubs.filter(sub => entryOf(sub.fd)?.fd !== null && entryOf(sub.fd))
      if (pollable.length) {
        const revents = pollFds(pollable.map(sub => ({ fd: entryOf(sub.fd).fd, events: sub.tag === 1 ? POLLIN : POLLOUT })), soonest)
        pollable.forEach((sub, i) => { if (revents[i]) ready.push(sub) })
      } else if (soonest > 0) {
        sleepMs(soonest)
      }
      // A regular file or a directory is always ready
      for (const sub of fdSubs) if (!pollable.includes(sub)) ready.push(sub)

      const events = ready.length ? ready : clockSubs.filter(sub => sub.ms <= soonest)
      events.forEach((sub, i) => {
        const base = outPtr + i * 32
        dv.setBigUint64(base, sub.userdata, true)
        dv.setUint16(base + 8, ESUCCESS, true)
        dv.setUint8(base + 10, sub.tag)
        dv.setBigUint64(base + 16, 0n, true)
        dv.setUint16(base + 24, 0, true)
      })
      dv.setUint32(neventsPtr, events.length, true)
      return ESUCCESS
    },

    sock_accept: () => ENOSYS,
    sock_recv: () => ENOSYS,
    sock_send: () => ENOSYS,
    sock_shutdown: () => ENOSYS,
  }

  // Emscripten's own `env.__syscall_*` ABI, the layer its libc (as opposed to a plain `wasm32-wasip1`
  // target's) actually calls for file I/O -- present alongside `wasi_snapshot_preview1` in a normal
  // (non-STANDALONE_WASM) `emcc` build. Verified against a real `emcc` 6.0.9 build's own JS runtime
  // (`src/lib/libsyscall.js` in the emscripten install) rather than guessed: signatures, the varargs
  // convention (the last param is a pointer into wasm memory holding packed i32 extras, read one at a
  // time and advanced -- `syscallGetVarargI`) and the `struct stat` layout (offsets confirmed by
  // compiling and running a small `offsetof` probe with the same `emcc`) all come from there. These
  // calls use real fds directly, the same integer space `open()` returns into -- no wasi-fd remapping
  // needed, unlike the `wasi_snapshot_preview1` side above. Sockets, `fcntl` locking/duplication
  // beyond `F_DUPFD`, and anything under `epoll`/`poll`(2) are not implemented; they answer ENOSYS.
  const AT_FDCWD = -100
  const dirPaths = new Map() // real fd -> path, populated by openat so a later ...at(dirfd, ...) resolves

  const guardLinux = (fn) => {
    try {
      return fn() ?? ESUCCESS
    } catch (error) {
      if (error instanceof ProcExit) throw error
      return -(LINUX_ERRNO[error?.code] ?? LINUX_ERRNO.EIO)
    }
  }

  function resolveAt(dirfd, pathPtr) {
    const rel = readCString(pathPtr)
    if (rel.startsWith('/')) return rel
    const dir = dirfd === AT_FDCWD ? getcwd() : dirPaths.get(dirfd)
    if (dir === undefined) throw { code: 'EBADF' }
    return rel.length ? `${dir}/${rel}` : dir
  }

  function writeStatLinux(buf, st) {
    const dv = view()
    const ns = (ms) => [BigInt(Math.floor((ms ?? 0) / 1000)), Math.round(((ms ?? 0) % 1000) * 1e6)]
    dv.setUint32(buf + 0, Number(st.dev ?? 0), true)
    dv.setUint32(buf + 4, st.mode, true)
    dv.setUint32(buf + 8, st.nlink ?? 1, true)
    dv.setUint32(buf + 12, st.uid ?? 0, true)
    dv.setUint32(buf + 16, st.gid ?? 0, true)
    dv.setUint32(buf + 20, Number(st.rdev ?? 0), true)
    dv.setBigInt64(buf + 24, BigInt(st.size ?? 0), true)
    dv.setInt32(buf + 32, 4096, true)
    dv.setInt32(buf + 36, st.blocks ?? 0, true)
    ;[buf + 40, buf + 56, buf + 72].forEach((base, i) => {
      const [sec, nsec] = ns([st.atimeMs, st.mtimeMs, st.ctimeMs][i])
      dv.setBigInt64(base, sec, true)
      dv.setInt32(base + 8, nsec, true)
    })
    dv.setBigInt64(buf + 88, BigInt(st.ino ?? 0), true)
  }

  function varargI(ptr, index) {
    return view().getInt32(ptr + index * 4, true)
  }

  const wasiOflagsFromLinux = (flags) => flags // both sides already use Linux's O_* numbering

  const envSyscalls = {
    __syscall_chdir: (pathPtr) => guardLinux(() => chdir(readCString(pathPtr))),
    __syscall_fchdir: (fd) => guardLinux(() => { dirPaths.set(fd, dirPaths.get(fd) ?? '.') }),
    __syscall_chmod: (pathPtr, mode) => guardLinux(() => chmod(readCString(pathPtr), mode)),
    __syscall_fchmod: (fd, mode) => guardLinux(() => fchmod(fd, mode)),
    __syscall_rmdir: (pathPtr) => guardLinux(() => rmdir(readCString(pathPtr))),
    __syscall_getcwd: (bufPtr, size) => guardLinux(() => {
      const encoded = encoder.encode(getcwd() + '\0')
      if (encoded.length > size) throw { code: 'ERANGE' }
      bytes().set(encoded, bufPtr)
      return encoded.length
    }),
    __syscall_truncate64: (pathPtr, low) => guardLinux(() => {
      const fd = open(readCString(pathPtr), O_WRONLY)
      try { ftruncate(fd, Number(low)) } finally { close(fd) }
    }),
    __syscall_ftruncate64: (fd, low) => guardLinux(() => ftruncate(fd, Number(low))),
    __syscall_stat64: (pathPtr, buf) => guardLinux(() => writeStatLinux(buf, stat(readCString(pathPtr)))),
    __syscall_lstat64: (pathPtr, buf) => guardLinux(() => writeStatLinux(buf, lstat(readCString(pathPtr)))),
    __syscall_fstat64: (fd, buf) => guardLinux(() => writeStatLinux(buf, fstat(fd))),
    __syscall_fchown32: (fd, owner, group) => guardLinux(() => fchown(fd, owner, group)),
    __syscall_getdents64: (fd, dirp, count) => guardLinux(() => {
      const entries = getdents(fd)
      const out = bytes()
      let offset = 0
      for (const item of entries) {
        const name = encoder.encode(item.name)
        const reclen = 19 + name.length + 1 // ino(8) off(8) reclen(2) type(1) + name + NUL
        if (offset + reclen > count) break
        const dv = view()
        dv.setBigUint64(dirp + offset, BigInt(item.ino ?? 0), true)
        dv.setBigUint64(dirp + offset + 8, BigInt(offset + reclen), true)
        dv.setUint16(dirp + offset + 16, reclen, true)
        out[dirp + offset + 18] = item.type ?? 0
        out.set(name, dirp + offset + 19)
        out[dirp + offset + 19 + name.length] = 0
        offset += reclen
      }
      return offset
    }),
    __syscall_fcntl64: (fd, cmd, varargsPtr) => guardLinux(() => {
      const F_DUPFD = 0, F_GETFD = 1, F_SETFD = 2, F_GETFL = 3, F_SETFL = 4
      if (cmd === F_DUPFD) return dup2(fd, varargI(varargsPtr, 0))
      if (cmd === F_GETFD || cmd === F_GETFL) return 0
      if (cmd === F_SETFD || cmd === F_SETFL) return 0
      throw { code: 'ENOSYS' }
    }),
    __syscall_openat: (dirfd, pathPtr, flags, varargsPtr) => guardLinux(() => {
      const path = resolveAt(dirfd, pathPtr)
      const mode = varargsPtr ? varargI(varargsPtr, 0) : 0o644
      const fd = open(path, wasiOflagsFromLinux(flags), mode)
      if (flags & O_DIRECTORY) dirPaths.set(fd, path)
      return fd
    }),
    __syscall_umask: () => 0o022,
    __syscall_mkdirat: (dirfd, pathPtr, mode) => guardLinux(() => mkdir(resolveAt(dirfd, pathPtr), mode)),
    __syscall_fchownat: (dirfd, pathPtr, owner, group, _flags) => guardLinux(() => chown(resolveAt(dirfd, pathPtr), owner, group)),
    __syscall_newfstatat: (dirfd, pathPtr, buf, flags) => guardLinux(() => {
      const AT_SYMLINK_NOFOLLOW = 0x100
      const path = resolveAt(dirfd, pathPtr)
      writeStatLinux(buf, (flags & AT_SYMLINK_NOFOLLOW) ? lstat(path) : stat(path))
    }),
    __syscall_unlinkat: (dirfd, pathPtr, flags) => guardLinux(() => {
      const AT_REMOVEDIR = 0x200
      const path = resolveAt(dirfd, pathPtr)
      if (flags & AT_REMOVEDIR) rmdir(path)
      else unlink(path)
    }),
    __syscall_renameat: (olddirfd, oldPtr, newdirfd, newPtr) => guardLinux(() => rename(resolveAt(olddirfd, oldPtr), resolveAt(newdirfd, newPtr))),
    __syscall_symlinkat: (targetPtr, dirfd, linkPtr) => guardLinux(() => symlink(readCString(targetPtr), resolveAt(dirfd, linkPtr))),
    __syscall_linkat: (olddirfd, oldPtr, newdirfd, newPtr, _flags) => guardLinux(() => link(resolveAt(olddirfd, oldPtr), resolveAt(newdirfd, newPtr))),
    __syscall_readlinkat: (dirfd, pathPtr, bufPtr, bufSize) => guardLinux(() => {
      const target = encoder.encode(readlink(resolveAt(dirfd, pathPtr))).subarray(0, bufSize)
      bytes().set(target, bufPtr)
      return target.length
    }),
    __syscall_fchmodat2: (dirfd, pathPtr, mode, _flags) => guardLinux(() => chmod(resolveAt(dirfd, pathPtr), mode)),
    __syscall_faccessat: (dirfd, pathPtr, amode, _flags) => guardLinux(() => access(resolveAt(dirfd, pathPtr), amode)),
    __syscall_utimensat: (dirfd, pathPtr, timesPtr, _flags) => guardLinux(() => {
      const path = resolveAt(dirfd, pathPtr)
      const dv = view()
      const now = Date.now()
      const at = timesPtr ? Number(dv.getBigInt64(timesPtr, true)) * 1000 : now
      const mt = timesPtr ? Number(dv.getBigInt64(timesPtr + 16, true)) * 1000 : now
      utimes(path, at, mt)
    }),
    __syscall_getuid32: () => 0,
    __syscall_geteuid32: () => 0,
    __syscall_getgid32: () => 0,
    __syscall_getegid32: () => 0,
    __syscall_dup3: (fd, newfd, _flags) => guardLinux(() => dup2(fd, newfd)),
    __syscall_fallocate: () => ESUCCESS,
    __syscall_fadvise64: () => ESUCCESS,
    __syscall_ioctl: () => -LINUX_ERRNO.ENOTTY,
  }

  return { imports: { wasi_snapshot_preview1: wasi, env: envSyscalls }, ProcExit, args }
}

/** Runs a preview1 module to completion and returns its exit code. */
/**
 * Builds a real argc/argv (a char** with each arg NUL-terminated) -- the shape `__main_argc_argv`
 * (emscripten's non-STANDALONE_WASM entry point, taken when there is no `_start`) expects, the same
 * as libc's own `main(argc, argv)`. Memory is not grown (a module built with a fixed max, the
 * ordinary case, rejects that): the space comes from the module's own stack allocator, the same one
 * its own C code uses for a local buffer, via the `_emscripten_stack_alloc` export.
 */
function buildArgv(memory, args, stackAlloc) {
  const encoder = new TextEncoder()
  const encoded = args.map(arg => encoder.encode(arg))
  const size = (args.length + 1) * 4 + encoded.reduce((sum, arg) => sum + arg.length + 1, 0)
  const base = stackAlloc(size)
  const bytes = new Uint8Array(memory.buffer)
  const view = new DataView(memory.buffer)
  let offset = base + (args.length + 1) * 4
  encoded.forEach((arg, i) => {
    view.setUint32(base + i * 4, offset, true)
    bytes.set(arg, offset)
    bytes[offset + arg.length] = 0
    offset += arg.length + 1
  })
  return base
}

/**
 * Reads a memory import's declared limits straight out of the binary (the JS reflection API,
 * `WebAssembly.Module.imports()`, reports only `{ module, name, kind }`, never the limits), so a
 * module built with `-sIMPORTED_MEMORY` (or any other toolchain that imports rather than exports
 * its memory) can still be satisfied here: this adapter creates the `WebAssembly.Memory` itself,
 * to the module's own declared size, instead of requiring an exported one.
 */
function detectMemoryImport(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const decoder = new TextDecoder()
  let offset = 8 // past the \0asm magic + version

  function readLEB() {
    let result = 0, shift = 0, read = 0
    while (true) {
      const byte = view.getUint8(offset + read)
      read++
      result |= (byte & 0x7f) << shift
      if ((byte & 0x80) === 0) break
      shift += 7
    }
    offset += read
    return result
  }

  while (offset < bytes.byteLength) {
    const sectionId = view.getUint8(offset)
    offset++
    const sectionSize = readLEB()
    const sectionEnd = offset + sectionSize
    if (sectionId !== 2) { offset = sectionEnd; continue } // import section
    const count = readLEB()
    for (let i = 0; i < count; i++) {
      const moduleLen = readLEB()
      const moduleName = decoder.decode(bytes.subarray(offset, offset + moduleLen))
      offset += moduleLen
      const nameLen = readLEB()
      const name = decoder.decode(bytes.subarray(offset, offset + nameLen))
      offset += nameLen
      const kind = view.getUint8(offset)
      offset++
      if (kind === 2) { // memory
        const flags = view.getUint8(offset)
        offset++
        const initial = readLEB()
        const maximum = (flags & 0x01) ? readLEB() : undefined
        return { module: moduleName, name, initial, maximum }
      } else if (kind === 0) { // func: one type index
        readLEB()
      } else if (kind === 1) { // table: elem type + limits
        offset++
        const tflags = view.getUint8(offset)
        offset++
        readLEB()
        if (tflags & 0x01) readLEB()
      } else if (kind === 3) { // global: valtype + mutability
        offset += 2
      }
    }
    return null
  }
  return null
}

/** Runs a preview1 or ordinary-`emcc` module to completion and returns its exit code. */
export async function runPreview1(source) {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source)
  const module = await WebAssembly.compile(source)
  let memory
  const { imports, ProcExit: Exit, args } = createPreview1(() => memory)
  const memoryImport = detectMemoryImport(bytes)
  if (memoryImport) {
    // The module wants its memory handed in rather than exported -- create it to the module's own
    // declared limits and answer the import with it, same as any other host would.
    memory = new WebAssembly.Memory(memoryImport.maximum !== undefined
      ? { initial: memoryImport.initial, maximum: memoryImport.maximum }
      : { initial: memoryImport.initial })
    imports[memoryImport.module] = { ...(imports[memoryImport.module] ?? {}), [memoryImport.name]: memory }
  }
  const instance = await WebAssembly.instantiate(module, imports)
  memory = memory ?? instance.exports.memory
  if (!memory) throw new Error('wasi: the module does not export or import its memory')
  const { _start, _initialize, __wasm_call_ctors, __main_argc_argv, __funcs_on_exit, fflush } = instance.exports
  try {
    let code = 0
    if (typeof _start === 'function') {
      _start()
    } else if (typeof _initialize === 'function') {
      _initialize()
    } else if (typeof __main_argc_argv === 'function') {
      // Ordinary emcc output: no _start, driven the way emscripten's own JS glue (Module.callMain)
      // would drive it -- run static constructors, call main(argc, argv), then flush stdio and any
      // atexit handlers the way EXIT_RUNTIME's own exit path does, since there is no glue to do it.
      if (typeof instance.exports.emscripten_stack_init === 'function') instance.exports.emscripten_stack_init()
      if (typeof __wasm_call_ctors === 'function') __wasm_call_ctors()
      const stackAlloc = instance.exports._emscripten_stack_alloc
      if (typeof stackAlloc !== 'function') throw new Error('wasi: the module has no _emscripten_stack_alloc to build argv in')
      const argvPtr = buildArgv(memory, args, stackAlloc)
      code = __main_argc_argv(args.length, argvPtr) | 0
      if (typeof fflush === 'function') fflush(0)
      if (typeof __funcs_on_exit === 'function') __funcs_on_exit()
    } else {
      throw new Error('wasi: the module exports none of _start, _initialize, __main_argc_argv')
    }
    return code
  } catch (error) {
    if (error instanceof Exit) return error.code
    throw error
  }
}
