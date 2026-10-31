/**
 * Emscripten's `env.__syscall_*` ABI on the real syscalls, for an `emcc` build that does not use `-sSTANDALONE_WASM`.
 * Loaded by `runPreview1` (`wasip1.mjs`) only when a module imports from `env`, so a Rust, Go or WALI program's worker
 * does not carry it. It adds to the host `createWasip1` made: the same fd table and memory helpers (`context`), plus
 * sockets, `epoll`, name resolution, `mmap` by copying, time functions and the libecmaos process calls.
 */
import { open, read, write, close, getdents, ftruncate, fdatasync, stat, lstat, fstat, mkdir, rmdir, unlink, rename, link, symlink, readlink, getcwd, chdir, chmod, fchmod, chown, fchown, utimes, access, dup, dup2, pipe, statfs, tcgetattr, tcsetattr, winsize } from '@zenfs/linux/uapi/fs'
import { environ, getpid } from '@zenfs/linux/uapi/process'
import { syscall, syscall_raw, copyOut, off_signal } from '@zenfs/linux/uapi/base'
import { canonicalIp, formatIp, isIPv6, isLoopbackIp, parseIp } from '../tree/lib/ip.ts'
import { environment_of, openDescriptors, spawn } from './spawn.mjs'
import { ESUCCESS, EBADF, SYSCALL_ERRNO, fromLinux, LINUX_EINTR, O_RDONLY, O_WRONLY, O_DIRECTORY, O_CLOEXEC, S_IFMT, POLLIN, POLLOUT, EPOLL_CTL_ADD, EPOLL_CTL_DEL, EPOLL_CTL_MOD, EPOLL_CLOEXEC, EPOLL_EVENT_SIZE, ProcExit, pollFds, sleepMs, callMainThread } from './wasi-common.mjs'

/** Builds the `env` import object for one instance. `context` is what `createWasip1` returned; `wasi` is its import table. */
export function createEmscripten(context, wasi) {
  const { args, encoder, decoder, cloexec, setCloexec, delivery, allocFd, reserveFd, view, bytes, resuming, readCString, readCStrings, spawnMemory, spawnSignals, entryOf, realFd, iovecs, getMemory, getTable, getExports, sockets, dirPos, net } = context
  // epoll instances: synthetic fds from `allocFd`, not registered in `fds`, so `fd_read` and the rest see EBADF.
  // `interests` maps a watched fd to its `{ events, dataLo, dataHi }`; the 8-byte `epoll_data_t` is echoed back as
  // two halves.
  const epollInstances = new Map()
  const dirPaths = new Map() // real fd -> path, populated by openat so a later ...at(dirfd, ...) resolves

  /**
   * Implements `epoll_pwait`: derives readiness for each watched fd with the real `poll(2)` syscall, waits up to
   * `timeoutMs` (-1 blocks), writes up to `maxevents` `struct epoll_event`s to `evPtr` and returns how many.
   */
  function doEpollWait(inst, evPtr, maxevents, timeoutMs) {
    const entries = [...inst.interests.entries()]
    if (!entries.length) {
      if (timeoutMs > 0) sleepMs(timeoutMs)
      return 0
    }
    const revents = pollGuest(entries.map(([fd, reg]) => ({ fd, events: reg.events & (POLLIN | POLLOUT) })), timeoutMs)
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

  // Emscripten's `env.__syscall_*` ABI, used by its libc for file I/O. Signatures, the varargs convention
  // (`syscallGetVarargI`) and the `struct stat` layout follow emscripten 6.0.9's `libsyscall.js`. Calls use real fds
  // directly. `fcntl` locking and duplication beyond `F_DUPFD` answer ENOSYS; `epoll` is implemented (`doEpollWait`).
  const AT_FDCWD = -100

  const guardLinux = (fn, waits = false) => {
    try {
      return resuming(fn, waits) ?? ESUCCESS
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

  /**
   * `poll` over the program's own descriptors. A connected socket is a pair of real fds (read for `POLLIN`, write for
   * `POLLOUT`); a listening one is ready when a connection is queued, which the kernel is asked about every 20 ms
   * while waiting; an unconnected one is never ready. Anything else is a real fd.
   */
  function pollGuest(items, timeout) {
    const plan = items.map(({ fd, events }) => {
      const sock = sockets.get(fd)
      if (!sock) return { real: [{ fd: entryOf(fd)?.fd ?? fd, events, out: 0 }] }
      if (sock.listening) return { listen: sock.key, events }
      if (!sock.connected) return { real: [] }
      const real = []
      if (events & POLLIN) real.push({ fd: sock.readFd, events: POLLIN, out: 0 })
      if (events & POLLOUT) real.push({ fd: sock.writeFd ?? sock.readFd, events: POLLOUT, out: 0 })
      return { real }
    })
    const flat = plan.flatMap(entry => entry.real ?? [])
    const listeners = plan.filter(entry => entry.listen !== undefined)
    const result = items.map(() => 0)
    const deadline = timeout < 0 ? Infinity : Date.now() + timeout
    for (;;) {
      const remaining = deadline === Infinity ? Infinity : Math.max(deadline - Date.now(), 0)
      const slice = listeners.length ? Math.min(remaining, 20) : remaining
      if (flat.length) {
        const revents = pollFds(flat.map(({ fd, events }) => ({ fd, events })), slice === Infinity ? -1 : slice)
        flat.forEach((entry, i) => { entry.out = revents[i] })
      } else sleepMs(slice === Infinity ? 20 : slice)
      let ready = 0
      plan.forEach((entry, i) => {
        if (entry.real) result[i] = entry.real.reduce((bits, one) => bits | one.out, 0)
        else if (callMainThread('net_pending', entry.listen).pending > 0 && (entry.events & POLLIN)) result[i] = POLLIN
        if (result[i]) ready++
      })
      if (ready || Date.now() >= deadline || (!listeners.length && flat.length)) return result
      if (!listeners.length && !flat.length && deadline !== Infinity) return result
    }
  }

  function doPoll(fdsPtr, nfds, timeout) {
    const dv = view()
    const slots = []
    for (let i = 0; i < nfds; i++) {
      const fd = dv.getInt32(fdsPtr + i * 8, true)
      if (fd < 0) { dv.setInt16(fdsPtr + i * 8 + 6, 0, true); continue }
      slots.push({ i, fd, events: dv.getInt16(fdsPtr + i * 8 + 4, true) })
    }
    let revents = []
    if (slots.length) revents = pollGuest(slots.map(({ fd, events }) => ({ fd, events })), timeout)
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

  // POSIX sockets. `env.__syscall_connect` reaches: `127.0.0.1`, `0.0.0.0` or a `AF_UNIX` path (a listener in another
  // program, via `net_bind`, `net_listen`, `net_connect`, `net_accept`); any other IPv4 address through the gateway
  // when `gateway up` made one (`net_connect_out`); otherwise `ENETUNREACH`. The connection is a pair of real fds, so
  // everything after connect is answered locally.
  const AF_UNIX = 1
  const AF_INET = 2
  const AF_INET6 = 10
  const IPPROTO_IPV6 = 41
  const IPV6_V6ONLY = 26
  const SOL_SOCKET = 1
  const SCM_RIGHTS = 1
  const SCM_CREDENTIALS = 2
  const SO_PASSCRED = 16
  const SO_PEERCRED = 17
  const MSG_CTRUNC = 8
  const CMSG_HEADER = 12 // struct cmsghdr on wasm32: len (u32), level (i32), type (i32)
  const cmsgAlign = (n) => (n + 3) & ~3
  const SIN_SIZE = 16 // sizeof(struct sockaddr_in)
  const SIN6_SIZE = 28 // sizeof(struct sockaddr_in6)
  const SOCK_STREAM_MASK = 0xff // socket()'s type also carries SOCK_NONBLOCK/SOCK_CLOEXEC as high bits
  const SOCK_STREAM = 1
  const SOCK_DGRAM = 2
  const MAX_DATAGRAM = 65507 // the most a UDP datagram can carry over IPv4


  /** `struct sockaddr_un`/`struct sockaddr_in` as emcc 6.0.9 lays them out (`offsetof()`, as for
   * `struct stat`): family (u16) at offset 0 for both; `sockaddr_in`'s port (u16, network/big-endian byte order) at 2,
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
    // `struct sockaddr_in6`: family 0, port 2 (big-endian), flow info 4, the 16 address bytes at 8, scope id 24 (28
    // bytes). An address
    // that is IPv4-mapped reads back as the IPv4 address, so one address has one spelling everywhere below.
    if (family === AF_INET6) return { family, port: dv.getUint16(ptr + 2, false), addr: formatIp(bytes().slice(ptr + 8, ptr + 24)) }
    return { family }
  }

  /**
   * The errno for an address of the wrong kind for this socket (or `0`): an IPv4 socket cannot take an IPv6 address,
   * and an IPv6 socket cannot take a `sockaddr_in`
   */
  function checkInet(sock, sa, addrlen) {
    if (sa.family === sock.family) return 0
    if (sock.family === AF_INET6 && sa.family === AF_INET) return addrlen < 24 ? -SYSCALL_ERRNO.EINVAL : -SYSCALL_ERRNO.EAFNOSUPPORT
    return -SYSCALL_ERRNO.EAFNOSUPPORT
  }

  /** The bytes of a `sockaddr_in` (16) or, for an IPv6 socket, a `sockaddr_in6` (28); an IPv4 address goes into the latter mapped, which
   * is how an IPv6 socket shows one */
  function sockaddrBytes(addr, port, family) {
    const out = new Uint8Array(family === AF_INET6 ? SIN6_SIZE : SIN_SIZE)
    const dv = new DataView(out.buffer)
    dv.setUint16(0, family === AF_INET6 ? AF_INET6 : AF_INET, true)
    dv.setUint16(2, port, false)
    if (family === AF_INET6) out.set(parseIp(addr || '::1') ?? new Uint8Array(16), 8)
    else for (let i = 0, parts = (addr || '127.0.0.1').split('.').map(Number); i < 4; i++) out[4 + i] = parts[i] || 0
    return out
  }

  /** `addrlenPtr` is a real in/out `socklen_t*` (`accept4`/`getsockname`/`getpeername`/`recvfrom`): the address is cut to the room the
   * caller said it has, and the length written back is the whole size, same as the real syscalls this answers for.
   * `family` is the
   * socket's own: an IPv6 socket is given a `sockaddr_in6`. */
  function writeSockaddrResult(addrPtr, addrlenPtr, addr, port, family = AF_INET) {
    if (!addrPtr) return
    const full = sockaddrBytes(addr, port, family)
    const room = addrlenPtr ? view().getUint32(addrlenPtr, true) : full.length
    bytes().set(full.subarray(0, Math.min(room, full.length)), addrPtr)
    if (addrlenPtr) view().setUint32(addrlenPtr, full.length, true)
  }

  // UDP sockets (`SOCK_DGRAM`, `AF_INET`): the same pair of pipes as a stream socket, each datagram framed as a
  // 2-byte big-endian length then its bytes, so the main thread (`net_connect_out` with `udp`) can rebuild datagrams.
  // An unbound socket talks to one peer, fixed by `connect()` or the first `sendto()`. A bound socket is "addressed":
  // each frame also carries the other end (16 bytes of address, IPv4 mapped, then 2 of port after the length), so one
  // socket can hear from and answer many peers.
  function dgramSend(sock, data, dst) {
    if (data.length > MAX_DATAGRAM) throw { code: 'EMSGSIZE' }
    let frame
    if (sock.addressed) {
      const to = dst ?? (sock.peerAddr ? { addr: sock.peerAddr, port: sock.peerPort } : undefined)
      if (!to) throw { code: 'EDESTADDRREQ' }
      frame = new Uint8Array(20 + data.length)
      frame[0] = data.length >> 8
      frame[1] = data.length & 0xff
      frame.set(parseIp(to.addr) ?? new Uint8Array(16), 2)
      frame[18] = to.port >> 8
      frame[19] = to.port & 0xff
      frame.set(data, 20)
    } else {
      frame = new Uint8Array(2 + data.length)
      frame[0] = data.length >> 8
      frame[1] = data.length & 0xff
      frame.set(data, 2)
    }
    for (let done = 0; done < frame.length;) {
      const n = write(sock.writeFd, frame.subarray(done), -1)
      if (n <= 0) throw { code: 'EPIPE' }
      done += n
    }
    return data.length
  }

  /** The next datagram, cut to `max` bytes as recv() cuts one; an empty array when the flow has ended */
  function dgramRecv(sock, max) {
    const take = (count) => {
      const out = new Uint8Array(count)
      for (let done = 0; done < count;) {
        const n = read(sock.readFd, out.subarray(done), -1)
        if (n <= 0) return null
        done += n
      }
      return out
    }
    const header = take(sock.addressed ? 20 : 2)
    if (!header) return new Uint8Array(0)
    if (sock.addressed) sock.from = { addr: formatIp(header.subarray(2, 18)), port: (header[18] << 8) | header[19] }
    const body = take((header[0] << 8) | header[1])
    return body ? body.subarray(0, max) : new Uint8Array(0)
  }

  /** 127.0.0.1 and ::1, and 0.0.0.0 and :: (what `connect()` to "any" means on Linux: this machine) */
  const isLoopbackAddress = isLoopbackIp
  /** The loopback address "any" stands for when it is a destination */
  const anyToLoopback = addr => addr === '0.0.0.0' ? '127.0.0.1' : addr === '::' ? '::1' : addr

  /** connect() on a UDP socket: fixes the peer. Only addresses beyond this machine, through the gateway. */
  function dgramConnect(sock, sa) {
    // an IPv6 datagram socket also takes an IPv4 address (as Linux does unless IPV6_V6ONLY is set); an IPv4 one
    // cannot name an IPv6 peer
    if (sa.family !== AF_INET && sa.family !== AF_INET6) return -SYSCALL_ERRNO.EAFNOSUPPORT
    if (sa.family === AF_INET6 && sock.family !== AF_INET6) return -SYSCALL_ERRNO.EAFNOSUPPORT
    if (sock.addressed) { sock.peerAddr = anyToLoopback(sa.addr); sock.peerPort = sa.port; return ESUCCESS } // the default destination, no flow of its own
    if (isLoopbackAddress(sa.addr)) return -SYSCALL_ERRNO.ECONNREFUSED // no UDP between programs on this machine
    const result = callMainThread('net_connect_out', sa.addr, sa.port, 'udp')
    if (result.error) return socketErrno(result.error)
    sock.connected = true
    sock.readFd = result.fd
    sock.writeFd = result.writeFd
    sock.peerAddr = sa.addr
    sock.peerPort = sa.port
    return ESUCCESS
  }

  // A datagram socket that was never bound claims an ephemeral port the first time it sends to an address, as on
  // Linux, and is then
  // "addressed" like a bound one: it can send to any number of peers and hears from each. A socket that was
  // `connect()`ed keeps to its peer.
  function ensureAddressed(sock) {
    if (sock.addressed) return
    const result = callMainThread('net_udp_bind', '', 0)
    if (result.error) throw { code: result.error }
    Object.assign(sock, { bound: true, addressed: true, connected: true, port: result.port, readFd: result.fd, writeFd: result.writeFd })
  }

  /** The descriptors named by `SCM_RIGHTS` messages in a control buffer, as the main thread wants them */
  function readRights(controlPtr, controlLen) {
    const out = []
    if (!controlPtr || controlLen < CMSG_HEADER) return out
    const dv = view()
    for (let p = controlPtr; p + CMSG_HEADER <= controlPtr + controlLen;) {
      const len = dv.getUint32(p, true)
      if (len < CMSG_HEADER) break
      if (dv.getInt32(p + 4, true) === SOL_SOCKET && dv.getInt32(p + 8, true) === SCM_RIGHTS) {
        for (let i = 0; i < Math.floor((len - CMSG_HEADER) / 4); i++) {
          const number = dv.getInt32(p + CMSG_HEADER + i * 4, true)
          const made = sockets.get(number)
          if (made) {
            if (!made.connected || made.dgram || !made.conn) throw { code: 'EINVAL' }
            out.push({ t: 'sock', readFd: made.readFd, writeFd: made.writeFd, meta: { family: made.family, conn: made.conn, dir: made.dir, txCount: made.txCount ?? 0, rxCount: made.rxCount ?? 0, peerKey: made.peerKey, peerAddr: made.peerAddr, peerPort: made.peerPort } })
          } else {
            const entry = entryOf(number)
            if (!entry) throw { code: 'EBADF' }
            out.push({ t: 'fd', fd: realFd(entry) })
          }
        }
      }
      p += cmsgAlign(len)
    }
    return out
  }

  function sockSend(sock, data, to) {
    if (!sock.dgram) {
      if (!sock.connected) throw { code: 'ENOTCONN' }
      const n = write(sock.writeFd, data)
      sock.txCount = (sock.txCount ?? 0) + n
      return n
    }
    if (to && to.family !== AF_INET && to.family !== AF_INET6) throw { code: 'EAFNOSUPPORT' }
    if (to && to.family === AF_INET6 && sock.family !== AF_INET6) throw { code: 'EAFNOSUPPORT' }
    const dst = to ? { addr: anyToLoopback(to.addr), port: to.port } : undefined
    if (!sock.connected && !sock.addressed) {
      if (!dst) throw { code: 'EDESTADDRREQ' }
      ensureAddressed(sock)
    }
    if (sock.addressed) {
      const target = dst ?? (sock.peerAddr ? { addr: sock.peerAddr, port: sock.peerPort } : undefined)
      // beyond this machine there has to be a route: without a gateway it is a send error, not a datagram lost on the
      // way
      if (target && !isLoopbackAddress(target.addr) && sock.routed !== true) {
        if (!callMainThread('net_gateway_up').up) throw { code: 'ENETUNREACH' }
        sock.routed = true
      }
      return dgramSend(sock, data, dst)
    }
    if (to && (to.addr !== sock.peerAddr || to.port !== sock.peerPort)) throw { code: 'EINVAL' } // connected through a flow of its own: one peer
    return dgramSend(sock, data)
  }

  const MSG_DONTWAIT = 0x40
  const O_NONBLOCK = 0x800

  /** The next bytes for the program and who they came from (`undefined` for a stream, whose peer is fixed). With
   *  `MSG_DONTWAIT`, or a socket set `O_NONBLOCK`, a stream with nothing to read answers EAGAIN instead of waiting. */
  function sockRecv(sock, max, flags = 0) {
    if (!sock.connected) throw { code: 'ENOTCONN' }
    if (!sock.dgram && (flags & MSG_DONTWAIT || sock.nonblock) && pollFds([{ fd: sock.readFd, events: POLLIN }], 0)[0] === 0) throw { code: 'EAGAIN' }
    if (sock.dgram) {
      const data = dgramRecv(sock, max)
      return { data, from: sock.addressed ? sock.from : { addr: sock.peerAddr, port: sock.peerPort } }
    }
    const chunk = new Uint8Array(max)
    const n = read(sock.readFd, chunk, -1)
    if (n > 0) sock.rxCount = (sock.rxCount ?? 0) + n
    return { data: chunk.subarray(0, Math.max(n, 0)), from: undefined }
  }

  function socketErrno(error) {
    if (typeof error === 'string') return -(SYSCALL_ERRNO[error] ?? SYSCALL_ERRNO.EIO)
    return -(SYSCALL_ERRNO[error?.code] ?? SYSCALL_ERRNO.EIO)
  }

  /**
   * Whether `fd` is a socket, and its real backing fd for `direction`, so `fd_read` and `fd_write` redirect
   * transparently. Returns WASI `EBADF` for a socket that is not connected yet.
   */
  function socketRealFd(fd, direction) {
    const sock = sockets.get(fd)
    if (!sock) return { isSocket: false }
    if (!sock.connected) return { isSocket: true, error: EBADF }
    return { isSocket: true, fd: direction === 'write' ? sock.writeFd : sock.readFd, sock: sock.dgram ? sock : undefined, local: sock.dgram ? undefined : sock }
  }

  // Name resolution (`getaddrinfo`, `getnameinfo`, `gethostbyname`). An emscripten build imports these instead of
  // using musl's resolver; here they ask the main thread (`dns_lookup`: `/etc/hosts`, then the gateway's resolver).
  // Structs are wasm32 musl's (`struct addrinfo` is 32 bytes); `gethostbyname` is IPv4 only.
  const EAI = { BADFLAGS: -1, NONAME: -2, AGAIN: -3, FAMILY: -6, SERVICE: -8, MEMORY: -10, OVERFLOW: -12 }
  const AI_PASSIVE = 0x01
  const AI_CANONNAME = 0x02
  const AI_NUMERICHOST = 0x04
  const AI_V4MAPPED = 0x08
  const AI_ALL = 0x10
  const AI_NUMERICSERV = 0x400
  const NI_NUMERICHOST = 1
  const NI_NUMERICSERV = 2
  const NI_NAMEREQD = 8
  const NI_DGRAM = 16
  const SERVICES = { ftp: 21, ssh: 22, telnet: 23, smtp: 25, domain: 53, http: 80, pop3: 110, ntp: 123, imap: 143, https: 443, imaps: 993, pop3s: 995 }

  /** The addresses for `name` in `family` (`AF_INET`, `AF_INET6`, or `0` for both, IPv4 first): a literal is itself, `localhost` is this
   * machine, anything else is asked for. `{ error }` is an EAI code. */
  function lookupAddresses(name, family = AF_INET) {
    const literal = canonicalIp(name)
    if (literal !== undefined) {
      const v6 = isIPv6(literal)
      return family === 0 || (family === AF_INET6) === v6 ? { addresses: [literal] } : { error: EAI.NONAME }
    }
    const addresses = []
    let error
    for (const wanted of family === 0 ? [4, 6] : [family === AF_INET6 ? 6 : 4]) {
      const result = callMainThread('dns_lookup', name, wanted)
      if (result.error) error ??= result.error === 'AGAIN' ? EAI.AGAIN : EAI.NONAME
      else addresses.push(...result.addresses)
    }
    return addresses.length > 0 ? { addresses } : { error: error ?? EAI.NONAME }
  }

  function writeInt32(ptr, value) { view().setInt32(ptr, value, true) }

  /** Allocates in the program's own heap (so its `freeaddrinfo` can free it); `0` when it exports no `malloc` */
  function heapAlloc(size) {
    const malloc = getExports()?.malloc
    return typeof malloc === 'function' ? malloc(size) : 0
  }

  /** The first name /etc/hosts gives an address, if it lists it */
  function hostsNameOf(address) {
    let text = '127.0.0.1 localhost\n::1 localhost ip6-localhost\n'
    try {
      const fd = open('/etc/hosts', O_RDONLY)
      try {
        const chunks = []
        for (;;) {
          const buf = new Uint8Array(16384)
          const n = read(fd, buf, -1)
          if (n <= 0) break
          chunks.push(buf.subarray(0, n))
        }
        text = decoder.decode(joinChunks(chunks))
      } finally { close(fd) }
    } catch { /* no /etc/hosts: the built-in one above */ }
    for (const line of text.split('\n')) {
      const fields = line.replace(/#.*/, '').trim().split(/\s+/)
      if (fields.length >= 2 && canonicalIp(fields[0]) === address) return fields[1]
    }
    return undefined
  }
  function joinChunks(chunks) {
    const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
    let at = 0
    for (const chunk of chunks) { out.set(chunk, at); at += chunk.length }
    return out
  }

  /** Writes a C string into a caller's buffer, cut to fit; `false` when it did not fit whole */
  function putString(ptr, size, text) {
    const encoded = encoder.encode(text)
    const room = Math.max(size - 1, 0)
    const part = encoded.subarray(0, room)
    bytes().set(part, ptr)
    bytes()[ptr + part.length] = 0
    return encoded.length <= room
  }

  const envSyscalls = {
    // The first IPv4 address of a name, packed as the four bytes in memory order; `0` for none (emscripten's libc
    // treats that as not found).
    _emscripten_lookup_name: (namePtr) => {
      const found = lookupAddresses(readCString(namePtr))
      if (!found.addresses?.length) return 0
      const [a, b, c, d] = found.addresses[0].split('.').map(Number)
      return (a | (b << 8) | (c << 16) | (d << 24)) | 0
    },
    // getaddrinfo(3): builds the `struct addrinfo` list in the program's heap, one entry per address, stream by
    // default. With no family
    // asked for, IPv4 addresses come before IPv6 ones (a machine with no IPv6 route of its own sorts them that way).
    getaddrinfo: (nodePtr, servicePtr, hintPtr, outPtr) => {
      let flags = 0, family = 0, socktype = 0, protocol = 0
      if (hintPtr) {
        flags = view().getInt32(hintPtr, true)
        family = view().getInt32(hintPtr + 4, true)
        socktype = view().getInt32(hintPtr + 8, true)
        protocol = view().getInt32(hintPtr + 12, true)
      }
      if (family !== 0 && family !== AF_INET && family !== AF_INET6) return EAI.FAMILY
      const node = nodePtr ? readCString(nodePtr) : null
      const service = servicePtr ? readCString(servicePtr) : null
      if (node === null && service === null) return EAI.NONAME
      let port = 0
      if (service !== null) {
        if (/^\d+$/.test(service) && Number(service) <= 65535) port = Number(service)
        else if (flags & AI_NUMERICSERV) return EAI.NONAME
        else if (SERVICES[service] !== undefined) port = SERVICES[service]
        else return EAI.SERVICE
      }
      let addresses
      if (node === null) {
        const any = flags & AI_PASSIVE
        addresses = family === AF_INET ? [any ? '0.0.0.0' : '127.0.0.1'] : family === AF_INET6 ? [any ? '::' : '::1'] : any ? ['0.0.0.0', '::'] : ['127.0.0.1', '::1']
      } else if (flags & AI_NUMERICHOST && canonicalIp(node) === undefined) return EAI.NONAME
      else {
        const found = lookupAddresses(node, family)
        // an IPv6 caller that asked for IPv4-mapped answers takes an IPv4 address when the name has no IPv6 one
        if (found.error && family === AF_INET6 && flags & AI_V4MAPPED) {
          const mapped = lookupAddresses(node, AF_INET)
          if (mapped.error) return found.error
          addresses = mapped.addresses
        } else if (found.error) return found.error
        else {
          addresses = found.addresses
          if (family === AF_INET6 && flags & AI_V4MAPPED && flags & AI_ALL) {
            const more = lookupAddresses(node, AF_INET)
            if (!more.error) addresses = [...addresses, ...more.addresses]
          }
        }
      }
      const type = socktype || SOCK_STREAM
      const proto = protocol || (type === SOCK_STREAM ? 6 : type === 2 ? 17 : 0)
      let head = 0, tail = 0
      for (const address of addresses) {
        const v6 = family === AF_INET6 || (family === 0 && isIPv6(address))
        const size = v6 ? SIN6_SIZE : SIN_SIZE
        const sa = heapAlloc(size)
        const ai = heapAlloc(32)
        if (!sa || !ai) return EAI.MEMORY
        bytes().set(sockaddrBytes(address, port, v6 ? AF_INET6 : AF_INET), sa)
        writeInt32(ai, 0)
        writeInt32(ai + 4, v6 ? AF_INET6 : AF_INET)
        writeInt32(ai + 8, type)
        writeInt32(ai + 12, proto)
        writeInt32(ai + 16, size)
        writeInt32(ai + 20, sa)
        writeInt32(ai + 24, 0)
        writeInt32(ai + 28, 0)
        if (!head) {
          head = ai
          if (flags & AI_CANONNAME && node !== null) {
            const canon = encoder.encode(node + '\0')
            const text = heapAlloc(canon.length)
            if (text) { bytes().set(canon, text); writeInt32(ai + 24, text) }
          }
        } else writeInt32(tail + 28, ai)
        tail = ai
      }
      writeInt32(outPtr, head)
      return 0
    },
    // getnameinfo(3): the text form of a socket address. The host name comes from /etc/hosts (which is all a reverse
    // lookup consults
    // here), or is the number itself; the service is the number, or the well-known name for it.
    getnameinfo: (saPtr, salen, hostPtr, hostlen, servPtr, servlen, flags) => {
      if (salen < 2) return EAI.FAMILY
      const sa = readSockaddr(saPtr)
      if (sa.family !== AF_INET && sa.family !== AF_INET6) return EAI.FAMILY
      if (sa.family === AF_INET && salen < SIN_SIZE) return EAI.FAMILY
      if (sa.family === AF_INET6 && salen < SIN6_SIZE) return EAI.FAMILY
      let overflow = false
      if (hostPtr && hostlen) {
        const name = flags & NI_NUMERICHOST ? undefined : hostsNameOf(sa.addr)
        if (name === undefined && flags & NI_NAMEREQD) return EAI.NONAME
        if (!putString(hostPtr, hostlen, name ?? sa.addr)) overflow = true
      }
      if (servPtr && servlen) {
        const known = flags & NI_NUMERICSERV || flags & NI_DGRAM ? undefined : Object.keys(SERVICES).find(key => SERVICES[key] === sa.port)
        if (!putString(servPtr, servlen, known ?? String(sa.port))) overflow = true
      }
      return overflow ? EAI.OVERFLOW : 0
    },
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
    // `struct statfs` as musl lays it out for wasm32: two 32-bit words, three 64-bit block counts, two 64-bit
    // file counts, the fsid, then name length, fragment size and flags (88 bytes with its padding).
    __syscall_statfs64: (pathPtr, size, buf) => guardLinux(() => {
      const fs = statfs(readCString(pathPtr))
      const dv = view()
      dv.setUint32(buf + 0, Number(fs.type), true)
      dv.setUint32(buf + 4, Number(fs.bsize), true)
      dv.setBigUint64(buf + 8, BigInt(fs.blocks), true)
      dv.setBigUint64(buf + 16, BigInt(fs.bfree), true)
      dv.setBigUint64(buf + 24, BigInt(fs.bavail), true)
      dv.setBigUint64(buf + 32, BigInt(fs.files), true)
      dv.setBigUint64(buf + 40, BigInt(fs.ffree), true)
      dv.setInt32(buf + 48, 0, true)
      dv.setInt32(buf + 52, 0, true)
      dv.setUint32(buf + 56, Number(fs.namelen), true)
      dv.setUint32(buf + 60, Number(fs.frsize), true)
      dv.setUint32(buf + 64, 0, true)
    }),
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
      const F_DUPFD = 0, F_GETFD = 1, F_SETFD = 2, F_GETFL = 3, F_SETFL = 4, F_DUPFD_CLOEXEC = 1030
      if (cmd === F_DUPFD || cmd === F_DUPFD_CLOEXEC) {
        // the lowest free descriptor at or above the argument: a plain `dup` when that is already high enough
        const least = varargI(varargsPtr, 0)
        let copy = dup(fd)
        if (copy < least) {
          close(copy)
          copy = dup2(fd, least)
        }
        setCloexec(copy, cmd === F_DUPFD_CLOEXEC)
        return copy
      }
      const sock = sockets.get(fd)
      if (cmd === F_GETFL && sock) return sock.nonblock ? O_NONBLOCK : 0
      if (cmd === F_SETFL && sock) { sock.nonblock = (varargI(varargsPtr, 0) & O_NONBLOCK) !== 0; return 0 }
      // the open file's status flags are the kernel's (O_NONBLOCK makes a read of an empty pipe EAGAIN)
      if (cmd === F_GETFL) return syscall('fd_getfl', fd)
      if (cmd === F_SETFL) return syscall('fd_setfl', fd, varargI(varargsPtr, 0))
      // FD_CLOEXEC, which only this host keeps; the descriptor has to be open
      if (cmd === F_GETFD || cmd === F_SETFD) {
        if (!sock && !epollInstances.has(fd)) fstat(fd)
        if (cmd === F_GETFD) return cloexec.has(fd) ? 1 : 0
        setCloexec(fd, (varargI(varargsPtr, 0) & 1) !== 0)
        return 0
      }
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
      setCloexec(fd, (flags & O_CLOEXEC) !== 0)
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
      const UTIME_NOW = 0x3fffffff, UTIME_OMIT = 0x3ffffffe
      const now = Date.now()
      const current = timesPtr ? stat(path) : undefined
      // struct timespec[2] = { tv_sec: i64, tv_nsec: i32 (padded to 8) } x 2. A bare number is seconds to `utimes`,
      // so pass Dates: they are unambiguous.
      const pick = (offset, keep) => {
        if (!timesPtr) return new Date(now)
        const nsec = dv.getInt32(timesPtr + offset + 8, true)
        if (nsec === UTIME_NOW) return new Date(now)
        if (nsec === UTIME_OMIT) return new Date(keep)
        return new Date(Number(dv.getBigInt64(timesPtr + offset, true)) * 1000 + Math.floor(nsec / 1e6))
      }
      utimes(path, pick(0, current?.atimeMs ?? now), pick(16, current?.mtimeMs ?? now))
    }),
    // Sessions and groups. `setsid`/`getsid` are the kernel's; the group calls are the job-control shim's.
    __syscall_setsid: () => guardLinux(() => syscall('proc_setsid')),
    __syscall_getsid: (pid) => guardLinux(() => syscall('proc_getsid', pid)),
    __syscall_setpgid: (pid, pgid) => guardLinux(() => syscall('proc_setpgid', pid, pgid)),
    __syscall_getpgid: (pid) => guardLinux(() => syscall('proc_getpgid', pid)),
    __syscall_getuid32: () => 0,
    __syscall_geteuid32: () => 0,
    __syscall_getgid32: () => 0,
    __syscall_getegid32: () => 0,
    __syscall_dup3: (fd, newfd, flags) => guardLinux(() => {
      const copy = dup2(fd, newfd)
      setCloexec(copy, (flags & O_CLOEXEC) !== 0)
      return copy
    }),
    // `posix_fallocate` is how a program sizes a shared-memory file (SDL does), so the file must really grow
    __syscall_fallocate: (fd, mode, offset, length) => guardLinux(() => {
      if (mode & 1) return   // FALLOC_FL_KEEP_SIZE: nothing to reserve in a file that is not backed by blocks
      const end = Number(offset) + Number(length)
      if (end > fstat(fd).size) ftruncate(fd, end)
    }),
    __syscall_fdatasync: fd => guardLinux(() => fdatasync(fd)),
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
        // controlling terminal: the argument of TIOCSCTTY is an int (1 steals), read as the pointer's value
        case 0x540e: return syscall('proc_ctty', 0, real, varargsPtr ? varargI(varargsPtr, 0) : 0)
        case 0x5422: return syscall('proc_ctty', 1, real, 0)
        case 0x5429: { dv.setInt32(ptr, syscall('proc_ctty', 2, real, 0), true); return ESUCCESS }
        default: {
          // `EVIOC*` (an input device), `FBIO*` (a framebuffer) and the GL devices' requests: the kernel leaves what the device answers in the return
          // region and gives its length. A request a program sets (`FBIOPUT_VSCREENINFO`) carries the bytes it points to.
          const type = (request >>> 8) & 0xff
          if (type !== 0x45 && type !== 0x46 && type !== 0x47) throw { code: 'ENOTTY' }
          const FBIOPUT_VSCREENINFO = 0x4601
          const FBIO_SETCURSOR = 0x46f0   // wlcomp: a NUL-terminated CSS cursor name in 64 bytes
          const argument = ptr && request === FBIOPUT_VSCREENINFO ? new Uint8Array(dv.buffer.slice(ptr, ptr + 160))
            : ptr && request === FBIO_SETCURSOR ? new Uint8Array(dv.buffer.slice(ptr, ptr + 64))
            : ptr && request === 0x46f2 ? new Uint8Array(dv.buffer.slice(ptr, ptr + 4))   // FBIO_SETWINSTATE: an int
            : ptr && request === 0x46f3 ? new Uint8Array(dv.buffer.slice(ptr, ptr + 4096))   // FBIO_SETCLIPBOARD: a chunk of text
            : ptr && request === 0x46f6 ? new Uint8Array(dv.buffer.slice(ptr, ptr + 16 + 64 * 64 * 4))   // FBIO_SETCURSORIMAGE: size, hotspot, pixels
            : ptr && type === 0x47 ? new Uint8Array(dv.buffer.slice(ptr, ptr + 8)) : undefined   // the GL devices (gl.ts): a width and a height at most
          const length = syscall('ioctl', real, request >>> 0, argument)
          if (length > 0) {
            const { bytes } = copyOut(class { constructor(buffer, offset) { this.bytes = new Uint8Array(buffer, offset, length) } })
            if (ptr) new Uint8Array(dv.buffer).set(bytes, ptr)
          }
          // `fbdev` and GL requests give 0; an event device's give the length of what it answered
          return type === 0x46 || type === 0x47 ? 0 : length
        }
      }
    }),
    // The few non-syscall imports an ordinary emcc build leaves for its JS glue: process exit and
    // abort, heap growth, signal-handler dispatch, and the `system()` hook (there is no shell to run).
    exit: (code) => { throw new ProcExit(code) },
    _abort_js: () => { throw new Error('abort() called') },
    _emscripten_runtime_keepalive_clear: () => {},
    // `getprogname()` / `program_invocation_name`: the name the program was started under (argv[0]), copied into
    // `ptr`.
    _emscripten_get_progname: (ptr, len) => {
      const name = encoder.encode(args[0] ?? '')
      const count = Math.min(name.length, Math.max(0, len - 1))
      bytes().set(name.subarray(0, count), ptr)
      bytes()[ptr + count] = 0
    },
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
    // Processes and signals for a program built with libecmaos (core/utils/wasm/lib/ecmaos.sh): the calls
    // `ecmaos/imports.h` declares.
    __ecmaos_spawn: (...args) => {
      flushAll()
      return fromLinux(spawn(spawnMemory, spawnSignals, fd => cloexec.has(fd), ...args))
    },
    // execve(2): descriptors marked close-on-exec go; the ignored signals and the mask were handed to the kernel first
    __ecmaos_execve: (pathPtr, argvPtr, envpPtr) => {
      const path = readCString(pathPtr)
      const executable = syscall_raw('access', path, 1 /* X_OK */)
      if (executable < 0) return fromLinux(executable)
      const list = readCStrings(argvPtr)
      const env = environment_of(readCStrings(envpPtr))
      flushAll()
      for (const fd of openDescriptors()) {
        if (!cloexec.has(fd)) continue
        syscall_raw('close', fd)
        cloexec.delete(fd)
      }
      return fromLinux(syscall_raw('execve', path, list, env))
    },
    // wait4(2): the kernel answers `pid * 65536 + status`, Linux's status word (and Emscripten's)
    __ecmaos_wait4: (pid, statusPtr, options) => {
      const WNOHANG = 1, WUNTRACED = 2
      // a process group (0 for the caller's, -pgid for another) is waited for as any child
      const target = pid < -1 || pid === 0 ? -1 : pid
      const flags = options & (WNOHANG | WUNTRACED)
      for (;;) {
        const before = delivery.interrupting
        let value = syscall_raw('proc_waitpid', target, flags)
        if (value === -LINUX_EINTR) {
          // the SIGCHLD raised as a child ends wakes the wait; Linux returns that child, which is ready by then
          const ready = syscall_raw('proc_waitpid', target, flags | WNOHANG)
          if (ready > 0) value = ready
          else if (delivery.interrupting === before) continue
        }
        if (value <= 0) return fromLinux(value)
        if (statusPtr) view().setInt32(statusPtr, value % 65536, true)
        return Math.floor(value / 65536)
      }
    },
    __ecmaos_kill: (pid, signal) => {
      if (signal < 0 || signal > 64) return -SYSCALL_ERRNO.EINVAL
      // from raise(3): a default action, which is the kernel's
      if (pid === getpid()) {
        if (signal) off_signal(signal)
        return fromLinux(syscall_raw('proc_kill', pid, signal))
      }
      if (pid > 0) return fromLinux(syscall_raw('proc_kill', pid, signal))
      if (pid === -1) return -SYSCALL_ERRNO.ENOSYS
      const group = pid === 0 ? syscall_raw('proc_getpgid', 0) : -pid
      return fromLinux(syscall_raw('proc_killpg', group, signal))
    },
    __ecmaos_sigstate: (which) => Math.max(0, syscall_raw('proc_sigstate', which)),
    __ecmaos_set_sigstate: (ignored, blocked) => fromLinux(syscall_raw('proc_set_sigstate', ignored, blocked)),
    // nanosleep(2): a wait for nothing, which ends early only when a handler runs; what was left goes in `remain`
    __ecmaos_sleep: (ms, remainPtr) => {
      const deadline = performance.now() + ms
      for (;;) {
        const left = deadline - performance.now()
        if (left <= 0) return 0
        const before = delivery.handled
        const value = syscall_raw('poll', [], Math.ceil(left))
        if (value === -LINUX_EINTR && delivery.handled !== before) {
          if (remainPtr) {
            const rest = Math.max(0, deadline - performance.now())
            view().setBigInt64(remainPtr, BigInt(Math.floor(rest / 1000)), true)
            view().setInt32(remainPtr + 8, Math.floor((rest % 1000) * 1e6), true)
          }
          return -SYSCALL_ERRNO.EINTR
        }
      }
    },
    // pause(2): the caller waits again until a handler has run
    __ecmaos_pause: () => {
      syscall_raw('poll', [], -1)
      return -SYSCALL_ERRNO.EINTR
    },
    __syscall_getpid: () => getpid(),
    __syscall_getppid: () => Math.max(0, syscall_raw('getppid')),
    // Clocks, time zone and assertions. The zone is the browser's, as `localtime` reports it.
    emscripten_get_now: () => performance.now(),
    emscripten_date_now: () => Date.now(),
    emscripten_get_heap_max: () => 2147483648,
    // emscripten's own diagnostics (a library calling `emscripten_err`) go to standard error, one line each.
    emscripten_err: (ptr) => { write(2, encoder.encode(readCString(ptr) + '\n'), -1) },
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
    // setitimer(2) and alarm(3): the kernel's timer raises the signal, for a program that can take it (one built with
    // libecmaos); for any other it would end the program, so the timer is accepted and never fires. Emscripten's libc
    // keeps the interval and passes only the time to the next expiry, so an interval timer fires once.
    _setitimer_js: (which, ms) => {
      if (delivery.enabled) syscall_raw('setitimer', which, Math.max(0, Math.round(ms)), 0)
      return 0
    },
    // Memory-mapped files and devices (see `mappings` above): the region is a copy in the program's memory that is kept
    // in step with the object at syscalls.
    _mmap_js: (len, prot, flags, fd, offset, allocatedPtr, addrPtr) => guardLinux(() => mapObject(len, prot, flags, fd, Number(offset), allocatedPtr, addrPtr)),
    _munmap_js: (addr, len) => guardLinux(() => unmapObject(addr, len)),
    _msync_js: (addr, len) => guardLinux(() => syncRegion(addr, len)),
    strptime: (bufPtr, formatPtr, tmPtr) => strptime(bufPtr, readCString(formatPtr), tmPtr),
    __syscall_dup: (fd) => guardLinux(() => {
      const copy = dup(fd)
      cloexec.delete(copy)
      return copy
    }),
    // mkfifo(3) and mknod(2): GNU make's jobserver asks for a fifo, and falls back when it cannot have one.
    __syscall_mknodat: () => -SYSCALL_ERRNO.ENOSYS,
    // pipe2(2): two real descriptors, written to `int fds[2]`.
    __syscall_pipe2: (fdsPtr, flags) => guardLinux(() => {
      const [readEnd, writeEnd] = pipe(flags)
      setCloexec(readEnd, (flags & O_CLOEXEC) !== 0)
      setCloexec(writeEnd, (flags & O_CLOEXEC) !== 0)
      view().setInt32(fdsPtr, readEnd, true)
      view().setInt32(fdsPtr + 4, writeEnd, true)
    }),
    // poll(2): `struct pollfd` is { int fd; short events; short revents }.
    __syscall_poll: (fdsPtr, nfds, timeout) => guardLinux(() => doPoll(fdsPtr, nfds, timeout), true),
    __syscall_poll_nonblocking: (fdsPtr, nfds) => guardLinux(() => doPoll(fdsPtr, nfds, 0)),
    __syscall_epoll_create1: (flags) => {
      if (flags & ~EPOLL_CLOEXEC) return -SYSCALL_ERRNO.EINVAL
      const epfd = allocFd()
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
      if (domain !== AF_UNIX && domain !== AF_INET && domain !== AF_INET6) return -SYSCALL_ERRNO.EAFNOSUPPORT
      if ((domain === AF_INET || domain === AF_INET6) && (type & SOCK_STREAM_MASK) === SOCK_DGRAM) {
        const fd = allocFd()
        sockets.set(fd, { family: domain, dgram: true, key: null, bound: false, listening: false, connected: false })
        return fd
      }
      if ((type & SOCK_STREAM_MASK) !== SOCK_STREAM) return -SYSCALL_ERRNO.EPROTONOSUPPORT
      const fd = allocFd()
      sockets.set(fd, { family: domain, key: null, bound: false, listening: false, connected: false, nonblock: (type & O_NONBLOCK) !== 0 })
      return fd
    },
    __syscall_bind: (fd, addrPtr, addrlen) => {
      const sock = sockets.get(fd)
      if (!sock) return -SYSCALL_ERRNO.ENOTSOCK
      const sa = readSockaddr(addrPtr)
      if (sock.dgram) {
        // claims a loopback port: datagrams from the gateway (an exposed UDP port), from other programs and from the
        // peers this
        // socket has sent to arrive on it, each naming its sender
        const wrong = checkInet(sock, sa, addrlen)
        if (wrong) return wrong
        if (sock.bound || sock.connected) return -SYSCALL_ERRNO.EINVAL
        const result = callMainThread('net_udp_bind', sa.addr, sa.port)
        if (result.error) return socketErrno(result.error)
        sock.bound = true
        sock.boundAddr = sa.addr
        sock.addressed = true
        sock.connected = true
        sock.port = result.port
        sock.readFd = result.fd
        sock.writeFd = result.writeFd
        return ESUCCESS
      }
      let result
      if (sa.family === AF_UNIX) result = callMainThread('net_bind', 'unix', sa.path, 0)
      else if (sa.family === AF_INET || sa.family === AF_INET6) {
        const wrong = checkInet(sock, sa, addrlen)
        if (wrong) return wrong
        // `::` takes IPv4 too unless the program asked otherwise; any other IPv6 address is IPv6 only; a mapped
        // address is IPv4
        const kind = !isIPv6(sa.addr) ? 'inet' : sa.addr === '::' && !sock.v6only ? 'inet46' : 'inet6'
        result = callMainThread('net_bind', kind, sa.addr, sa.port)
        if (!result.error) sock.boundAddr = sa.addr
      } else return -SYSCALL_ERRNO.EAFNOSUPPORT
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
    __syscall_connect: (fd, addrPtr, addrlen) => {
      const sock = sockets.get(fd)
      if (!sock) return -SYSCALL_ERRNO.ENOTSOCK
      const sa = readSockaddr(addrPtr)
      if (sock.dgram && sock.addressed) return dgramConnect(sock, sa)
      if (sock.connected) return -SYSCALL_ERRNO.EISCONN
      if (sock.dgram) return dgramConnect(sock, sa)
      let key
      let result
      if (sa.family === AF_UNIX) key = `unix:${sa.path}`
      else if (sa.family === AF_INET || sa.family === AF_INET6) {
        const wrong = checkInet(sock, sa, addrlen)
        if (wrong) return wrong
        if (isLoopbackAddress(sa.addr)) key = isIPv6(sa.addr) ? `inet6:${sa.port}` : `inet:127.0.0.1:${sa.port}`
        else {
          // not this machine: through the gateway, if one is up (`gateway up`); otherwise ENETUNREACH, as with no
          // route
          result = callMainThread('net_connect_out', sa.addr, sa.port, 'tcp')
          if (result.error) return socketErrno(result.error)
          sock.peerAddr = sa.addr
          sock.peerPort = sa.port
          key = `tcp:${sa.addr}:${sa.port}`
        }
      }
      else return -SYSCALL_ERRNO.EAFNOSUPPORT
      result ??= callMainThread('net_connect', key)
      if (result.error) return socketErrno(result.error)
      sock.connected = true
      sock.peerKey = key
      if (result.conn) { sock.conn = result.conn; sock.dir = 'c' }
      sock.readFd = result.fd
      sock.writeFd = result.writeFd
      return ESUCCESS
    },
    // `flags` may carry `SOCK_NONBLOCK`: an empty accept queue then answers EAGAIN. A blocking `accept4` polls
    // `net_accept` until a connection lands or the worker is killed.
    __syscall_accept4: (fd, addrPtr, addrlenPtr, flags) => {
      const sock = sockets.get(fd)
      if (!sock || !sock.listening) return -SYSCALL_ERRNO.ENOTSOCK
      const nonblock = flags & 0x800 ? 1 : 0
      while (true) {
        const result = callMainThread('net_accept', sock.key, nonblock)
        if (result.error) return socketErrno(result.error)
        if (result.pending) { sleepMs(50); continue }
        const newFd = allocFd()
        sockets.set(newFd, { family: sock.family, key: null, bound: false, listening: false, connected: true, readFd: result.fd, writeFd: result.writeFd, peerKey: result.peerKey, conn: result.conn, dir: result.conn ? 's' : undefined })
        // a connection that came in through the gateway names its real client (`remote:ADDR:PORT`,
        // `remote:[ADDR]:PORT` for IPv6); one from
        // a program on this machine is from loopback, in the family it connected with
        const from = /^remote:(?:\[([0-9a-fA-F:.]+)\]|(\d+\.\d+\.\d+\.\d+)):(\d+)$/.exec(result.peerKey ?? '')
        const peer = sockets.get(newFd)
        const peerAddr = from ? canonicalIp(from[1] ?? from[2]) ?? '127.0.0.1' : result.peerAddr ?? '127.0.0.1'
        const peerPort = from ? Number(from[3]) : 0
        if (from) { peer.peerAddr = peerAddr; peer.peerPort = peerPort }
        writeSockaddrResult(addrPtr, addrlenPtr, peerAddr, peerPort, sock.family)
        return newFd
      }
    },
    __syscall_getsockname: (fd, addrPtr, addrlenPtr) => {
      const sock = sockets.get(fd)
      if (!sock) return -SYSCALL_ERRNO.ENOTSOCK
      writeSockaddrResult(addrPtr, addrlenPtr, sock.family === AF_INET6 ? sock.boundAddr ?? '::1' : '127.0.0.1', sock.port ?? 0, sock.family)
      return ESUCCESS
    },
    __syscall_getpeername: (fd, addrPtr, addrlenPtr) => {
      const sock = sockets.get(fd)
      if (!sock) return -SYSCALL_ERRNO.ENOTSOCK
      if (!sock.connected || (sock.addressed && !sock.peerAddr)) return -SYSCALL_ERRNO.ENOTCONN
      writeSockaddrResult(addrPtr, addrlenPtr, sock.peerAddr ?? (sock.family === AF_INET6 ? '::1' : '127.0.0.1'), sock.peerPort ?? 0, sock.family)
      return ESUCCESS
    },
    __syscall_shutdown: (fd, how) => {
      const sock = sockets.get(fd)
      if (!sock || !sock.connected) return -SYSCALL_ERRNO.ENOTCONN
      return guardLinux(() => {
        if (how !== 0 /* SHUT_RD */) close(sock.writeFd) // SHUT_WR or SHUT_RDWR
      })
    },
    __syscall_sendto: (fd, buf, len, _flags, addrPtr, _addrlen) => guardLinux(() => {
      const sock = sockets.get(fd)
      if (!sock) throw { code: 'ENOTSOCK' }
      return sockSend(sock, bytes().slice(buf, buf + len), addrPtr ? readSockaddr(addrPtr) : undefined)
    }),
    __syscall_recvfrom: (fd, buf, len, flags, addrPtr, addrlenPtr) => guardLinux(() => {
      const sock = sockets.get(fd)
      if (!sock) throw { code: 'ENOTSOCK' }
      const { data, from } = sockRecv(sock, len, flags)
      bytes().set(data, buf)
      if (from) writeSockaddrResult(addrPtr, addrlenPtr, from.addr, from.port, sock.family)
      return data.length
    }),
    // `struct msghdr` on wasm32: name 0, namelen 4, iov 8, iovlen 12, control 16, controllen 20, flags 24 (28 bytes).
    // The iovec array is gathered into one datagram or stream write and scattered on receive. On a local `AF_UNIX`
    // stream connection `SCM_RIGHTS` passes open descriptors (files, pipes, connected sockets) and `SO_PASSCRED`
    // sends credentials. A descriptor travels with the first byte of its data; an ordinary read past that byte drops
    // it, and a receive never joins data from before and after one. Other ancillary kinds are ignored.
    __syscall_sendmsg: (fd, msgPtr, _flags) => guardLinux(() => {
      const sock = sockets.get(fd)
      if (!sock) throw { code: 'ENOTSOCK' }
      const dv = view()
      const namePtr = dv.getUint32(msgPtr, true)
      const list = iovecs(dv.getUint32(msgPtr + 8, true), dv.getUint32(msgPtr + 12, true))
      const data = new Uint8Array(list.reduce((sum, [, size]) => sum + size, 0))
      let at = 0
      for (const [ptr, size] of list) { data.set(bytes().subarray(ptr, ptr + size), at); at += size }
      const passed = readRights(dv.getUint32(msgPtr + 16, true), dv.getUint32(msgPtr + 20, true))
      if (passed.length > 0) {
        if (!sock.conn || sock.dgram) throw { code: 'EINVAL' }
        const sent = callMainThread('scm_send', sock.conn, sock.dir, sock.txCount ?? 0, data.length, JSON.stringify(passed))
        if (sent.error) throw { code: sent.error }
      }
      return sockSend(sock, data, namePtr ? readSockaddr(namePtr) : undefined)
    }),
    __syscall_recvmsg: (fd, msgPtr, flags) => guardLinux(() => {
      const sock = sockets.get(fd)
      if (!sock) throw { code: 'ENOTSOCK' }
      const dv = view()
      const list = iovecs(dv.getUint32(msgPtr + 8, true), dv.getUint32(msgPtr + 12, true))
      let wanted = list.reduce((sum, [, size]) => sum + size, 0)
      const controlPtr = dv.getUint32(msgPtr + 16, true)
      const controlLen = dv.getUint32(msgPtr + 20, true)
      let took
      let credSpace = 0
      if ((flags & MSG_DONTWAIT || sock.nonblock) && !sock.dgram && sock.connected && pollFds([{ fd: sock.readFd, events: POLLIN }], 0)[0] === 0) throw { code: 'EAGAIN' }
      if (sock.conn && !sock.dgram) {
        // a message's descriptors are queued with its data: wait for the data, or a receive that started first would
        // look for them before they were sent and return the data without them
        if (sock.connected) pollFds([{ fd: sock.readFd, events: POLLIN }], -1)
        credSpace =sock.passcred && controlLen >= cmsgAlign(CMSG_HEADER + 12) ? cmsgAlign(CMSG_HEADER + 12) : 0
        const room = Math.max(Math.floor((controlLen - credSpace - CMSG_HEADER) / 4), 0)
        took = callMainThread('scm_take', sock.conn, sock.dir === 'c' ? 's' : 'c', sock.rxCount ?? 0, wanted, room, 3)
        if (took.limit !== null && took.limit !== undefined) wanted = Math.min(wanted, took.limit)
      }
      const { data, from } = sockRecv(sock, wanted)
      let at = 0
      for (const [ptr, size] of list) { const part = data.subarray(at, at + size); bytes().set(part, ptr); at += part.length }
      const namePtr = dv.getUint32(msgPtr, true)
      if (namePtr && from) {
        const full = sockaddrBytes(from.addr, from.port, sock.family)
        const room = dv.getUint32(msgPtr + 4, true)
        bytes().set(full.subarray(0, Math.min(room, full.length)), namePtr)
        dv.setUint32(msgPtr + 4, full.length, true)
      } else dv.setUint32(msgPtr + 4, 0, true)
      let used = 0
      if (took) {
        if (credSpace > 0 && took.peer) {
          const base = controlPtr + used
          dv.setUint32(base, CMSG_HEADER + 12, true); dv.setInt32(base + 4, SOL_SOCKET, true); dv.setInt32(base + 8, SCM_CREDENTIALS, true)
          dv.setInt32(base + 12, took.peer.pid, true); dv.setUint32(base + 16, took.peer.uid, true); dv.setUint32(base + 20, took.peer.gid, true)
          used += credSpace
        }
        const received = []
        for (const item of took.items) {
          if (item.t === 'fd') received.push(item.fd)
          else if (item.readFd >= 0 && item.writeFd >= 0) received.push(item)
        }
        for (const item of received) for (const real of typeof item === 'number' ? [item] : [item.readFd, item.writeFd]) reserveFd(real)
        const numbers = received.map(item => {
          if (typeof item === 'number') return item
          const made = allocFd()
          const meta = item.meta
          sockets.set(made, { family: meta.family, key: null, bound: false, listening: false, connected: true, readFd: item.readFd, writeFd: item.writeFd, conn: meta.conn, dir: meta.dir, txCount: meta.txCount, rxCount: meta.rxCount, peerKey: meta.peerKey, peerAddr: meta.peerAddr, peerPort: meta.peerPort })
          return made
        })
        if (numbers.length > 0) {
          const base = controlPtr + used
          dv.setUint32(base, CMSG_HEADER + numbers.length * 4, true); dv.setInt32(base + 4, SOL_SOCKET, true); dv.setInt32(base + 8, SCM_RIGHTS, true)
          numbers.forEach((number, i) => dv.setInt32(base + CMSG_HEADER + i * 4, number, true))
          used += cmsgAlign(CMSG_HEADER + numbers.length * 4)
        }
      }
      dv.setUint32(msgPtr + 20, used, true)
      dv.setInt32(msgPtr + 24, took?.ctrunc ? MSG_CTRUNC : 0, true)
      return data.length
    }),
    // No real socket-level options exist for a loopback pipe pair - accepted as a harmless no-op
    // rather than failing a program that merely sets e.g. SO_REUSEADDR/TCP_NODELAY defensively.
    // The one that matters is IPV6_V6ONLY: whether an IPv6 socket bound to `::` also takes IPv4 (not by default). It
    // must be set before bind().
    __syscall_setsockopt: (fd, level, optname, optvalPtr, optlen) => {
      const sock = sockets.get(fd)
      if (!sock) return -SYSCALL_ERRNO.ENOTSOCK
      if (level === SOL_SOCKET && optname === SO_PASSCRED && optlen >= 4) sock.passcred = view().getInt32(optvalPtr, true) !== 0
      if (level === IPPROTO_IPV6 && optname === IPV6_V6ONLY) {
        if (sock.family !== AF_INET6) return -SYSCALL_ERRNO.ENOPROTOOPT
        if (optlen < 4) return -SYSCALL_ERRNO.EINVAL
        if (sock.bound) return -SYSCALL_ERRNO.EINVAL
        sock.v6only = view().getInt32(optvalPtr, true) !== 0
      }
      return ESUCCESS
    },
    __syscall_getsockopt: (fd, level, optname, optvalPtr, optlenPtr) => {
      const sock = sockets.get(fd)
      if (!sock) return -SYSCALL_ERRNO.ENOTSOCK
      if (level === IPPROTO_IPV6 && optname === IPV6_V6ONLY && sock.family !== AF_INET6) return -SYSCALL_ERRNO.ENOPROTOOPT
      // SO_PEERCRED: `struct ucred` (pid, uid, gid) of the program at the other end of a local connection
      if (level === SOL_SOCKET && optname === SO_PEERCRED) {
        if (!sock.conn) return -SYSCALL_ERRNO.ENOTCONN
        const peer = callMainThread('scm_cred', sock.conn, sock.dir)
        if (peer.error) return socketErrno(peer.error)
        if (!optvalPtr || !optlenPtr || view().getUint32(optlenPtr, true) < 12) return -SYSCALL_ERRNO.EINVAL
        view().setInt32(optvalPtr, peer.pid, true)
        view().setUint32(optvalPtr + 4, peer.uid, true)
        view().setUint32(optvalPtr + 8, peer.gid, true)
        view().setUint32(optlenPtr, 12, true)
        return ESUCCESS
      }
      const flag = level === IPPROTO_IPV6 && optname === IPV6_V6ONLY ? sock.v6only : level === SOL_SOCKET && optname === SO_PASSCRED ? sock.passcred : false
      if (optvalPtr) view().setInt32(optvalPtr, flag ? 1 : 0, true)
      if (optlenPtr) view().setUint32(optlenPtr, 4, true)
      return ESUCCESS
    },
  }

  // - mmap, by copying at syscalls ---------------------------------------------------------------------------------
  // Program memory is not shared with the kernel, so a mapping cannot be the object's own pages. It is a region of the
  // program's memory (from its allocator) filled from the object, with a copy of what was filled (the shadow). At each
  // syscall where the object could be seen or changed by someone else, the pages the program changed (memory differs
  // from the shadow) are written to the object, and, after a call that reads, pages another writer changed (the object
  // differs from the shadow while memory still equals it) are brought in. A program that draws into a mapped
  // framebuffer and never makes a call is seen when it next sleeps, polls, writes, or exits.
  const PROT_WRITE = 2
  const MAP_SHARED = 1
  const PAGE = 4096
  const S_IFREG = 0x8000
  const S_IFCHR = 0x2000
  /** address -> { ptr, len, prot, shared, fd (own descriptor), offset, shadow, regular } */
  const mappings = new Map()

  const readBacking = (mapping) => {
    const into = new Uint8Array(mapping.len)
    let done = 0
    while (done < mapping.len) {
      const got = read(mapping.fd, into.subarray(done), mapping.offset + done)
      if (got <= 0) break
      done += got
    }
    return into
  }

  function mapObject(len, prot, flags, fd, offset, allocatedPtr, addrPtr) {
    const real = entryOf(fd)?.fd ?? fd
    const mode = fstat(real).mode & S_IFMT
    if (mode !== S_IFREG && mode !== S_IFCHR) throw { code: 'ENODEV' }
    const memalign = getExports()?.emscripten_builtin_memalign
    if (typeof memalign !== 'function') throw { code: 'ENOMEM' }
    const ptr = memalign(65536, len)
    if (!ptr) throw { code: 'ENOMEM' }
    const mapping = { ptr, len, prot, shared: (flags & MAP_SHARED) !== 0, fd: dup(real), offset, shadow: new Uint8Array(len), regular: mode === S_IFREG }
    bytes().fill(0, ptr, ptr + len)
    const content = readBacking(mapping)
    bytes().set(content, ptr)
    mapping.shadow.set(content)
    mappings.set(ptr, mapping)
    view().setInt32(allocatedPtr, 1, true)
    view().setUint32(addrPtr, ptr, true)
  }

  /** Writes the pages of `mapping` the program changed to its object */
  function flushMapping(mapping) {
    if (!mapping.shared || !(mapping.prot & PROT_WRITE)) return
    const memory = bytes()
    // a regular file keeps its size: bytes past the end are not written (the file does not grow by being mapped)
    const limit = mapping.regular ? Math.max(0, Math.min(mapping.len, Number(fstat(mapping.fd).size) - mapping.offset)) : mapping.len
    let runStart = -1
    const flushRun = (end) => {
      if (runStart < 0) return
      const stop = Math.min(end, limit)
      if (stop > runStart) {
        const data = memory.slice(mapping.ptr + runStart, mapping.ptr + stop)
        write(mapping.fd, data, mapping.offset + runStart)
        mapping.shadow.set(data, runStart)
      }
      runStart = -1
    }
    for (let at = 0; at < mapping.len; at += PAGE) {
      const end = Math.min(at + PAGE, mapping.len)
      if (!differ(memory, mapping.ptr + at, mapping.shadow, at, end - at)) flushRun(at)
      else if (runStart < 0) runStart = at
    }
    flushRun(mapping.len)
  }

  /** Brings in the pages another writer changed and the program has not */
  function refreshMapping(mapping) {
    if (!mapping.shared) return
    const memory = bytes()
    // A regular file whose size and times are as when last read, and were stamped before this millisecond, was not
    // written since (a write at this millisecond could still share the stamp, so that is read in full)
    let stamp = null
    if (mapping.regular) {
      const st = fstat(mapping.fd)
      stamp = `${st.size}:${st.mtimeMs}:${st.ctimeMs}`
      if (stamp === mapping.stamp && Date.now() > st.mtimeMs + 1) return
    }
    mapping.stamp = stamp
    const fresh = readBacking(mapping)
    for (let at = 0; at < mapping.len; at += PAGE) {
      const end = Math.min(at + PAGE, mapping.len)
      if (!differ(fresh, at, mapping.shadow, at, end - at)) continue   // nobody else changed it
      if (!differ(memory, mapping.ptr + at, mapping.shadow, at, end - at)) {
        memory.set(fresh.subarray(at, end), mapping.ptr + at)
        mapping.shadow.set(fresh.subarray(at, end), at)
      }
    }
  }

  /** Whether `a[aAt, aAt + n)` and `b[bAt, bAt + n)` differ; whole words while both are aligned, which they are for a page */
  const differ = (a, aAt, b, bAt, n) => {
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

  const overlapping = (addr, len) => [...mappings.values()].filter(m => m.ptr < addr + len && addr < m.ptr + m.len)

  // The libc hands `_msync_js` the flags the region was mapped with, not `msync`'s own, so `MS_INVALIDATE` cannot be told
  // apart from `MS_SYNC`: an `msync` always writes the program's changes out and then takes other writers' in.
  function syncRegion(addr, len) {
    for (const mapping of overlapping(addr, len)) {
      flushMapping(mapping)
      refreshMapping(mapping)
    }
  }

  function unmapObject(addr, len) {
    for (const mapping of overlapping(addr, len)) {
      flushMapping(mapping)
      // only a mapping unmapped whole is let go; the libc keeps its own list of regions
      if (addr <= mapping.ptr && addr + len >= mapping.ptr + mapping.len) {
        mappings.delete(mapping.ptr)
        try { close(mapping.fd) } catch { /* already closed */ }
      }
    }
  }

  const flushAll = () => { for (const mapping of mappings.values()) flushMapping(mapping) }
  const refreshAll = () => { for (const mapping of mappings.values()) refreshMapping(mapping) }
  let lastClockFlush = 0

  /**
   * Wraps an import so mappings are in step around it: `before` writes the program's changes out, `after` brings other
   * writers' changes in. The clock is the way a program that never calls anything else paces its frames, so reading it
   * flushes at most every 16 ms.
   */
  const aroundCalls = (table, names, { before = false, after = false, throttled = false } = {}) => {
    for (const name of names) {
      const original = table[name]
      if (typeof original !== 'function') continue
      table[name] = (...args) => {
        if (!mappings.size) return original(...args)
        if (before) {
          if (!throttled) flushAll()
          else { const now = Date.now(); if (now - lastClockFlush >= 16) { lastClockFlush = now; flushAll() } }
        }
        try { return original(...args) } finally { if (after) refreshAll() }
      }
    }
  }

  aroundCalls(wasi, ['fd_write', 'fd_pwrite', 'fd_sync', 'fd_datasync', 'fd_close', 'proc_exit'], { before: true })
  aroundCalls(wasi, ['fd_read', 'fd_pread', 'poll_oneoff'], { before: true, after: true })
  aroundCalls(wasi, ['clock_time_get'], { before: true, throttled: true })
  aroundCalls(envSyscalls, ['__syscall_ioctl', '__syscall_ftruncate64', '__syscall_fallocate', '__syscall_fdatasync', '__syscall_sendto', '__syscall_sendmsg', 'exit'], { before: true })
  aroundCalls(envSyscalls, ['__syscall_poll', '__syscall_poll_nonblocking', '__syscall_epoll_pwait', '__syscall_epoll_pwait_nonblocking', '__syscall_recvfrom', '__syscall_recvmsg'], { before: true, after: true })
  aroundCalls(envSyscalls, ['emscripten_get_now', 'emscripten_date_now'], { before: true, throttled: true })
  net.socketRealFd = socketRealFd
  net.dgramRecv = dgramRecv
  net.dgramSend = dgramSend

  return envSyscalls
}
