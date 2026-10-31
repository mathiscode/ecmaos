/**
 * What the two WASI hosts share: `wasip1.mjs` (`wasi_snapshot_preview1`) and `emscripten.mjs` (the `env.__syscall_*`
 * names an `emcc` build adds). Errno numbering and mapping, the Linux open flags, file types, `poll(2)` and sleeping.
 */
import { syscall, copyOut } from '@zenfs/linux/uapi/base'
import { stat, getdents, open, read, close, unlink } from '@zenfs/linux/uapi/fs'
import { Errno } from 'kerium'

export const ESUCCESS = 0
export const EBADF = 8
export const EIO = 29
export const ENOSYS = 52

// errno name (what a failed syscall throws as `error.code`) -> the WASI errno number
export const ERRNO = {
  E2BIG: 1, EACCES: 2, EADDRINUSE: 3, EADDRNOTAVAIL: 4, EAGAIN: 6, EBADF: 8, EBUSY: 10, ECONNREFUSED: 14,
  EEXIST: 20, EFBIG: 22, EINTR: 27, EINVAL: 28, EIO: 29, EISDIR: 31, ELOOP: 32, EMFILE: 33, ENAMETOOLONG: 37,
  ENODEV: 43, ENOENT: 44, ENOMEM: 48, ENOSPC: 51, ENOSYS: 52, ENOTDIR: 54, ENOTEMPTY: 55, ENOTSUP: 58,
  ENOTTY: 59, ENXIO: 60, EPERM: 63, EPIPE: 64, ERANGE: 68, EROFS: 69, ESPIPE: 70, EXDEV: 75,
}

// `env.__syscall_*` returns `-errno` in emscripten's numbering (ENOENT is 44, EACCES is 2), not Linux's. These extend
// `ERRNO` with the names only the socket and epoll calls need.
export const SYSCALL_ERRNO = {
  ...ERRNO,
  ENOTSOCK: 57, ENOPROTOOPT: 50, EPROTONOSUPPORT: 66, EAFNOSUPPORT: 5, EISCONN: 30, ENOTCONN: 53,
  ENETUNREACH: 40, EALREADY: 7, EINPROGRESS: 26, EEXIST: 20, ESRCH: 71,
  ECONNRESET: 15, EHOSTUNREACH: 23, ENOBUFS: 42, ETIMEDOUT: 73, EDESTADDRREQ: 17, EMSGSIZE: 35,
  ECHILD: 12, ENOEXEC: 45,
}

/** A kernel answer (a count, or a negative Linux errno) as an `env.__syscall_*` one */
export const fromLinux = value => value >= 0 ? value : -(SYSCALL_ERRNO[Errno[-value]] ?? SYSCALL_ERRNO.EIO)
export const LINUX_EINTR = 4

// open(2) flags (Linux values)
export const O_RDONLY = 0
export const O_WRONLY = 1
export const O_RDWR = 2
export const O_CREAT = 0x40
export const O_EXCL = 0x80
export const O_TRUNC = 0x200
export const O_APPEND = 0x400
export const O_DIRECTORY = 0x10000
export const O_CLOEXEC = 0x80000

// wasi oflags
export const OFLAGS_CREAT = 1
export const OFLAGS_DIRECTORY = 2
export const OFLAGS_EXCL = 4
export const OFLAGS_TRUNC = 8
// wasi fdflags
export const FDFLAGS_APPEND = 1

export const S_IFMT = 0xf000
export const FILETYPE = { unknown: 0, block: 1, char: 2, dir: 3, file: 4, socket: 6, link: 7 }

export const POLLIN = 0x1
export const POLLOUT = 0x4

// epoll(7) - values from musl's <sys/epoll.h>. EPOLLIN/EPOLLOUT are deliberately the same bits as
// POLLIN/POLLOUT (true on real Linux too), so `pollFds`'s revents can be used as epoll's outgoing
// `events` with no translation.
export const EPOLL_CTL_ADD = 1
export const EPOLL_CTL_DEL = 2
export const EPOLL_CTL_MOD = 3
export const EPOLL_CLOEXEC = 0x80000
// `struct epoll_event` on wasm32: `{ u32 events @0; u64 data @8 }`, 16 bytes, not packed.
export const EPOLL_EVENT_SIZE = 16

export class ProcExit {
  constructor(code) {
    this.code = code
  }
}

export function errnoOf(error) {
  return ERRNO[error?.code] ?? EIO
}

export function filetypeOf(mode) {
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
export function normalize(path) {
  const out = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

/** `poll(2)` on the real fds, returning each one's `revents`; same wrapper `/bin/node` exposes. */
export function pollFds(fds, timeout) {
  syscall('poll', fds, timeout)
  const { view } = copyOut(class { constructor(buffer, offset) { this.view = new DataView(buffer, offset) } })
  return fds.map((_, i) => view.getUint16(i * 2, true))
}

/** A sleep the worker's own termination interrupts (`kill`, `^C`): the wait is on a private buffer. */
export function sleepMs(ms) {
  if (ms <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}


/** Thrown by the stub standing in for an import the host does not provide; `name` is `module.import`. */
export class MissingImport {
  constructor(name) { this.name = name }
}

/**
 * The names of the top-level directories of `/` to preopen under their own name (wasi-libc has no working directory: it
 * makes a path absolute and takes the longest preopen prefix, so `/` and `.` alone would send `/tmp/x` to `<cwd>/tmp/x`).
 * One the working directory also has is left out, so `./lib/x` still means the cwd's `lib`. `rootFd` is `/` opened.
 */
export function rootPreopenNames(cwd, rootFd) {
  const names = []
  for (const { name, type } of getdents(rootFd)) {
    if (name === '.' || name === '..' || (type !== 4 && type !== 10)) continue
    if (cwd !== '/') {
      let shadowed = true
      try { stat(`${cwd}/${name}`) } catch { shadowed = false }
      if (shadowed) continue
    }
    names.push(name)
  }
  return names
}

/**
 * Calls a `main-thread-syscalls.ts` custom syscall that answers through a scratch file (JSON), the same bridge
 * `/bin/node`'s `lib/scratch.mjs` gives coreutils: `/bin/wali` runs raw WASM, not JS, and has no
 * `globalThis.ecmaosSyscalls`.
 */
export function callMainThread(name, ...args) {
  const path = `/tmp/.${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  syscall(name, ...args, path)
  const fd = open(path, 0 /* O_RDONLY */)
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
  return JSON.parse(new TextDecoder().decode(out))
}
