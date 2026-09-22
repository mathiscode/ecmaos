/**
 * WASI preview1 for `/bin/wali`: a translation of `wasi_snapshot_preview1` onto the real
 * `@zenfs/linux` syscalls, so a plain `wasm32-wasip1` program runs as a real worker-hosted Process
 * (killable, on a real pid, with real pipes and a real tty) instead of on the main thread inside
 * `Kernel.executeWasm`, where a tight loop freezes the tab and `^C` cannot reach it.
 *
 * Scope is deliberately the portable core of preview1: args/environ, clocks, random, the fd and
 * path calls, `poll_oneoff` and `proc_exit`. Sockets answer ENOSYS. Modules that need more (asyncify,
 * an imported `env` memory, emscripten `__syscall_*`, preview2 components) are not routed here; see
 * `canRunPreview1InWorker` in `tree/wasm.ts`.
 *
 * Every wasi fd is its own number: 0-2 are the process's real stdio fds, 3 is a preopen of `/` and
 * 4 a preopen of `.` (the cwd at start), and files opened after that get the next free number
 * mapped onto a real fd, so a wasi program never sees, or can close, a descriptor the loader uses.
 */

import { open, read, write, close, lseek, ftruncate, fsync, fdatasync, stat, lstat, fstat, getdents, mkdir, rmdir, unlink, rename, symlink, readlink, getcwd } from '@zenfs/linux/uapi/fs'
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

  const fds = new Map([
    [0, { fd: 0, path: null, dir: false }],
    [1, { fd: 1, path: null, dir: false }],
    [2, { fd: 2, path: null, dir: false }],
    [3, { fd: null, path: '/', dir: true, preopen: '/' }],
    [4, { fd: null, path: cwd, dir: true, preopen: '.' }],
  ])
  let nextFd = 5

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

  const entryOf = (fd) => fds.get(fd)

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

  return { imports: { wasi_snapshot_preview1: wasi }, ProcExit }
}

/** Runs a preview1 module to completion and returns its exit code. */
export async function runPreview1(source) {
  const module = await WebAssembly.compile(source)
  let memory
  const { imports, ProcExit: Exit } = createPreview1(() => memory)
  const instance = await WebAssembly.instantiate(module, imports)
  memory = instance.exports.memory
  if (!memory) throw new Error('wasi: the module does not export its memory')
  try {
    if (typeof instance.exports._start === 'function') instance.exports._start()
    else if (typeof instance.exports._initialize === 'function') instance.exports._initialize()
    return 0
  } catch (error) {
    if (error instanceof Exit) return error.code
    throw error
  }
}
