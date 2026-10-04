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

import { open, read, write, close, lseek, ftruncate, fsync, fdatasync, stat, lstat, fstat, getdents, mkdir, rmdir, unlink, rename, link, symlink, readlink, getcwd, chdir, chmod, fchmod, chown, fchown, utimes, access, dup2, tcgetattr, tcsetattr, winsize } from '@zenfs/linux/uapi/fs'
import { argv, environ, getpid } from '@zenfs/linux/uapi/process'
import { syscall, copyOut, on_signal } from '@zenfs/linux/uapi/base'

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

// What an `env.__syscall_*` hands back on failure is `-errno`, in emscripten 6's own numbering: its
// musl headers define ENOENT as 44 and EACCES as 2, which are the WASI values, not Linux's 2 and 13.
// (Confirmed by compiling `ENOENT` into a program and running it here.) A program that only tests
// for `< 0` never notices; one that compares `errno` to `ENOENT` -- Vim deciding a missing file is a
// new file, not a permission error -- does. So these extend `ERRNO` with the names only the socket
// and epoll calls need, rather than a second table of Linux numbers.
const SYSCALL_ERRNO = {
  ...ERRNO,
  ENOTSOCK: 57, ENOPROTOOPT: 50, EPROTONOSUPPORT: 66, EAFNOSUPPORT: 5, EISCONN: 30, ENOTCONN: 53,
  ENETUNREACH: 40, EALREADY: 7, EINPROGRESS: 26, EEXIST: 20, ESRCH: 71,
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

// epoll(7) -- values from musl's <sys/epoll.h>. EPOLLIN/EPOLLOUT are deliberately the same bits as
// POLLIN/POLLOUT (true on real Linux too), so `pollFds`'s revents can be used as epoll's outgoing
// `events` with no translation.
const EPOLL_CTL_ADD = 1
const EPOLL_CTL_DEL = 2
const EPOLL_CTL_MOD = 3
const EPOLL_CLOEXEC = 0x80000
// struct epoll_event on wasm32 (confirmed by compiling a real offsetof() probe with the installed
// emcc 6.0.9, the same methodology as struct stat's own layout): { u32 events @0; u64 data @8 },
// 16 bytes total -- unlike x86_64, wasm32 has no __attribute__((packed)) on it, so `data` is
// 8-aligned, not 4.
const EPOLL_EVENT_SIZE = 16

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
export function createPreview1(getMemory, getTable = () => undefined) {
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

  // epoll instances: a synthetic fd from the same real allocator (`nextFd`), so it can never
  // collide with a real fd `env.__syscall_openat` hands out, but is never registered in `fds` --
  // it isn't a real file, and fd_read/fd_write/fd_close etc. on it correctly see EBADF via
  // `entryOf`'s fallback. `interests` maps a watched real fd to its registered `{ events, dataLo,
  // dataHi }` (the two dataLo/dataHi halves are epoll_data_t's opaque 8 bytes, echoed back
  // unexamined -- same split trick emscripten's own libepoll.js uses so it works without
  // WASM_BIGINT too).
  const epollInstances = new Map()

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
      dirPos.delete(fd)
      const sock = sockets.get(fd)
      if (sock) {
        return guard(() => {
          if (sock.connected) { close(sock.readFd); close(sock.writeFd) }
          sockets.delete(fd)
        })
      }
      const entry = entryOf(fd)
      if (!entry) return EBADF
      if (fd <= 2) return ESUCCESS
      return guard(() => {
        if (entry.fd !== null) close(entry.fd)
        fds.delete(fd)
      })
    },
    fd_read(fd, iovPtr, iovCnt, nreadPtr) {
      const sr = socketRealFd(fd, 'read')
      if (sr.isSocket) {
        if (sr.error) return sr.error
        return guard(() => { const n = readInto(sr.fd, iovecs(iovPtr, iovCnt)); view().setUint32(nreadPtr, n, true) })
      }
      const entry = entryOf(fd)
      if (!entry) return EBADF
      return guard(() => {
        const n = readInto(realFd(entry), iovecs(iovPtr, iovCnt))
        view().setUint32(nreadPtr, n, true)
      })
    },
    fd_pread(fd, iovPtr, iovCnt, offset, nreadPtr) {
      const sr = socketRealFd(fd, 'read')
      if (sr.isSocket) {
        if (sr.error) return sr.error
        return guard(() => { const n = readInto(sr.fd, iovecs(iovPtr, iovCnt), Number(offset)); view().setUint32(nreadPtr, n, true) })
      }
      const entry = entryOf(fd)
      if (!entry) return EBADF
      return guard(() => {
        const n = readInto(realFd(entry), iovecs(iovPtr, iovCnt), Number(offset))
        view().setUint32(nreadPtr, n, true)
      })
    },
    fd_write(fd, iovPtr, iovCnt, nwrittenPtr) {
      const sr = socketRealFd(fd, 'write')
      if (sr.isSocket) {
        if (sr.error) return sr.error
        return guard(() => { const n = writeFrom(sr.fd, iovecs(iovPtr, iovCnt)); view().setUint32(nwrittenPtr, n, true) })
      }
      const entry = entryOf(fd)
      if (!entry) return EBADF
      return guard(() => {
        const n = writeFrom(realFd(entry), iovecs(iovPtr, iovCnt))
        view().setUint32(nwrittenPtr, n, true)
      })
    },
    fd_pwrite(fd, iovPtr, iovCnt, offset, nwrittenPtr) {
      const sr = socketRealFd(fd, 'write')
      if (sr.isSocket) {
        if (sr.error) return sr.error
        return guard(() => { const n = writeFrom(sr.fd, iovecs(iovPtr, iovCnt), Number(offset)); view().setUint32(nwrittenPtr, n, true) })
      }
      const entry = entryOf(fd)
      if (!entry) return EBADF
      return guard(() => {
        const n = writeFrom(realFd(entry), iovecs(iovPtr, iovCnt), Number(offset))
        view().setUint32(nwrittenPtr, n, true)
      })
    },
    fd_seek(fd, offset, whence, newOffsetPtr) {
      if (offset === 0n && whence === 0) dirPos.delete(fd) // rewinddir
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

      // A connected socket polls on its real read/write fd, same as any other real fd; an
      // unconnected one has nothing to poll (not ready, not an error either).
      const pollFdOf = (fd) => {
        const sock = sockets.get(fd)
        if (sock) return sock.connected ? sock.readFd : undefined
        return entryOf(fd)?.fd
      }
      const pollable = fdSubs.filter(sub => pollFdOf(sub.fd) !== null && pollFdOf(sub.fd) !== undefined)
      if (pollable.length) {
        const revents = pollFds(pollable.map(sub => ({ fd: pollFdOf(sub.fd), events: sub.tag === 1 ? POLLIN : POLLOUT })), soonest)
        pollable.forEach((sub, i) => { if (revents[i]) ready.push(sub) })
      } else if (soonest > 0) {
        sleepMs(soonest)
      }
      // A regular file or a directory is always ready; an unconnected socket (no real fd to poll
      // yet) is not -- only these two cases ever fall out of `pollable` now that sockets exist.
      for (const sub of fdSubs) if (!pollable.includes(sub) && !sockets.has(sub.fd)) ready.push(sub)

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

  /**
   * The real work behind `epoll_pwait`/`epoll_pwait_nonblocking`: derives readiness for every fd
   * `inst` watches through the same real `poll(2)` syscall `poll_oneoff` above already uses (so a
   * pipe/tty's actual readable/writable state answers it, not a guess), waiting up to `timeoutMs`
   * (`pollFds`'s own timeout argument does the actual blocking wait; -1 blocks until ready, exactly
   * like `poll_oneoff`'s already-proven-interruptible-by-a-real-kill wait). Writes up to
   * `maxevents` ready `struct epoll_event`s to `evPtr` and returns how many.
   */
  function doEpollWait(inst, evPtr, maxevents, timeoutMs) {
    const entries = [...inst.interests.entries()]
    if (!entries.length) {
      if (timeoutMs > 0) sleepMs(timeoutMs)
      return 0
    }
    const fds = entries.map(([fd, reg]) => {
      const sock = sockets.get(fd)
      const realFd = sock ? (sock.connected ? sock.readFd : -1) : (entryOf(fd)?.fd ?? fd)
      return { fd: realFd, events: reg.events & (POLLIN | POLLOUT) }
    })
    const revents = pollFds(fds, timeoutMs)
    const dv = view()
    let n = 0
    for (let i = 0; i < entries.length && n < maxevents; i++) {
      if (!revents[i]) continue
      const [, reg] = entries[i]
      const base = evPtr + n * EPOLL_EVENT_SIZE
      dv.setUint32(base, revents[i], true)
      dv.setInt32(base + 8, reg.dataLo, true)
      dv.setInt32(base + 12, reg.dataHi, true)
      n++
    }
    return n
  }

  // Emscripten's own `env.__syscall_*` ABI, the layer its libc (as opposed to a plain `wasm32-wasip1`
  // target's) actually calls for file I/O -- present alongside `wasi_snapshot_preview1` in a normal
  // (non-STANDALONE_WASM) `emcc` build. Verified against a real `emcc` 6.0.9 build's own JS runtime
  // (`src/lib/libsyscall.js` in the emscripten install) rather than guessed: signatures, the varargs
  // convention (the last param is a pointer into wasm memory holding packed i32 extras, read one at a
  // time and advanced -- `syscallGetVarargI`) and the `struct stat` layout (offsets confirmed by
  // compiling and running a small `offsetof` probe with the same `emcc`) all come from there. These
  // calls use real fds directly, the same integer space `open()` returns into -- no wasi-fd remapping
  // needed, unlike the `wasi_snapshot_preview1` side above. Sockets and `fcntl` locking/duplication
  // beyond `F_DUPFD` are not implemented; they answer ENOSYS. `epoll` is implemented for real (see
  // `doEpollWait` above): emscripten's own `libepoll.js` derives every epoll readiness question from
  // the virtual filesystem's generic per-fd poll handler, not from sockets specifically, so it works
  // here against the same real `poll(2)` syscall `poll_oneoff` already uses for pipes/tty.
  const AT_FDCWD = -100
  const dirPaths = new Map() // real fd -> path, populated by openat so a later ...at(dirfd, ...) resolves
  // `getdents` answers with a whole listing every time, so each directory fd needs its own read position
  // (entries already handed out); without it a `readdir` loop never sees the end of the directory.
  const dirPos = new Map()

  const guardLinux = (fn) => {
    try {
      return fn() ?? ESUCCESS
    } catch (error) {
      if (error instanceof ProcExit) throw error
      return -(SYSCALL_ERRNO[error?.code] ?? SYSCALL_ERRNO.EIO)
    }
  }

  function writeTm(tmPtr, d, utc = false) {
    const dv = new DataView(getMemory().buffer)
    const start = utc ? new Date(Date.UTC(d.getUTCFullYear(), 0, 1)) : new Date(d.getFullYear(), 0, 1)
    const fields = utc
      ? [d.getUTCSeconds(), d.getUTCMinutes(), d.getUTCHours(), d.getUTCDate(), d.getUTCMonth(), d.getUTCFullYear() - 1900, d.getUTCDay(),
        Math.floor((d - start) / 86400000), 0, 0, 0]
      : [d.getSeconds(), d.getMinutes(), d.getHours(), d.getDate(), d.getMonth(), d.getFullYear() - 1900, d.getDay(),
        Math.floor((d - start) / 86400000), 0, -d.getTimezoneOffset() * 60, 0]
    fields.forEach((v, i) => dv.setInt32(tmPtr + i * 4, v, true))
  }

  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
  const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

  /** `strptime(3)` in the C locale: the conversions people use (dates, times, names, zone offsets). Returns the
   * pointer past what it read, or 0 when the input does not match; only the fields it parsed are written. */
  function strptime(bufPtr, format, tmPtr) {
    const text = readCString(bufPtr)
    const dv = new DataView(getMemory().buffer)
    const tm = {}
    let pos = 0
    let pm
    let hour12
    const number = (min, max, digits) => {
      const match = new RegExp(`^[0-9]{1,${digits}}`).exec(text.slice(pos))
      if (!match) return undefined
      const value = Number(match[0])
      if (value < min || value > max) return undefined
      pos += match[0].length
      return value
    }
    const name = (names) => {
      const rest = text.slice(pos).toLowerCase()
      for (let i = 0; i < names.length; i++) {
        for (const candidate of [names[i], names[i].slice(0, 3)]) {
          if (rest.startsWith(candidate)) { pos += candidate.length; return i }
        }
      }
      return undefined
    }
    const run = (spec) => {
      for (let i = 0; i < spec.length; i++) {
        const c = spec[i]
        if (/\s/.test(c)) { while (/\s/.test(text[pos] ?? '')) pos++; continue }
        if (c !== '%') { if (text[pos] !== c) return false; pos++; continue }
        let conv = spec[++i]
        if (conv === 'E' || conv === 'O') conv = spec[++i]
        let value
        switch (conv) {
          case '%': if (text[pos] !== '%') return false; pos++; break
          case 'n': case 't': while (/\s/.test(text[pos] ?? '')) pos++; break
          case 'Y': { const sign = text[pos] === '-' ? (pos++, -1) : 1; if ((value = number(0, 9999, 4)) === undefined) return false; tm.year = sign * value - 1900; break }
          case 'y': if ((value = number(0, 99, 2)) === undefined) return false; tm.year = value < 69 ? value + 100 : value; break
          case 'C': if ((value = number(0, 99, 2)) === undefined) return false; tm.century = value; break
          case 'm': if ((value = number(1, 12, 2)) === undefined) return false; tm.mon = value - 1; break
          case 'd': case 'e': while (text[pos] === ' ') pos++; if ((value = number(1, 31, 2)) === undefined) return false; tm.mday = value; break
          case 'H': case 'k': while (text[pos] === ' ') pos++; if ((value = number(0, 23, 2)) === undefined) return false; tm.hour = value; break
          case 'I': case 'l': while (text[pos] === ' ') pos++; if ((value = number(1, 12, 2)) === undefined) return false; hour12 = value % 12; break
          case 'M': if ((value = number(0, 59, 2)) === undefined) return false; tm.min = value; break
          case 'S': if ((value = number(0, 61, 2)) === undefined) return false; tm.sec = value; break
          case 'j': if ((value = number(1, 366, 3)) === undefined) return false; tm.yday = value - 1; break
          case 'b': case 'B': case 'h': if ((value = name(MONTHS)) === undefined) return false; tm.mon = value; break
          case 'a': case 'A': if ((value = name(WEEKDAYS)) === undefined) return false; tm.wday = value; break
          case 'p': case 'P': { const m = /^(am|pm)/i.exec(text.slice(pos)); if (!m) return false; pm = m[0].toLowerCase() === 'pm'; pos += 2; break }
          case 'T': if (!run('%H:%M:%S')) return false; break
          case 'R': if (!run('%H:%M')) return false; break
          case 'D': if (!run('%m/%d/%y')) return false; break
          case 'F': if (!run('%Y-%m-%d')) return false; break
          case 'r': if (!run('%I:%M:%S %p')) return false; break
          case 'c': if (!run('%a %b %e %H:%M:%S %Y')) return false; break
          case 'x': if (!run('%m/%d/%y')) return false; break
          case 'X': if (!run('%H:%M:%S')) return false; break
          case 'Z': while (/[A-Za-z]/.test(text[pos] ?? '')) pos++; break
          case 'z': {
            if (text[pos] === 'Z') { pos++; tm.gmtoff = 0; break }
            const m = /^([+-])([0-9]{2}):?([0-9]{2})?/.exec(text.slice(pos))
            if (!m) return false
            pos += m[0].length
            tm.gmtoff = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 3600 + Number(m[3] ?? 0) * 60)
            break
          }
          case 's': { const m = /^[0-9]+/.exec(text.slice(pos)); if (!m) return false; pos += m[0].length; const d = new Date(Number(m[0]) * 1000); Object.assign(tm, { sec: d.getSeconds(), min: d.getMinutes(), hour: d.getHours(), mday: d.getDate(), mon: d.getMonth(), year: d.getFullYear() - 1900 }); break }
          default: return false
        }
      }
      return true
    }
    if (!run(format)) return 0
    if (hour12 !== undefined) tm.hour = hour12 + (pm ? 12 : 0)
    if (tm.century !== undefined && tm.year === undefined) tm.year = tm.century * 100 - 1900
    const fields = { sec: 0, min: 1, hour: 2, mday: 3, mon: 4, year: 5, wday: 6, yday: 7, gmtoff: 9 }
    for (const [key, index] of Object.entries(fields)) if (tm[key] !== undefined) dv.setInt32(tmPtr + index * 4, tm[key], true)
    // the weekday and day of the year follow from a full date
    const year = tm.year ?? dv.getInt32(tmPtr + 20, true)
    const mon = tm.mon ?? (tm.mday !== undefined ? dv.getInt32(tmPtr + 16, true) : undefined)
    if (mon !== undefined && tm.mday !== undefined) {
      const date = new Date(Date.UTC(year + 1900, mon, tm.mday))
      dv.setInt32(tmPtr + 24, date.getUTCDay(), true)
      dv.setInt32(tmPtr + 28, Math.floor((date - Date.UTC(year + 1900, 0, 1)) / 86400000), true)
    }
    return bufPtr + pos
  }

  function doPoll(fdsPtr, nfds, timeout) {
    const dv = view()
    const slots = []
    for (let i = 0; i < nfds; i++) {
      const fd = dv.getInt32(fdsPtr + i * 8, true)
      if (fd < 0) { dv.setInt16(fdsPtr + i * 8 + 6, 0, true); continue }
      slots.push({ i, fd: entryOf(fd)?.fd ?? fd, events: dv.getInt16(fdsPtr + i * 8 + 4, true) })
    }
    let revents = []
    if (slots.length) revents = pollFds(slots.map(({ fd, events }) => ({ fd, events })), timeout)
    else sleepMs(timeout)
    const after = view()
    let ready = 0
    slots.forEach((slot, n) => {
      after.setInt16(fdsPtr + slot.i * 8 + 6, revents[n], true)
      if (revents[n]) ready++
    })
    return ready
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

  // Loopback POSIX sockets (`__syscall_socket` and friends, below): real internet sockets don't
  // exist in a browser (no raw TCP/UDP API at all), so `env.__syscall_connect` only ever succeeds
  // against `127.0.0.1`/`::1`/a `AF_UNIX` path -- anything else answers a real `ECONNREFUSED`/
  // `ENETUNREACH`, exactly what a sandboxed Linux process with no route to that address would see,
  // not a crash or a silent lie. `main-thread-syscalls.ts`'s own `net_bind`/`net_listen`/
  // `net_connect`/`net_accept` (its doc comment has the shared-address-namespace half of this) own
  // matching listeners across processes; everything else (the fd itself, reads, writes, close,
  // getsockname/getpeername, setsockopt/getsockopt, shutdown) is answered entirely locally here,
  // against the real fds those four syscalls hand back -- no further main-thread round trip needed
  // once a connection exists. Real network I/O for an ecmaOS program is unchanged: `kernel.sockets`
  // (`sockets_connect` et al.) over `WebSocket`/`WebTransport`, not this.
  const AF_UNIX = 1
  const AF_INET = 2
  const SOCK_STREAM_MASK = 0xff // socket()'s type also carries SOCK_NONBLOCK/SOCK_CLOEXEC as high bits
  const SOCK_STREAM = 1

  const sockets = new Map() // synthetic fd -> { family, key, bound, listening, connected }

  /** Calls a `main-thread-syscalls.ts` custom syscall that answers through a scratch file (JSON),
   * the same bridge `/bin/node`'s `lib/scratch.mjs` gives coreutils -- reimplemented locally with
   * the real fs syscalls this file already imports, since `/bin/wali` runs raw WASM, not JS, and
   * has no `globalThis.ecmaosSyscalls`. */
  function callMainThread(name, ...args) {
    const path = `/tmp/.${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    syscall(name, ...args, path)
    const fd = open(path, O_RDONLY)
    const chunks = []
    try {
      while (true) {
        const buf = new Uint8Array(65536)
        const n = read(fd, buf, -1)
        if (n <= 0) break
        chunks.push(buf.subarray(0, n))
        if (n < 65536) break
      }
    } finally {
      close(fd)
      unlink(path)
    }
    const total = chunks.reduce((sum, c) => sum + c.length, 0)
    const out = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length }
    return JSON.parse(decoder.decode(out))
  }

  /** `struct sockaddr_un`/`struct sockaddr_in`, confirmed by compiling and running a real
   * `offsetof()` probe with the installed emcc 6.0.9 (same methodology as `struct stat`): family
   * (u16) at offset 0 for both; `sockaddr_in`'s port (u16, network/big-endian byte order) at 2,
   * its 4-byte address at 4; `sockaddr_un`'s NUL-terminated path starts at 2. */
  function readSockaddr(ptr) {
    const dv = view()
    const family = dv.getUint16(ptr, true)
    if (family === AF_UNIX) return { family, path: readCString(ptr + 2) }
    if (family === AF_INET) {
      const port = dv.getUint16(ptr + 2, false)
      const b = bytes()
      return { family, port, addr: `${b[ptr + 4]}.${b[ptr + 5]}.${b[ptr + 6]}.${b[ptr + 7]}` }
    }
    return { family }
  }

  function writeSockaddrIn(ptr, addr, port) {
    const dv = view()
    dv.setUint16(ptr, AF_INET, true)
    dv.setUint16(ptr + 2, port, false)
    const parts = (addr || '127.0.0.1').split('.').map(Number)
    const b = bytes()
    for (let i = 0; i < 4; i++) b[ptr + 4 + i] = parts[i] || 0
  }

  /** `addrlenPtr` is a real in/out `socklen_t*` (`accept4`/`getsockname`/`getpeername`) -- writes
   * back how many bytes were actually available, same as the real syscalls this answers for. */
  function writeSockaddrResult(addrPtr, addrlenPtr, addr, port) {
    if (!addrPtr) return
    writeSockaddrIn(addrPtr, addr, port)
    if (addrlenPtr) view().setUint32(addrlenPtr, 16, true)
  }

  function socketErrno(error) {
    if (typeof error === 'string') return -(SYSCALL_ERRNO[error] ?? SYSCALL_ERRNO.EIO)
    return -(SYSCALL_ERRNO[error?.code] ?? SYSCALL_ERRNO.EIO)
  }

  /** Whether `fd` is a socket, and if so its real backing fd for `direction` -- used by
   * `fd_read`/`fd_write`/etc (the WASI ABI, which is what a socket's read()/write() actually go
   * through, same as a plain file's) so they redirect transparently instead of trying `entryOf`'s
   * generic real-fd fallback on a purely synthetic number. Returns WASI `EBADF` (this file's own
   * `EBADF` constant, not `SYSCALL_ERRNO`'s -- `fd_read`/`fd_write` are wasi_snapshot_preview1 calls)
   * for a socket that exists but isn't connected yet. */
  function socketRealFd(fd, direction) {
    const sock = sockets.get(fd)
    if (!sock) return { isSocket: false }
    if (!sock.connected) return { isSocket: true, error: EBADF }
    return { isSocket: true, fd: direction === 'write' ? sock.writeFd : sock.readFd }
  }

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
      const entries = [...getdents(fd)]
      const out = bytes()
      let offset = 0
      let index = dirPos.get(fd) ?? 0
      for (; index < entries.length; index++) {
        const item = entries[index]
        const name = encoder.encode(item.name)
        const reclen = (19 + name.length + 1 + 7) & ~7 // ino(8) off(8) reclen(2) type(1) + name + NUL, 8-aligned
        if (offset + reclen > count) break
        const dv = view()
        dv.setBigUint64(dirp + offset, BigInt(item.ino ?? 0), true)
        dv.setBigUint64(dirp + offset + 8, BigInt(index + 1), true)
        dv.setUint16(dirp + offset + 16, reclen, true)
        out[dirp + offset + 18] = item.type ?? 0
        out.set(name, dirp + offset + 19)
        out.fill(0, dirp + offset + 19 + name.length, dirp + offset + reclen)
        offset += reclen
      }
      if (offset === 0 && index < entries.length) return -SYSCALL_ERRNO.EINVAL
      dirPos.set(fd, index)
      return offset
    }),
    __syscall_fcntl64: (fd, cmd, varargsPtr) => guardLinux(() => {
      const F_DUPFD = 0, F_GETFD = 1, F_SETFD = 2, F_GETFL = 3, F_SETFL = 4
      if (cmd === F_DUPFD) return dup2(fd, varargI(varargsPtr, 0))
      if (cmd === F_GETFD || cmd === F_GETFL) return 0
      if (cmd === F_SETFD || cmd === F_SETFL) return 0
      // Advisory record locks (SQLite takes them around every transaction). Each program here runs alone as
      // far as its own locks go: a lock is always granted and a query finds nothing holding one. Two programs
      // writing the same file at once are not kept apart.
      const F_GETLK = 5, F_SETLK = 6, F_SETLKW = 7, F_GETLK64 = 12, F_SETLK64 = 13, F_SETLKW64 = 14
      if (cmd === F_SETLK || cmd === F_SETLKW || cmd === F_SETLK64 || cmd === F_SETLKW64) return 0
      if (cmd === F_GETLK || cmd === F_GETLK64) { view().setInt16(varargI(varargsPtr, 0), 2, true); return 0 } // l_type = F_UNLCK
      throw { code: 'ENOSYS' }
    }),
    __syscall_openat: (dirfd, pathPtr, flags, varargsPtr) => guardLinux(() => {
      const path = resolveAt(dirfd, pathPtr)
      const mode = varargsPtr ? varargI(varargsPtr, 0) : 0o644
      const fd = open(path, wasiOflagsFromLinux(flags), mode)
      dirPos.delete(fd)
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
    // The terminal ioctls a full-screen program needs. `struct termios` here is the kernel's
    // (iflag, oflag, cflag, lflag, line, cc[19]); musl hands `TCGETS` a larger struct but only the
    // kernel's first 36 bytes are ever read or written.
    __syscall_ioctl: (fd, request, varargsPtr) => guardLinux(() => {
      const TCGETS = 0x5401, TCSETS = 0x5402, TCSETSW = 0x5403, TCSETSF = 0x5404, TIOCGWINSZ = 0x5413, TIOCSWINSZ = 0x5414
      const real = entryOf(fd)?.fd ?? fd
      const ptr = varargsPtr ? varargI(varargsPtr, 0) : 0
      const dv = view()
      switch (request) {
        case TCGETS: {
          const t = tcgetattr(real)
          dv.setUint32(ptr, t.iflag, true)
          dv.setUint32(ptr + 4, t.oflag, true)
          dv.setUint32(ptr + 8, t.cflag, true)
          dv.setUint32(ptr + 12, t.lflag, true)
          dv.setUint8(ptr + 16, t.line)
          for (let i = 0; i < 19; i++) dv.setUint8(ptr + 17 + i, t.cc[i])
          return ESUCCESS
        }
        case TCSETS:
        case TCSETSW:
        case TCSETSF: {
          const cc = []
          for (let i = 0; i < 19; i++) cc.push(dv.getUint8(ptr + 17 + i))
          tcsetattr(real, {
            iflag: dv.getUint32(ptr, true), oflag: dv.getUint32(ptr + 4, true),
            cflag: dv.getUint32(ptr + 8, true), lflag: dv.getUint32(ptr + 12, true),
            line: dv.getUint8(ptr + 16), cc,
          })
          return ESUCCESS
        }
        case TIOCGWINSZ: {
          const w = winsize(real)
          dv.setUint16(ptr, w.row, true)
          dv.setUint16(ptr + 2, w.col, true)
          dv.setUint16(ptr + 4, w.xpixel, true)
          dv.setUint16(ptr + 6, w.ypixel, true)
          return ESUCCESS
        }
        case TIOCSWINSZ: return ESUCCESS
        default: throw { code: 'ENOTTY' }
      }
    }),
    // The few non-syscall imports an ordinary emcc build leaves for its JS glue: process exit and
    // abort, heap growth, signal-handler dispatch, and the `system()` hook (there is no shell to run).
    exit: (code) => { throw new ProcExit(code) },
    _abort_js: () => { throw new Error('abort() called') },
    _emscripten_runtime_keepalive_clear: () => {},
    emscripten_resize_heap: (requested) => {
      try {
        const memory = getMemory()
        memory.grow(Math.ceil((requested - memory.buffer.byteLength) / 65536))
        return 1
      } catch {
        return 0
      }
    },
    __call_sighandler: (handler, signal) => { getTable()?.get(handler)(signal) },
    // `system(3)`, what Vim's `:!`, `:r !` and filters use: `/bin/ecmash -c command` as a child that has the
    // terminal while it runs, so `^C` reaches it and not the program waiting. The status is wait(2)'s.
    _emscripten_system: (commandPtr) => {
      if (!commandPtr) return 1 // is there a shell
      const command = readCString(commandPtr)
      try {
        const pid = syscall('proc_spawn', '/bin/ecmash', JSON.stringify(['ecmash', '-c', command]), getcwd(), JSON.stringify({ env: environ() }))
        let foregrounded = true
        try { syscall('proc_tcsetpgrp', pid) } catch { foregrounded = false }
        try {
          return (syscall('proc_wait', pid) & 0xff) << 8
        } finally {
          if (foregrounded) { try { syscall('proc_tcsetpgrp', getpid()) } catch { /* the terminal went away */ } }
        }
      } catch (error) {
        if (error instanceof ProcExit) throw error
        return -1
      }
    },
    // Clocks, time zone and assertions. The zone is the browser's, as `localtime` reports it.
    emscripten_get_now: () => performance.now(),
    emscripten_date_now: () => Date.now(),
    emscripten_get_heap_max: () => 2147483648,
    __assert_fail: (cond, file, line) => {
      const read = (ptr) => { const m = new Uint8Array(getMemory().buffer); let e = ptr; while (m[e]) e++; return new TextDecoder().decode(m.subarray(ptr, e)) }
      throw new Error(`assertion failed: ${read(cond)} (${read(file)}:${line})`)
    },
    _tzset_js: (timezonePtr, daylightPtr, stdNamePtr, dstNamePtr) => {
      const dv = new DataView(getMemory().buffer)
      dv.setInt32(timezonePtr, new Date().getTimezoneOffset() * 60, true)
      dv.setInt32(daylightPtr, 0, true)
      const zone = new Date().toLocaleTimeString('en', { timeZoneName: 'short' }).split(' ').pop() ?? 'UTC'
      for (const ptr of [stdNamePtr, dstNamePtr]) bytes().set(encoder.encode(`${zone.slice(0, 15)}\0`), ptr)
    },
    // struct tm: sec, min, hour, mday, mon, year, wday, yday, isdst, gmtoff, zone (11 ints on wasm32)
    _localtime_js: (time, tmPtr) => { writeTm(tmPtr, new Date(Number(time) * 1000)); return 0 },
    _gmtime_js: (time, tmPtr) => { writeTm(tmPtr, new Date(Number(time) * 1000), true); return 0 },
    _timegm_js: (tmPtr) => {
      const dv = new DataView(getMemory().buffer)
      const f = (i) => dv.getInt32(tmPtr + i * 4, true)
      const date = new Date(Date.UTC(f(5) + 1900, f(4), f(3), f(2), f(1), f(0)))
      writeTm(tmPtr, date, true)
      return BigInt(Math.floor(date.getTime() / 1000))
    },
    _mktime_js: (tmPtr) => {
      const dv = new DataView(getMemory().buffer)
      const f = (i) => dv.getInt32(tmPtr + i * 4, true)
      const date = new Date(f(5) + 1900, f(4), f(3), f(2), f(1), f(0))
      writeTm(tmPtr, date)
      return BigInt(Math.floor(date.getTime() / 1000))
    },
    // No timers and no signal delivery: setitimer(2) accepts and never fires.
    _setitimer_js: () => 0,
    // Memory-mapped files are not provided: `mmap` fails, as it does for a filesystem that cannot map (SQLite, which
    // only maps when asked to, then reads and writes the file itself).
    _mmap_js: () => -SYSCALL_ERRNO.ENOSYS,
    _munmap_js: () => -SYSCALL_ERRNO.ENOSYS,
    strptime: (bufPtr, formatPtr, tmPtr) => strptime(bufPtr, readCString(formatPtr), tmPtr),
    // dup(2) and pipe2(2) are only reached when Vim starts a child process, which cannot happen here.
    __syscall_dup: () => -SYSCALL_ERRNO.ENOSYS,
    __syscall_pipe2: () => -SYSCALL_ERRNO.ENOSYS,
    // poll(2): `struct pollfd` is { int fd; short events; short revents }.
    __syscall_poll: (fdsPtr, nfds, timeout) => guardLinux(() => doPoll(fdsPtr, nfds, timeout)),
    __syscall_poll_nonblocking: (fdsPtr, nfds) => guardLinux(() => doPoll(fdsPtr, nfds, 0)),
    __syscall_epoll_create1: (flags) => {
      if (flags & ~EPOLL_CLOEXEC) return -SYSCALL_ERRNO.EINVAL
      const epfd = nextFd++
      epollInstances.set(epfd, { interests: new Map() })
      return epfd
    },
    __syscall_epoll_ctl: (epfd, op, fd, evPtr) => {
      const inst = epollInstances.get(epfd)
      if (!inst) return -SYSCALL_ERRNO.EBADF
      if (op === EPOLL_CTL_DEL) {
        if (!inst.interests.has(fd)) return -SYSCALL_ERRNO.ENOENT
        inst.interests.delete(fd)
        return ESUCCESS
      }
      if (op !== EPOLL_CTL_ADD && op !== EPOLL_CTL_MOD) return -SYSCALL_ERRNO.EINVAL
      const has = inst.interests.has(fd)
      if (op === EPOLL_CTL_ADD && has) return -SYSCALL_ERRNO.EEXIST
      if (op === EPOLL_CTL_MOD && !has) return -SYSCALL_ERRNO.ENOENT
      const dv = view()
      inst.interests.set(fd, { events: dv.getUint32(evPtr, true), dataLo: dv.getInt32(evPtr + 8, true), dataHi: dv.getInt32(evPtr + 12, true) })
      return ESUCCESS
    },
    __syscall_epoll_pwait: (epfd, evPtr, maxevents, timeout, _sigmask, _sigsetsize) => {
      const inst = epollInstances.get(epfd)
      if (!inst) return -SYSCALL_ERRNO.EBADF
      if (maxevents <= 0) return -SYSCALL_ERRNO.EINVAL
      return doEpollWait(inst, evPtr, maxevents, timeout)
    },
    __syscall_epoll_pwait_nonblocking: (epfd, evPtr, maxevents) => {
      const inst = epollInstances.get(epfd)
      if (!inst) return -SYSCALL_ERRNO.EBADF
      if (maxevents <= 0) return -SYSCALL_ERRNO.EINVAL
      return doEpollWait(inst, evPtr, maxevents, 0)
    },

    __syscall_socket: (domain, type, _protocol) => {
      if (domain !== AF_UNIX && domain !== AF_INET) return -SYSCALL_ERRNO.EAFNOSUPPORT
      if ((type & SOCK_STREAM_MASK) !== SOCK_STREAM) return -SYSCALL_ERRNO.EPROTONOSUPPORT
      const fd = nextFd++
      sockets.set(fd, { family: domain, key: null, bound: false, listening: false, connected: false })
      return fd
    },
    __syscall_bind: (fd, addrPtr, _addrlen) => {
      const sock = sockets.get(fd)
      if (!sock) return -SYSCALL_ERRNO.ENOTSOCK
      const sa = readSockaddr(addrPtr)
      let result
      if (sa.family === AF_UNIX) result = callMainThread('net_bind', 'unix', sa.path, 0)
      else if (sa.family === AF_INET) result = callMainThread('net_bind', 'inet', sa.addr, sa.port)
      else return -SYSCALL_ERRNO.EAFNOSUPPORT
      if (result.error) return socketErrno(result.error)
      sock.bound = true
      sock.key = result.key
      if (result.port) sock.port = result.port
      return ESUCCESS
    },
    __syscall_listen: (fd, backlog) => {
      const sock = sockets.get(fd)
      if (!sock || !sock.bound) return -SYSCALL_ERRNO.ENOTSOCK
      const result = callMainThread('net_listen', sock.key, backlog)
      if (result.error) return socketErrno(result.error)
      sock.listening = true
      return ESUCCESS
    },
    __syscall_connect: (fd, addrPtr, _addrlen) => {
      const sock = sockets.get(fd)
      if (!sock) return -SYSCALL_ERRNO.ENOTSOCK
      if (sock.connected) return -SYSCALL_ERRNO.EISCONN
      const sa = readSockaddr(addrPtr)
      let key
      if (sa.family === AF_UNIX) key = `unix:${sa.path}`
      else if (sa.family === AF_INET) key = `inet:127.0.0.1:${sa.port}`
      else return -SYSCALL_ERRNO.EAFNOSUPPORT
      const result = callMainThread('net_connect', key)
      if (result.error) return socketErrno(result.error)
      sock.connected = true
      sock.peerKey = key
      sock.readFd = result.fd
      sock.writeFd = result.writeFd
      return ESUCCESS
    },
    // `flags` may carry SOCK_NONBLOCK: an empty accept queue then answers EAGAIN immediately
    // instead of the worker polling (`net_accept`'s own doc comment has the main-thread half).
    // A blocking accept4 polls `net_accept` on a short interval until a connection lands or this
    // worker is killed -- interruptible the same way every other wait in this file is: `kill`/`^C`
    // tears the worker down regardless of what JS statement happens to be running.
    __syscall_accept4: (fd, addrPtr, addrlenPtr, flags) => {
      const sock = sockets.get(fd)
      if (!sock || !sock.listening) return -SYSCALL_ERRNO.ENOTSOCK
      const nonblock = flags & 0x800 ? 1 : 0
      while (true) {
        const result = callMainThread('net_accept', sock.key, nonblock)
        if (result.error) return socketErrno(result.error)
        if (result.pending) { sleepMs(50); continue }
        const newFd = nextFd++
        sockets.set(newFd, { family: sock.family, key: null, bound: false, listening: false, connected: true, readFd: result.fd, writeFd: result.writeFd, peerKey: result.peerKey })
        writeSockaddrResult(addrPtr, addrlenPtr, '127.0.0.1', 0)
        return newFd
      }
    },
    __syscall_getsockname: (fd, addrPtr, addrlenPtr) => {
      const sock = sockets.get(fd)
      if (!sock) return -SYSCALL_ERRNO.ENOTSOCK
      writeSockaddrResult(addrPtr, addrlenPtr, '127.0.0.1', sock.port ?? 0)
      return ESUCCESS
    },
    __syscall_getpeername: (fd, addrPtr, addrlenPtr) => {
      const sock = sockets.get(fd)
      if (!sock) return -SYSCALL_ERRNO.ENOTSOCK
      if (!sock.connected) return -SYSCALL_ERRNO.ENOTCONN
      writeSockaddrResult(addrPtr, addrlenPtr, '127.0.0.1', 0)
      return ESUCCESS
    },
    __syscall_shutdown: (fd, how) => {
      const sock = sockets.get(fd)
      if (!sock || !sock.connected) return -SYSCALL_ERRNO.ENOTCONN
      return guardLinux(() => {
        if (how !== 0 /* SHUT_RD */) close(sock.writeFd) // SHUT_WR or SHUT_RDWR
      })
    },
    __syscall_sendto: (fd, buf, len, _flags, _addrPtr, _addrlen) => guardLinux(() => {
      const sock = sockets.get(fd)
      if (!sock) throw { code: 'ENOTSOCK' }
      if (!sock.connected) throw { code: 'ENOTCONN' }
      return write(sock.writeFd, bytes().subarray(buf, buf + len))
    }),
    __syscall_recvfrom: (fd, buf, len, _flags, _addrPtr, _addrlen) => guardLinux(() => {
      const sock = sockets.get(fd)
      if (!sock) throw { code: 'ENOTSOCK' }
      if (!sock.connected) throw { code: 'ENOTCONN' }
      const chunk = new Uint8Array(len)
      const n = read(sock.readFd, chunk, -1)
      bytes().set(chunk.subarray(0, Math.max(n, 0)), buf)
      return Math.max(n, 0)
    }),
    // No real socket-level options exist for a loopback pipe pair -- accepted as a harmless no-op
    // rather than failing a program that merely sets e.g. SO_REUSEADDR/TCP_NODELAY defensively.
    __syscall_setsockopt: () => ESUCCESS,
    __syscall_getsockopt: (fd, _level, _optname, optvalPtr, optlenPtr) => {
      if (!sockets.has(fd)) return -SYSCALL_ERRNO.ENOTSOCK
      if (optvalPtr) view().setInt32(optvalPtr, 0, true)
      if (optlenPtr) view().setUint32(optlenPtr, 4, true)
      return ESUCCESS
    },
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

// The signals a program can catch here. SIGWINCH's default is to be ignored; the others end the program.
const CATCHABLE_SIGNALS = [1, 2, 10, 12, 15, 28]
const SIGWINCH = 28

/**
 * A module that exports `ecmaos_signal(sig)` (see `wasm/vim/libc-gaps.c`) gets the kernel's signals run
 * through the handlers it set with `signal()`/`sigaction()`. The kernel raises them while the worker is in a
 * blocking syscall (Vim waiting for a key), and upstream runs handlers registered with `on_signal` as that
 * syscall returns -- which is inside the module's own import call, so calling back into it is safe. A
 * signal the program set no handler for does what the default does. Registering a handler also tells the
 * kernel to stop taking the default action, so this is done only for modules that can answer.
 */
function deliverSignals(instance, Exit) {
  const deliver = instance.exports.ecmaos_signal
  if (typeof deliver !== 'function') return
  for (const signal of CATCHABLE_SIGNALS) {
    on_signal(signal, () => {
      if (deliver(signal)) return
      if (signal !== SIGWINCH) throw new Exit(128 + signal)
    })
  }
}

/** Runs a preview1 or ordinary-`emcc` module to completion and returns its exit code. */
export async function runPreview1(source) {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source)
  const module = await WebAssembly.compile(source)
  let memory
  const { imports, ProcExit: Exit, args } = createPreview1(() => memory, () => instance?.exports.__indirect_function_table)
  const memoryImport = detectMemoryImport(bytes)
  if (memoryImport) {
    // The module wants its memory handed in rather than exported -- create it to the module's own
    // declared limits and answer the import with it, same as any other host would.
    memory = new WebAssembly.Memory(memoryImport.maximum !== undefined
      ? { initial: memoryImport.initial, maximum: memoryImport.maximum }
      : { initial: memoryImport.initial })
    imports[memoryImport.module] = { ...(imports[memoryImport.module] ?? {}), [memoryImport.name]: memory }
  }
  let instance
  instance = await WebAssembly.instantiate(module, imports)
  deliverSignals(instance, Exit)
  memory = memory ?? instance.exports.memory
  if (!memory) throw new Error('wasi: the module does not export or import its memory')
  // A `-sSTANDALONE_WASM` build exports `__main_argc_argv`; an ordinary one exports plain `main`.
  const { _start, _initialize, __wasm_call_ctors, __funcs_on_exit, fflush } = instance.exports
  const __main_argc_argv = instance.exports.__main_argc_argv ?? instance.exports.main
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
      throw new Error('wasi: the module exports none of _start, _initialize, __main_argc_argv, main')
    }
    return code
  } catch (error) {
    if (error instanceof Exit) return error.code
    throw error
  }
}
