/**
 * Node's `process`, over the syscalls `/bin/node` exposes (`globalThis.ecmaosSyscalls`). Loading it installs `process`,
 * `global`, `Buffer`, `setImmediate`/`clearImmediate` and Node's timer objects where they are missing, which is what a
 * package that was written for Node expects to find.
 *
 * The program lives as long as something holds it: a timer that is not `unref()`ed, a child process, a read of
 * standard input. `process.__ecmaos.finish()` waits for them to end, emits `beforeExit` and `exit`, and ends the process.
 */

const EventEmitter = require('node:events')

const sys = globalThis.ecmaosSyscalls
const native = {
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  setInterval: globalThis.setInterval.bind(globalThis),
  clearInterval: globalThis.clearInterval.bind(globalThis)
}

// What holds the program open

const live = new Set()
const waiting = []

function settle() {
  if (live.size) return
  for (const wake of waiting.splice(0)) wake()
}

/** Holds the program open until the returned function is called */
function hold() {
  const handle = {}
  live.add(handle)
  return () => { if (live.delete(handle)) settle() }
}

/** Resolves once nothing holds the program open, after a turn of the event loop in which nothing started */
async function idle() {
  for (;;) {
    await new Promise(resolve => native.setTimeout(resolve, 0))
    if (!live.size) return
    await new Promise(resolve => waiting.push(resolve))
  }
}

// Timers, as Node's: objects with ref/unref, which keep the program alive unless unref()ed

class Timeout {
  constructor(callback, delay, args, repeat) {
    if (typeof callback !== 'function') throw Object.assign(new TypeError('The "callback" argument must be of type function'), { code: 'ERR_INVALID_ARG_TYPE' })
    this._callback = callback
    this._delay = delay
    this._args = args
    this._repeat = repeat
    this._ref = true
    this._closed = false
    live.add(this)
    this._start()
  }

  _start() {
    const run = () => {
      if (!this._repeat) { this._closed = true; live.delete(this) }
      try { this._callback.apply(this, this._args) } finally { settle() }
    }
    this._id = this._repeat ? native.setInterval(run, this._delay) : native.setTimeout(run, this._delay)
  }

  ref() { this._ref = true; if (!this._closed) live.add(this); return this }
  unref() { this._ref = false; live.delete(this); settle(); return this }
  hasRef() { return this._ref }
  refresh() { if (!this._closed) { (this._repeat ? native.clearInterval : native.clearTimeout)(this._id); this._start() } return this }
  close() {
    if (!this._closed) { this._closed = true; (this._repeat ? native.clearInterval : native.clearTimeout)(this._id) }
    live.delete(this)
    settle()
    return this
  }
  [Symbol.toPrimitive]() { return Number(this._id) }
}

class Immediate {
  constructor(callback, args) {
    this._ref = true
    this._closed = false
    live.add(this)
    this._id = native.setTimeout(() => {
      this._closed = true
      live.delete(this)
      try { callback.apply(this, args) } finally { settle() }
    }, 0)
  }

  ref() { this._ref = true; if (!this._closed) live.add(this); return this }
  unref() { this._ref = false; live.delete(this); settle(); return this }
  hasRef() { return this._ref }
}

const clear = timer => {
  if (timer instanceof Timeout) timer.close()
  else if (timer instanceof Immediate) { native.clearTimeout(timer._id); timer._closed = true; live.delete(timer); settle() } else if (timer !== undefined && timer !== null) { native.clearTimeout(timer); native.clearInterval(timer) }
}

const timers = {
  setTimeout: (callback, delay, ...args) => new Timeout(callback, Number(delay) || 0, args, false),
  setInterval: (callback, delay, ...args) => new Timeout(callback, Number(delay) || 0, args, true),
  setImmediate: (callback, ...args) => new Immediate(callback, args),
  clearTimeout: clear,
  clearInterval: clear,
  clearImmediate: clear
}

// process

const env = new Proxy(Object.assign(Object.create(null), sys.env ?? {}), {
  set(target, key, value) { target[key] = String(value); return true }
})

const startedAt = performance.now()
const encoder = new TextEncoder()

/** Bytes of a stream chunk: a string, a Buffer, a typed array */
function bytesOf(chunk, encoding) {
  if (typeof chunk === 'string') return (encoding && encoding !== 'utf8' && encoding !== 'utf-8' && typeof Buffer !== 'undefined') ? Buffer.from(chunk, encoding) : encoder.encode(chunk)
  return chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
}

const isTerminal = fd => { try { sys.tcgetattr(fd); return true } catch { return false } }

function terminalStream(fd) {
  const { Writable } = require('node:stream')
  const stream = new Writable({
    decodeStrings: false,
    write(chunk, encoding, callback) {
      try { sys.writeAll(fd, bytesOf(chunk, encoding)); callback() } catch (error) { callback(error) }
    }
  })
  stream.fd = fd
  stream.isTTY = isTerminal(fd)
  const size = () => { try { return sys.winsize(fd) } catch { return undefined } }
  if (stream.isTTY) {
    Object.defineProperties(stream, {
      columns: { get: () => size()?.cols ?? 80, enumerable: true },
      rows: { get: () => size()?.rows ?? 24, enumerable: true }
    })
    stream.getWindowSize = () => [size()?.cols ?? 80, size()?.rows ?? 24]
    stream.hasColors = () => true
    stream.getColorDepth = () => 8
  }
  stream.destroySoon = stream.destroy
  return stream
}

// POSIX termios bits (`ICANON`, `ECHO`, `ISIG`) that raw mode clears
const ISIG = 0x1
const ICANON = 0x2
const ECHO = 0x8

function stdinStream() {
  const { Readable } = require('node:stream')
  let release
  let timer
  const stream = new Readable({
    read() {
      if (timer !== undefined) return
      const pull = () => {
        timer = undefined
        let ready
        try { ready = sys.poll([{ fd: 0, events: sys.POLLIN | sys.POLLHUP }], 0)[0] !== 0 } catch { ready = true }
        if (!ready) { timer = native.setTimeout(pull, 10); return }
        const buffer = new Uint8Array(65536)
        let n
        try { n = sys.read(0, buffer, -1) } catch (error) { if (error?.code === 'EINTR') { timer = native.setTimeout(pull, 0); return } stream.destroy(error); return }
        if (n <= 0) { release?.(); release = undefined; stream.push(null); return }
        if (!stream.push(typeof Buffer !== 'undefined' ? Buffer.from(buffer.subarray(0, n)) : buffer.slice(0, n))) return
        timer = native.setTimeout(pull, 0)
      }
      release ??= hold()
      timer = native.setTimeout(pull, 0)
    },
    destroy(error, callback) { if (timer !== undefined) native.clearTimeout(timer); release?.(); release = undefined; callback(error) }
  })
  stream.fd = 0
  stream.isTTY = isTerminal(0)
  if (stream.isTTY) {
    let original
    stream.isRaw = false
    stream.setRawMode = mode => {
      original ??= sys.tcgetattr(0)
      const next = { ...original }
      next.lflag = mode ? original.lflag & ~(ICANON | ECHO | ISIG) : original.lflag
      sys.tcsetattr(0, next)
      stream.isRaw = Boolean(mode)
      return stream
    }
  }
  // a stream nobody reads from lets the program end; one that is being read holds it
  stream.on('pause', () => { release?.(); release = undefined })
  stream.on('resume', () => { release ??= hold() })
  return stream
}

let exiting = false
let streams

const process = new EventEmitter()
const lazy = (name, make) => Object.defineProperty(process, name, {
  configurable: true,
  enumerable: true,
  get() { streams ??= {}; return (streams[name] ??= make()) },
  set(value) { streams ??= {}; streams[name] = value }
})

Object.assign(process, {
  title: 'node',
  version: 'v22.12.0',
  versions: { node: '22.12.0', v8: '12.4.254.21-node.21', ecmaos: '1' },
  arch: 'x64',
  platform: 'linux',
  release: { name: 'node', lts: 'Jod' },
  argv: sys.argv ? [...sys.argv] : [],
  argv0: 'node',
  execArgv: [],
  execPath: '/bin/node',
  env,
  pid: sys.getpid(),
  ppid: sys.getppid(),
  exitCode: undefined,
  config: { variables: {} },
  features: { inspector: false, ipv6: true, tls: false },
  allowedNodeEnvironmentFlags: new Set(),
  cwd: () => sys.getcwd(),
  chdir: directory => { sys.chdir(String(directory)) },
  umask: mask => sys.umask(mask),
  getuid: () => sys.getuid(),
  geteuid: () => sys.geteuid(),
  getgid: () => sys.getgid(),
  getegid: () => sys.getegid(),
  uptime: () => (performance.now() - startedAt) / 1000,
  hrtime: Object.assign(previous => {
    const now = performance.now()
    const seconds = Math.floor(now / 1000)
    const nanoseconds = Math.floor((now % 1000) * 1e6)
    if (!previous) return [seconds, nanoseconds]
    let s = seconds - previous[0]
    let n = nanoseconds - previous[1]
    if (n < 0) { s--; n += 1e9 }
    return [s, n]
  }, { bigint: () => BigInt(Math.floor(performance.now() * 1e6)) }),
  memoryUsage: Object.assign(() => ({ rss: performance.memory?.totalJSHeapSize ?? 0, heapTotal: performance.memory?.totalJSHeapSize ?? 0, heapUsed: performance.memory?.usedJSHeapSize ?? 0, external: 0, arrayBuffers: 0 }), { rss: () => performance.memory?.totalJSHeapSize ?? 0 }),
  cpuUsage: () => ({ user: Math.round(performance.now() * 1000), system: 0 }),
  resourceUsage: () => ({}),
  nextTick: (callback, ...args) => { queueMicrotask(() => callback(...args)) },
  emitWarning: (warning, type, code) => {
    const name = typeof type === 'string' ? type : (type?.type ?? 'Warning')
    const message = warning instanceof Error ? warning.message : String(warning)
    if (process.listenerCount('warning')) { process.emit('warning', warning instanceof Error ? warning : Object.assign(new Error(message), { name, code })); return }
    try { sys.writeAll(2, encoder.encode(`(node:${process.pid}) ${code ? `[${code}] ` : ''}${name}: ${message}\n`)) } catch { /* nowhere to say it */ }
  },
  kill: (pid, signal = 'SIGTERM') => {
    const numbers = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGUSR1: 10, SIGUSR2: 12, SIGTERM: 15, SIGCONT: 18, SIGSTOP: 19 }
    sys.custom('proc_kill', pid, typeof signal === 'number' ? signal : (numbers[signal] ?? 15))
    return true
  },
  abort: () => process.exit(134),
  binding: () => { throw new Error('process.binding is not supported') },
  getBuiltinModule: name => { try { return require(name.startsWith('node:') ? name : `node:${name}`) } catch { return undefined } },
  exit: code => {
    if (code !== undefined && code !== null) process.exitCode = code
    const status = Number(process.exitCode ?? 0) || 0
    if (!exiting) { exiting = true; try { process.emit('exit', status) } catch { /* the exit listeners are the program's */ } }
    sys.exit(Number(process.exitCode ?? status) || 0)
  },
  reallyExit: code => sys.exit(code ?? 0)
})
lazy('stdout', () => terminalStream(1))
lazy('stderr', () => terminalStream(2))
lazy('stdin', stdinStream)

/** For the interpreter and the other built-ins: what holds the program open, and how it ends */
Object.defineProperty(process, '__ecmaos', {
  value: {
    hold,
    idle,
    timers,
    /** Waits for the program to have nothing left to do, then ends it with `process.exitCode` */
    async finish() {
      for (;;) {
        await idle()
        process.emit('beforeExit', Number(process.exitCode ?? 0) || 0)
        if (!live.size) break
      }
      process.exit()
    }
  }
})

// What a package written for Node expects to find

function install() {
  const g = globalThis
  g.global ??= g
  if (!g.process || g.process.__ecmaos === undefined) g.process = process
  if (typeof g.Buffer === 'undefined') g.Buffer = require('node:buffer').Buffer
  g.setTimeout = timers.setTimeout
  g.setInterval = timers.setInterval
  g.setImmediate = timers.setImmediate
  g.clearTimeout = timers.clearTimeout
  g.clearInterval = timers.clearInterval
  g.clearImmediate = timers.clearImmediate
}

module.exports = process
install()
