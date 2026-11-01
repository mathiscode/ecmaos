/**
 * WASI Preview 2 (0.2) for `/bin/wali`: the `wasi:*` interfaces a component imports, on the real `@zenfs/linux`
 * syscalls, so a component runs as a worker-hosted process (killable, with pipes and a tty) like a core module does.
 * The kernel transpiles the component with jco (`Wasm.prepareComponent`) and sends the generated JavaScript and core
 * modules ahead of `init`; the worker only loads them. jco's sync mode is used: a host call answers by returning, so a
 * blocking read is a real blocking `read(2)` and `poll` is `poll(2)`, with no JSPI.
 * The interfaces are a table keyed by WASI version (`VERSIONS`), apart from the runner, so a 0.3 table is added next to
 * the 0.2 one.
 */
import { open, read, write, close, ftruncate, fsync, fdatasync, stat, lstat, fstat, getdents, mkdir, rmdir, unlink, rename, symlink, link, readlink, getcwd, tcgetattr, futimes, utimes } from '@zenfs/linux/uapi/fs'
import { argv, environ } from '@zenfs/linux/uapi/process'
import { createSockets } from './wasip2-sockets.mjs'
import { O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_EXCL, O_TRUNC, O_DIRECTORY, S_IFMT, POLLIN, POLLOUT, ProcExit, pollFds, sleepMs, rootPreopenNames } from './wasi-common.mjs'

const encoder = new TextEncoder()

/** errno name (what a failed syscall throws as `error.code`) -> `wasi:filesystem` error-code */
const ERROR_CODE = {
  EACCES: 'access', EAGAIN: 'would-block', EALREADY: 'already', EBADF: 'bad-descriptor', EBUSY: 'busy', EDEADLK: 'deadlock',
  EDQUOT: 'quota', EEXIST: 'exist', EFBIG: 'file-too-large', EILSEQ: 'illegal-byte-sequence', EINPROGRESS: 'in-progress',
  EINTR: 'interrupted', EINVAL: 'invalid', EIO: 'io', EISDIR: 'is-directory', ELOOP: 'loop', EMLINK: 'too-many-links',
  EMSGSIZE: 'message-size', ENAMETOOLONG: 'name-too-long', ENODEV: 'no-device', ENOENT: 'no-entry', ENOLCK: 'no-lock',
  ENOMEM: 'insufficient-memory', ENOSPC: 'insufficient-space', ENOTDIR: 'not-directory', ENOTEMPTY: 'not-empty',
  ENOTRECOVERABLE: 'not-recoverable', ENOTSUP: 'unsupported', ENOSYS: 'unsupported', ENOTTY: 'no-tty', ENXIO: 'no-such-device',
  EOVERFLOW: 'overflow', EPERM: 'not-permitted', EPIPE: 'pipe', EROFS: 'read-only', ESPIPE: 'invalid-seek',
  ETXTBSY: 'text-file-busy', EXDEV: 'cross-device',
}

const codeOf = error => ERROR_CODE[error?.code] ?? 'io'

/** Runs a syscall; a failure is thrown as the 0.2 error-code string, which jco turns into the call's `err` */
const guard = fn => {
  try {
    return fn()
  } catch (error) {
    if (error instanceof ProcExit || error instanceof WebAssembly.Exception) throw error
    throw codeOf(error)
  }
}

const datetime = ms => ({ seconds: BigInt(Math.floor(ms / 1000)), nanoseconds: Math.floor((ms % 1000) * 1e6) })
const nowNs = () => BigInt(Math.round(performance.now() * 1e6))

/** A resource base: jco keeps what a host returns for a resource handle, so any object will do */
class Resource {}

class IoError extends Resource {
  constructor(message) { super(); this.message = message }
  toDebugString() { return this.message }
}

/** Reads a descriptor's whole answer to `poll(2)` at once: which of `subscriptions` are ready, waiting at most `ms` */
function pollAll(subscriptions, ms) {
  const watched = subscriptions.filter(sub => sub.fd !== undefined)
  const revents = watched.length ? pollFds(watched.map(sub => ({ fd: sub.fd, events: sub.events })), ms) : (sleepMs(ms), [])
  return subscriptions.map(sub => {
    if (sub.fd === undefined) return sub.ready()
    return revents[watched.indexOf(sub)] !== 0
  })
}

class Pollable extends Resource {
  /** `{ fd, events }` for a descriptor, `{ deadline }` (monotonic ns) for a clock, neither for something always ready */
  constructor({ fd, events = POLLIN, deadline } = {}) {
    super()
    this.fd = fd
    this.events = events
    this.deadline = deadline
  }
  ready() { return this.deadline === undefined || nowNs() >= this.deadline }
  block() { poll([this]) }
}

/** `wasi:io/poll#poll`: the indices of the pollables that are ready, blocking until at least one is */
function poll(list) {
  if (list.length === 0) throw new Error('poll of no pollables')
  // a deadline is the longest the wait can be; a descriptor with no deadline in the list waits for itself
  const deadlines = list.filter(item => item.deadline !== undefined).map(item => item.deadline)
  const always = list.some(item => item.fd === undefined && item.deadline === undefined)
  const timeout = always ? 0 : deadlines.length ? Math.max(0, Number((deadlines.reduce((a, b) => a < b ? a : b) - nowNs()) / 1000000n)) : -1
  for (;;) {
    const states = pollAll(list.map(item => ({ fd: item.fd, events: item.events, ready: () => item.ready() })), timeout)
    const ready = []
    states.forEach((state, index) => { if (state) ready.push(index) })
    if (ready.length) return new Uint32Array(ready)
  }
}

/** Streams. `source` is `{ read(len, blocking) }` returning a Uint8Array, or null at the end; `fd` is for polling it. */
class InputStream extends Resource {
  constructor(source, fd) { super(); this.source = source; this.fd = fd }
  #take(len, blocking) {
    const bytes = this.source.read(Number(len), blocking)
    if (bytes === null) throw { tag: 'closed' }
    return bytes
  }
  read(len) { return this.#take(len, false) }
  blockingRead(len) { return this.#take(len, true) }
  skip(len) { return BigInt(this.read(len).byteLength) }
  blockingSkip(len) { return BigInt(this.blockingRead(len).byteLength) }
  subscribe() { return new Pollable(this.fd === undefined ? {} : { fd: this.fd, events: POLLIN }) }
}

class OutputStream extends Resource {
  constructor(sink, fd) { super(); this.sink = sink; this.fd = fd }
  checkWrite() { return 65536n }
  write(contents) { this.#put(contents) }
  #put(contents) {
    try {
      this.sink.write(contents)
    } catch (error) {
      if (error instanceof ProcExit) throw error
      throw { tag: error?.code === 'EPIPE' ? 'closed' : 'last-operation-failed', val: new IoError(`${error?.code ?? error}`) }
    }
  }
  blockingWriteAndFlush(contents) { this.#put(contents) }
  flush() {}
  blockingFlush() {}
  writeZeroes(len) { this.#put(new Uint8Array(Number(len))) }
  blockingWriteZeroesAndFlush(len) { this.writeZeroes(len) }
  splice(input, len) {
    const bytes = input.read(len)
    this.#put(bytes)
    return BigInt(bytes.byteLength)
  }
  blockingSplice(input, len) {
    const bytes = input.blockingRead(len)
    this.#put(bytes)
    return BigInt(bytes.byteLength)
  }
  subscribe() { return new Pollable() }
}

/** An open descriptor as an `InputStream`: reads in place (`position` undefined) or from `position` on */
function readSource(fd, position) {
  let at = position
  return {
    read(len, blocking) {
      if (!blocking && at === undefined && !pollFds([{ fd, events: POLLIN }], 0)[0]) return new Uint8Array(0)
      const buffer = new Uint8Array(Math.min(len, 1048576))
      let count
      try {
        count = read(fd, buffer, at === undefined ? -1 : at)
      } catch (error) {
        if (error?.code === 'EPIPE' || error?.code === 'ECONNRESET') return null
        throw { tag: 'last-operation-failed', val: new IoError(`${error?.code ?? error}`) }
      }
      if (count <= 0) return null
      if (at !== undefined) at += count
      return buffer.subarray(0, count)
    },
  }
}

function writeSink(fd, position) {
  let at = position
  return {
    write(contents) {
      const bytes = contents instanceof Uint8Array ? contents : new Uint8Array(contents)
      let done = 0
      while (done < bytes.byteLength) {
        const count = write(fd, bytes.subarray(done), at === undefined ? -1 : at + done)
        if (count <= 0) break
        done += count
      }
      if (at !== undefined) at += done
    },
  }
}

const isTty = fd => {
  try { tcgetattr(fd); return true } catch { return false }
}

const FILE_TYPE = { [0x8000]: 'regular-file', [0x4000]: 'directory', [0x2000]: 'character-device', [0x6000]: 'block-device', [0xa000]: 'symbolic-link', [0xc000]: 'socket' }
const typeOfMode = mode => FILE_TYPE[mode & S_IFMT] ?? 'unknown'
const DIRENT_TYPE = { 4: 'directory', 8: 'regular-file', 10: 'symbolic-link', 2: 'character-device', 6: 'block-device', 1: 'fifo', 12: 'socket' }

/** Resolves `.` and `..` lexically; a path that climbs out of the descriptor's directory is refused (it is confined to it) */
function within(base, relative) {
  if (relative.startsWith('/')) throw 'not-permitted'
  const out = base === '/' ? [] : base.split('/').filter(Boolean)
  const floor = out.length
  for (const part of relative.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length <= floor) throw 'not-permitted'
      out.pop()
    } else out.push(part)
  }
  return '/' + out.join('/')
}

class DirectoryEntryStream extends Resource {
  constructor(entries) { super(); this.entries = entries; this.at = 0 }
  readDirectoryEntry() {
    const entry = this.entries[this.at++]
    return entry
  }
}

let nextHandle = 1

export const INTERFACES = {
  '0.2': createWasip2,
}

/**
 * The 0.2 interface objects, keyed by the name jco imports each by. `exit` receives the process's exit function.
 */
export function createWasip2() {
  const cwd = getcwd()
  const args = argv()
  const env = Object.entries(environ())

  // Descriptors. A preopen is opened lazily; `fd` is the real one.
  class Descriptor extends Resource {
    constructor(path, fd, { type, flags } = {}) {
      super()
      this.path = path
      this.fd = fd
      this.type = type
      this.flags = flags ?? { read: true, write: true }
      this.id = nextHandle++
    }
    #real() {
      if (this.fd === null) this.fd = guard(() => open(this.path, O_RDONLY | O_DIRECTORY))
      return this.fd
    }
    #stat() { return this.fd === null ? stat(this.path) : fstat(this.fd) }
    readViaStream(offset) { return new InputStream(readSource(this.#real(), Number(offset)), undefined) }
    writeViaStream(offset) { return new OutputStream(writeSink(this.#real(), Number(offset))) }
    appendViaStream() { return new OutputStream(writeSink(this.#real(), undefined)) }
    advise() {}
    syncData() { guard(() => fdatasync(this.#real())) }
    getFlags() { return this.flags }
    getType() { return guard(() => typeOfMode(this.#stat().mode)) }
    setSize(size) { guard(() => ftruncate(this.#real(), Number(size))) }
    setTimes(access, modification) { guard(() => futimes(this.#real(), timeOf(access, this.#stat().atimeMs), timeOf(modification, this.#stat().mtimeMs))) }
    read(len, offset) {
      return guard(() => {
        const buffer = new Uint8Array(Math.min(Number(len), 1048576))
        const count = read(this.#real(), buffer, Number(offset))
        return [buffer.slice(0, Math.max(count, 0)), count <= 0]
      })
    }
    write(contents, offset) {
      return guard(() => {
        let done = 0
        while (done < contents.byteLength) {
          const count = write(this.#real(), contents.subarray(done), Number(offset) + done)
          if (count <= 0) break
          done += count
        }
        return BigInt(done)
      })
    }
    readDirectory() {
      return guard(() => {
        const found = getdents(this.#real())
        return new DirectoryEntryStream(found.filter(item => item.name !== '.' && item.name !== '..').map(item => ({ type: DIRENT_TYPE[item.type] ?? 'unknown', name: item.name })))
      })
    }
    sync() { guard(() => fsync(this.#real())) }
    createDirectoryAt(path) { guard(() => mkdir(within(this.path, path), 0o755)) }
    stat() { return guard(() => describe(this.#stat())) }
    statAt(pathFlags, path) {
      return guard(() => describe((pathFlags?.symlinkFollow ? stat : lstat)(within(this.path, path))))
    }
    setTimesAt(pathFlags, path, access, modification) {
      guard(() => {
        const target = within(this.path, path)
        const current = (pathFlags?.symlinkFollow ? stat : lstat)(target)
        utimes(target, timeOf(access, current.atimeMs), timeOf(modification, current.mtimeMs))
      })
    }
    linkAt(_pathFlags, oldPath, newDescriptor, newPath) {
      guard(() => link(within(this.path, oldPath), within(newDescriptor.path, newPath)))
    }
    openAt(pathFlags, path, openFlags, descriptorFlags) {
      return guard(() => {
        const target = within(this.path, path)
        const wantsWrite = !!descriptorFlags?.write
        let flags = openFlags?.directory ? O_RDONLY | O_DIRECTORY : wantsWrite ? (descriptorFlags?.read ? O_RDWR : O_WRONLY) : O_RDONLY
        if (openFlags?.create) flags |= O_CREAT
        if (openFlags?.exclusive) flags |= O_EXCL
        if (openFlags?.truncate) flags |= O_TRUNC
        let real
        try {
          real = open(target, flags, 0o644)
        } catch (error) {
          // a read-only file asked for read and write: rights are not tracked, so fall back to read
          if (wantsWrite && descriptorFlags?.read && (error?.code === 'EACCES' || error?.code === 'EROFS')) real = open(target, O_RDONLY | (openFlags?.directory ? O_DIRECTORY : 0))
          else throw error
        }
        const info = fstat(real)
        const type = typeOfMode(info.mode)
        return new Descriptor(target, real, { type, flags: { read: type === 'directory' || !wantsWrite || !!descriptorFlags?.read, write: wantsWrite && type !== 'directory' } })
      })
    }
    readlinkAt(path) { return guard(() => readlink(within(this.path, path))) }
    removeDirectoryAt(path) { guard(() => rmdir(within(this.path, path))) }
    renameAt(oldPath, newDescriptor, newPath) { guard(() => rename(within(this.path, oldPath), within(newDescriptor.path, newPath))) }
    symlinkAt(target, path) { guard(() => symlink(target, within(this.path, path))) }
    unlinkFileAt(path) { guard(() => unlink(within(this.path, path))) }
    isSameObject(other) { return this === other || (this.fd !== null && other.fd !== null && sameFile(this, other)) }
    metadataHash() { return guard(() => hashOf(this.#stat())) }
    metadataHashAt(pathFlags, path) { return guard(() => hashOf((pathFlags?.symlinkFollow ? stat : lstat)(within(this.path, path)))) }
    [Symbol.dispose]() {
      if (this.fd !== null && this.fd !== undefined && !this.preopen) try { close(this.fd) } catch { /* closed already */ }
    }
  }

  const sameFile = (a, b) => {
    const left = fstat(a.fd), right = fstat(b.fd)
    return left.dev === right.dev && left.ino === right.ino
  }
  const hashOf = info => ({ lower: BigInt(info.ino ?? 0), upper: BigInt(info.dev ?? 0) })
  const timeOf = (change, current) => {
    if (change?.tag === 'timestamp') return Number(change.val.seconds) + change.val.nanoseconds / 1e9
    if (change?.tag === 'now') return Date.now() / 1000
    return current / 1000
  }
  const describe = info => ({
    type: typeOfMode(info.mode),
    linkCount: BigInt(info.nlink ?? 1),
    size: BigInt(info.size ?? 0),
    dataAccessTimestamp: datetime(info.atimeMs ?? 0),
    dataModificationTimestamp: datetime(info.mtimeMs ?? 0),
    statusChangeTimestamp: datetime(info.ctimeMs ?? 0),
  })

  // The preopens follow the rule `wasip1.mjs` uses: `/`, the working directory as `.`, then each top-level directory
  // under its own name (wasi-libc takes the longest prefix, so an absolute path opens that path)
  const preopens = [[new Descriptor('/', null, { type: 'directory' }), '/'], [new Descriptor(cwd, null, { type: 'directory' }), '.']]
  const rootFd = open('/', O_RDONLY | O_DIRECTORY)
  for (const name of rootPreopenNames(cwd, rootFd)) preopens.push([new Descriptor(`/${name}`, null, { type: 'directory' }), `/${name}`])
  close(rootFd)
  for (const [descriptor] of preopens) descriptor.preopen = true

  const stdio = fd => {
    const stream = fd === 0 ? new InputStream(readSource(0), 0) : new OutputStream(writeSink(fd), fd)
    return stream
  }
  const stdin = stdio(0), stdout = stdio(1), stderr = stdio(2)
  class TerminalInput extends Resource {}
  class TerminalOutput extends Resource {}
  const terminalInput = new TerminalInput(), terminalOutput = new TerminalOutput()

  const exit = status => { throw new ProcExit(status?.tag === 'err' ? 1 : 0) }

  const randomBytes = len => {
    const out = new Uint8Array(Number(len))
    for (let i = 0; i < out.length; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(i + 65536, out.length)))
    return out
  }
  const randomU64 = () => new BigUint64Array(randomBytes(8).buffer)[0]

  return {
    'wasi:cli/environment': { getEnvironment: () => env, getArguments: () => args, initialCwd: () => cwd },
    'wasi:cli/exit': { exit, exitWithCode: code => { throw new ProcExit(code) } },
    'wasi:cli/stdin': { getStdin: () => stdin },
    'wasi:cli/stdout': { getStdout: () => stdout },
    'wasi:cli/stderr': { getStderr: () => stderr },
    'wasi:cli/terminal-input': { TerminalInput },
    'wasi:cli/terminal-output': { TerminalOutput },
    'wasi:cli/terminal-stdin': { getTerminalStdin: () => isTty(0) ? terminalInput : undefined },
    'wasi:cli/terminal-stdout': { getTerminalStdout: () => isTty(1) ? terminalOutput : undefined },
    'wasi:cli/terminal-stderr': { getTerminalStderr: () => isTty(2) ? terminalOutput : undefined },
    'wasi:clocks/monotonic-clock': {
      now: nowNs,
      resolution: () => 1000n,
      subscribeInstant: when => new Pollable({ deadline: BigInt(when) }),
      subscribeDuration: duration => new Pollable({ deadline: nowNs() + BigInt(duration) }),
    },
    'wasi:clocks/wall-clock': { now: () => datetime(Date.now()), resolution: () => ({ seconds: 0n, nanoseconds: 1000000 }) },
    'wasi:filesystem/preopens': { getDirectories: () => preopens },
    'wasi:filesystem/types': {
      Descriptor,
      DirectoryEntryStream,
      filesystemErrorCode: error => ERROR_CODE[error?.code?.split?.(':')?.[0]] ?? undefined,
    },
    'wasi:io/error': { Error: IoError },
    'wasi:io/poll': { Pollable, poll },
    'wasi:io/streams': { InputStream, OutputStream },
    'wasi:random/random': { getRandomBytes: randomBytes, getRandomU64: randomU64 },
    'wasi:random/insecure': { getInsecureRandomBytes: randomBytes, getInsecureRandomU64: randomU64 },
    'wasi:random/insecure-seed': { insecureSeed: () => [randomU64(), randomU64()] },
    ...createSockets({ Pollable, InputStream, OutputStream, readSource, writeSink, POLLIN, POLLOUT }),
  }
}

/** The WASI version a component is for, from the names it exports (`wasi:cli/run@0.2.6` is 0.2); the newest 0.2 if unsure */
export function versionOf(exportNames) {
  for (const name of exportNames) {
    const match = /^wasi:[a-z-]+\/[a-z-]+@(\d+\.\d+)/.exec(name)
    if (match) return match[1]
  }
  return '0.2'
}

/**
 * Runs a component the kernel transpiled: `{ js, modules }` (the generated JavaScript, and the core modules by name).
 * Returns the exit status.
 */
export async function runComponent({ js, modules, exports: exportNames = [] }) {
  const version = versionOf(exportNames)
  const table = INTERFACES[version]
  if (!table) {
    write(2, encoder.encode(`${argv()[0] ?? 'component'}: WASI ${version} is not supported\n`), -1)
    return 1
  }
  // a data: URL loads in a browser's worker and in Node's alike (a blob: URL does not in Node)
  const module = await import(/* @vite-ignore */ `data:text/javascript;base64,${base64(js)}`)
  const component = await module.instantiate(name => {
    const compiled = modules[name]
    if (!compiled) throw new Error(`the component has no ${name}`)
    return compiled
  }, table())
  const run = component['wasi:cli/run'] ?? component.run
  if (typeof run?.run !== 'function') {
    write(2, encoder.encode(`${argv()[0] ?? 'component'}: the component exports no wasi:cli/run\n`), -1)
    return 1
  }
  try {
    run.run()
    return 0
  } catch (error) {
    if (error instanceof ProcExit) return error.code
    // run's result<_, _> comes back as a thrown { tag: 'err' } from the transpiled export
    if (error && typeof error === 'object' && 'tag' in error && error.tag === 'err') return 1
    throw error
  }
}

function base64(text) {
  const bytes = encoder.encode(text)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}
