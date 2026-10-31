/**
 * WASI preview1 for `/bin/wali`: `wasi_snapshot_preview1` on the real `@zenfs/linux` syscalls, so a `wasm32-wasip1`
 * program (Rust, Go, wasi-sdk C) runs as a worker-hosted process (killable, with pipes and a tty).
 * Covers args/environ, clocks, random, fd and path calls, `poll_oneoff` and `proc_exit`; WASI `sock_*` answers ENOSYS.
 * A module that imports from `env` is an `emcc` build: `runPreview1` then loads `emscripten.mjs` (the `env.__syscall_*`
 * names, sockets, `epoll`, libecmaos processes and signals) and adds it to the same host. An import the host does not
 * provide is stubbed: calling it stops the program with `module imports MODULE.NAME, which ecmaOS does not provide`.
 * Exported and imported memory are both supported (`detectMemoryImport`). A Preview 2 component is run by `wasip2.mjs`.
 * Asyncify-instrumented modules run as if uninstrumented.
 * A wasi fd and a real fd share one numbering: 0-2 are stdio and the `/` and `.` preopens are opened for real at
 * startup (each top-level directory is preopened too, lazily; see `createWasip1`), so they cannot collide with fds
 * `env.__syscall_openat` returns.
 */
import { open, read, write, close, lseek, ftruncate, fsync, fdatasync, stat, lstat, fstat, getdents, mkdir, rmdir, unlink, rename, symlink, readlink, getcwd } from '@zenfs/linux/uapi/fs'
import { argv, environ, getpid } from '@zenfs/linux/uapi/process'
import { syscall_raw, on_signal, off_signal } from '@zenfs/linux/uapi/base'
import { ESUCCESS, EBADF, ENOSYS, O_RDONLY, O_RDWR, O_CREAT, O_EXCL, O_TRUNC, O_APPEND, O_DIRECTORY, OFLAGS_CREAT, OFLAGS_DIRECTORY, OFLAGS_EXCL, OFLAGS_TRUNC, FDFLAGS_APPEND, FILETYPE, POLLIN, POLLOUT, ProcExit, MissingImport, errnoOf, filetypeOf, normalize, pollFds, sleepMs, rootPreopenNames } from './wasi-common.mjs'

/** Builds the `wasi_snapshot_preview1` import object for one instance. `getMemory` is late-bound. */
export function createWasip1(getMemory, getTable = () => undefined, getExports = () => undefined, { rootPreopens = true } = {}) {
  const cwd = getcwd()
  const args = argv()
  const env = Object.entries(environ()).map(([key, value]) => `${key}=${value}`)
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  // The preopens are opened up front so they get real fd numbers from the same allocator `env.__syscall_openat` uses.
  const preopenRoot = open('/', O_RDONLY | O_DIRECTORY)
  const preopenCwd = open(cwd, O_RDONLY | O_DIRECTORY)
  // wasi-libc finds the preopens by asking fd 3, 4 and on until one is not a preopen, so they are wasi fds 3 and 4
  // whatever real numbers they got (a program started with more than stdio open, under `timeout` say, has 3 taken);
  // what is open there already is not the program's to see, as under any WASI runtime
  const fds = new Map([
    [0, { fd: 0, path: null, dir: false }],
    [1, { fd: 1, path: null, dir: false }],
    [2, { fd: 2, path: null, dir: false }],
    [3, { fd: preopenRoot, path: '/', dir: true, preopen: '/' }],
    [4, { fd: preopenCwd, path: cwd, dir: true, preopen: '.' }],
  ])
  // wasi-libc has no working directory of its own: it makes every path absolute from `/` and takes the longest preopen
  // prefix, the last of equally long ones. So `/` and `.` alone would send every path to `.`; each top-level directory is
  // preopened under its own name too (`rootPreopenNames`). An emscripten module is left out of this: its
  // `env.__syscall_*` calls hand out real fd numbers from 5 up, the same numbers, and it has no wasi-libc to need them.
  let preopenFd = 5
  for (const name of rootPreopens ? rootPreopenNames(cwd, preopenRoot) : []) fds.set(preopenFd++, { fd: null, path: `/${name}`, dir: true, preopen: `/${name}` })
  // The descriptors that close on exec, which the kernel does not keep: a child spawned does not get them, and the
  // preopens are this host's own.
  const cloexec = new Set([preopenRoot, preopenCwd])
  const setCloexec = (fd, on) => { if (on) cloexec.add(fd); else cloexec.delete(fd) }
  // Signals delivered while an import ran (see `enableSignals`): a call the kernel woke with EINTR is resumed when no
  // handler ran, restarted after handlers that all had SA_RESTART, and fails with EINTR after any other.
  const delivery = { enabled: false, handled: 0, interrupting: 0 }
  // Synthetic descriptors (sockets, epoll instances) count up from here, well clear of the real ones, which the
  // kernel hands out lowest first:
  // a program using a few hundred descriptors would otherwise be given a real number a socket already has.
  let nextFd = Math.max(preopenRoot, preopenCwd, 255) + 1
  const allocFd = () => nextFd++
  const reserveFd = real => { nextFd = Math.max(nextFd, real + 1) }


  const view = () => new DataView(getMemory().buffer)
  const bytes = () => new Uint8Array(getMemory().buffer)
  const readString = (ptr, len) => decoder.decode(bytes().subarray(ptr, ptr + len))

  /**
   * Runs `fn` until a signal does not resume it: when it fails with EINTR, it runs again unless a handler without
   * SA_RESTART ran meanwhile (or, for `waits` - poll and the like, which Linux never restarts - any handler).
   */
  const resuming = (fn, waits = false) => {
    for (;;) {
      const before = waits ? delivery.handled : delivery.interrupting
      try {
        return fn()
      } catch (error) {
        if (error?.code !== 'EINTR' || (waits ? delivery.handled : delivery.interrupting) !== before) throw error
      }
    }
  }

  /** Runs `fn`, turning a thrown syscall error into a WASI errno. */
  const guard = (fn, waits = false) => {
    try {
      return resuming(fn, waits) ?? ESUCCESS
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

  /** A NULL-terminated array of strings, `argv` or `envp` */
  const readCStrings = (ptr) => {
    const list = []
    for (let at = ptr; ptr; at += 4) {
      const item = view().getUint32(at, true)
      if (!item) break
      list.push(readCString(item))
    }
    return list
  }

  // What `posix_spawn` (spawn.mjs) reads: the program's memory, and its signals, which libecmaos hands the kernel
  // (`__ecmaos_set_sigstate`) before it spawns
  const spawnMemory = { view, string: readCString, strings: readCStrings }
  const spawnSignals = {
    ignored: resets => Math.max(0, syscall_raw('proc_sigstate', 0)) & ~Number(resets & 0x7fffffffn),
    mask: () => BigInt(Math.max(0, syscall_raw('proc_sigstate', 1))),
  }

  // A real fd not registered here (opened through `env.__syscall_openat`) is treated as an open file rather than
  // EBADF. `fds` is the source of truth for fds 0-4 and anything opened through `path_open`.
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

  // What `emscripten.mjs` adds when a module imports from `env`: its sockets and directory read positions are looked
  // up by `fd_close`, `fd_read` and the rest too, since a socket is a descriptor like any other. Without it there are
  // no sockets and the hooks answer "not a socket".
  const sockets = new Map() // synthetic fd -> { family, key, bound, listening, connected }
  // `getdents` answers with a whole listing every time, so each directory fd needs its own read position
  // (entries already handed out); without it a `readdir` loop never sees the end of the directory.
  const dirPos = new Map()
  const net = {
    socketRealFd: () => ({ isSocket: false }),
    dgramRecv: () => { throw Object.assign(new Error('not a socket'), { code: 'EBADF' }) },
    dgramSend: () => { throw Object.assign(new Error('not a socket'), { code: 'EBADF' }) },
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
        cloexec.delete(fd)
      })
    },
    fd_read(fd, iovPtr, iovCnt, nreadPtr) {
      const sr = net.socketRealFd(fd, 'read')
      if (sr.isSocket) {
        if (sr.error) return sr.error
        if (sr.sock) return guard(() => {
          const list = iovecs(iovPtr, iovCnt)
          const data = net.dgramRecv(sr.sock, list.reduce((sum, [, len]) => sum + len, 0))
          let at = 0
          for (const [ptr, len] of list) { const part = data.subarray(at, at + len); bytes().set(part, ptr); at += part.length }
          view().setUint32(nreadPtr, data.length, true)
        })
        return guard(() => { const n = readInto(sr.fd, iovecs(iovPtr, iovCnt)); sr.local.rxCount = (sr.local.rxCount ?? 0) + n; view().setUint32(nreadPtr, n, true) })
      }
      const entry = entryOf(fd)
      if (!entry) return EBADF
      return guard(() => {
        const n = readInto(realFd(entry), iovecs(iovPtr, iovCnt))
        view().setUint32(nreadPtr, n, true)
      })
    },
    fd_pread(fd, iovPtr, iovCnt, offset, nreadPtr) {
      const sr = net.socketRealFd(fd, 'read')
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
      const sr = net.socketRealFd(fd, 'write')
      if (sr.isSocket) {
        if (sr.error) return sr.error
        if (sr.sock) return guard(() => {
          const list = iovecs(iovPtr, iovCnt)
          const data = new Uint8Array(list.reduce((sum, [, len]) => sum + len, 0))
          let at = 0
          for (const [ptr, len] of list) { data.set(bytes().subarray(ptr, ptr + len), at); at += len }
          view().setUint32(nwrittenPtr, net.dgramSend(sr.sock, data), true)
        })
        return guard(() => { const n = writeFrom(sr.fd, iovecs(iovPtr, iovCnt)); sr.local.txCount = (sr.local.txCount ?? 0) + n; view().setUint32(nwrittenPtr, n, true) })
      }
      const entry = entryOf(fd)
      if (!entry) return EBADF
      return guard(() => {
        const n = writeFrom(realFd(entry), iovecs(iovPtr, iovCnt))
        view().setUint32(nwrittenPtr, n, true)
      })
    },
    fd_pwrite(fd, iovPtr, iovCnt, offset, nwrittenPtr) {
      const sr = net.socketRealFd(fd, 'write')
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
      // wasi whence: 0 SET, 1 CUR, 2 END - the same numbers lseek(2) uses
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
        // POLLNVAL (0x20): an fd the program does not have is ready at once, with an error
        pollable.forEach((sub, i) => { if (revents[i]) { sub.bad = Boolean(revents[i] & 0x20); ready.push(sub) } })
      } else if (soonest > 0) {
        sleepMs(soonest)
      }
      // A regular file or a directory is always ready; an unconnected socket (no real fd to poll
      // yet) is not - only these two cases fall out of `pollable`.
      for (const sub of fdSubs) if (!pollable.includes(sub) && !sockets.has(sub.fd)) ready.push(sub)

      const events = ready.length ? ready : clockSubs.filter(sub => sub.ms <= soonest)
      events.forEach((sub, i) => {
        const base = outPtr + i * 32
        dv.setBigUint64(base, sub.userdata, true)
        dv.setUint16(base + 8, sub.bad ? EBADF : ESUCCESS, true)
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
   * For a module exporting `ecmaos_signal(sig)` (libecmaos, `core/utils/wasm/lib/ecmaos/signal.c`), runs the kernel's
   * signals through the handlers it set with `signal()` or `sigaction()`. They run as a syscall returns, which is
   * inside the module's own import call, and the answer says what became of the call (see `resuming`). A default
   * action that ends or stops the program is the kernel's. Registering a handler stops the kernel's default action, so
   * this is only done for modules that can answer.
   */
  function enableSignals(instance) {
    const deliver = instance.exports.ecmaos_signal
    if (typeof deliver !== 'function') return
    delivery.enabled = true
    for (const signal of CATCHABLE_SIGNALS) {
      on_signal(signal, () => {
        const answer = deliver(signal)
        if (answer === RESTART || answer === INTERRUPT) delivery.handled++
        if (answer === INTERRUPT) delivery.interrupting++
        if (answer !== DEFAULT_ACTION || IGNORED_BY_DEFAULT.has(signal)) return
        off_signal(signal)
        syscall_raw('proc_kill', getpid(), signal)
        throw new ProcExit(128 + signal)
      })
    }
  }

  const context = { args, env, encoder, decoder, fds, cloexec, setCloexec, delivery, allocFd, reserveFd, view, bytes, resuming, readCString, readCStrings, spawnMemory, spawnSignals, entryOf, realFd, iovecs, getMemory, getTable, getExports, sockets, dirPos, net }
  return { imports: { wasi_snapshot_preview1: wasi }, wasi, context, ProcExit, args, env, enableSignals }
}


/**
 * Builds a real argc/argv (a NUL-terminated `char**`) for `__main_argc_argv`, using the module's own stack allocator
 * (`_emscripten_stack_alloc`) since memory is not grown.
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
  view.setUint32(base + args.length * 4, 0, true)
  return base
}

/**
 * Reads a memory import's declared limits from the binary (the reflection API does not report them), so a module that
 * imports its memory (`-sIMPORTED_MEMORY`) can be given one of the declared size.
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

// The signals a program built with libecmaos takes from the kernel (the stops and SIGCONT stay the kernel's), and
// what `ecmaos_signal` answers for one: the default action, or nothing ran (it was blocked or ignored), or a handler
// ran with SA_RESTART, or one ran without.
const CATCHABLE_SIGNALS = [1, 2, 3, 10, 12, 14, 15, 17, 28]
const IGNORED_BY_DEFAULT = new Set([17, 28])
const DEFAULT_ACTION = 0, RESTART = 2, INTERRUPT = 3

/** Runs a preview1 or ordinary-`emcc` module to completion and returns its exit code. */
export async function runPreview1(source) {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source)
  const module = await WebAssembly.compile(source)
  let memory
  const isEmscripten = WebAssembly.Module.imports(module).some(entry => entry.module === 'env')
  const { imports, wasi, context, ProcExit: Exit, args, env, enableSignals } = createWasip1(() => memory, () => instance?.exports.__indirect_function_table, () => instance?.exports, { rootPreopens: !isEmscripten })
  // The emscripten half is a separate chunk: only a module that imports from `env` pays for loading it.
  if (isEmscripten) imports.env = (await import('./emscripten.mjs')).createEmscripten(context, wasi)
  const memoryImport = detectMemoryImport(bytes)
  if (memoryImport) {
    // The module wants its memory handed in rather than exported - create it to the module's own
    // declared limits and answer the import with it, same as any other host would.
    memory = new WebAssembly.Memory(memoryImport.maximum !== undefined
      ? { initial: memoryImport.initial, maximum: memoryImport.maximum }
      : { initial: memoryImport.initial })
    imports[memoryImport.module] = { ...(imports[memoryImport.module] ?? {}), [memoryImport.name]: memory }
  }
  // An import the host does not provide (an `emcc` syscall it lacks, a newer or vendor WASI function) does not stop the
  // module linking: it stops the program with a message if the program calls it.
  for (const entry of WebAssembly.Module.imports(module)) {
    if (entry.kind !== 'function' || imports[entry.module]?.[entry.name]) continue
    imports[entry.module] = {
      ...imports[entry.module],
      [entry.name]: () => { throw new MissingImport(`${entry.module}.${entry.name}`) }
    }
  }
  let instance
  instance = await WebAssembly.instantiate(module, imports)
  enableSignals(instance)
  memory = memory ?? instance.exports.memory
  const fail = message => { write(2, new TextEncoder().encode(`${argv()[0] ?? 'wasm'}: ${message}\n`)); return 1 }
  // a WASI program needs its memory to pass the host anything; a plain module (no WASI imports) may have none
  if (!memory && WebAssembly.Module.imports(module).some(entry => entry.module === 'wasi_snapshot_preview1')) return fail('a WASI module must export or import its memory')
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
      // would drive it - run static constructors, call main(argc, argv), then flush stdio and any
      // atexit handlers the way EXIT_RUNTIME's own exit path does, since there is no glue to do it.
      if (typeof instance.exports.emscripten_stack_init === 'function') instance.exports.emscripten_stack_init()
      if (typeof __wasm_call_ctors === 'function') __wasm_call_ctors()
      const stackAlloc = instance.exports._emscripten_stack_alloc
      if (typeof stackAlloc !== 'function') throw new Error('wasi: the module has no _emscripten_stack_alloc to build argv in')
      const argvPtr = buildArgv(memory, args, stackAlloc)
      // a `main(argc, argv, envp)` (GNU make's) reads its environment from the third; a two-argument one ignores it
      const envPtr = buildArgv(memory, env, stackAlloc)
      code = __main_argc_argv(args.length, argvPtr, envPtr) | 0
      if (typeof fflush === 'function') fflush(0)
      if (typeof __funcs_on_exit === 'function') __funcs_on_exit()
    } else {
      return fail('not a program: the module exports none of _start, _initialize or main (a library)')
    }
    return code
  } catch (error) {
    if (error instanceof Exit) return error.code
    if (error instanceof MissingImport) {
      write(2, new TextEncoder().encode(`${argv()[0] ?? 'wasm'}: module imports ${error.name}, which ecmaOS does not provide\n`))
      return 1
    }
    throw error
  }
}
