/**
 * Node's `child_process`, over `proc_spawn` and `proc_wait`. A child's standard streams are pipes this process polls (a
 * read of a pipe that has nothing would block the whole thread), and while a child runs, the program is held open.
 * `spawnSync` and the other `*Sync` functions wait with the blocking form of the same syscalls.
 */

const sys = globalThis.ecmaosSyscalls
const { EventEmitter } = require('node:events')
const { Buffer } = require('node:buffer')
const { Readable, Writable } = require('node:stream')

const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGABRT: 6, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20 }
const signalName = number => Object.keys(SIGNALS).find(name => SIGNALS[name] === number) ?? null

/** The program a command names: a path as it is, else the first executable of that name on `PATH` */
function resolveCommand(command, env, cwd) {
  if (command.includes('/')) return command.startsWith('/') ? command : require('node:path').resolve(cwd, command)
  for (const directory of String(env.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(':')) {
    if (!directory) continue
    try { sys.access(`${directory}/${command}`, 1); return `${directory}/${command}` } catch { /* not there */ }
  }
  return undefined
}

function notFound(command, spawnargs) {
  return Object.assign(new Error(`spawn ${command} ENOENT`), { errno: -2, code: 'ENOENT', syscall: `spawn ${command}`, path: command, spawnargs })
}

/** `[command, args]` for a shell command line: `/bin/sh -c` */
const shellFor = (line, shell) => [typeof shell === 'string' ? shell : '/bin/sh', ['-c', line]]

/** Options as Node documents them, with the defaults filled in */
function normalize(file, args, options) {
  if (!Array.isArray(args)) { options = args; args = [] }
  options = { ...(options ?? {}) }
  const env = options.env ?? process.env
  const cwd = options.cwd ? String(options.cwd) : process.cwd()
  let command = file
  let argv = [...args]
  if (options.shell) [command, argv] = shellFor([file, ...args].join(' '), options.shell)
  let stdio = options.stdio ?? 'pipe'
  if (typeof stdio === 'string') stdio = [stdio, stdio, stdio]
  stdio = [0, 1, 2].map(index => stdio[index] ?? 'pipe')
  return { command, args: argv, env, cwd, stdio, options, argv0: options.argv0 ?? command }
}

/** What `proc_waitpid` packs: `{ code }` or `{ signal }` */
function unpack(packed) {
  const status = packed % 65536
  const signal = status & 0x7f
  return signal ? { code: null, signal: signalName(signal) } : { code: (status >> 8) & 0xff, signal: null }
}

/** The descriptors a child gets: pipes for 'pipe', the caller's own for 'inherit', /dev/null for 'ignore' */
function plumb(stdio) {
  const mine = {}
  const theirs = {}
  const close = []
  stdio.forEach((kind, index) => {
    if (kind === 'pipe' || kind === undefined) {
      const [read, write] = sys.pipe()
      if (index === 0) { theirs[0] = read; mine[0] = write; close.push(read) } else { theirs[index] = write; mine[index] = read; close.push(write) }
    } else if (kind === 'ignore' || kind === null) {
      const fd = sys.open('/dev/null', index === 0 ? sys.O_RDONLY : sys.O_WRONLY, 0)
      theirs[index] = fd
      close.push(fd)
    } else if (kind === 'inherit') {
      theirs[index] = index
    } else if (typeof kind === 'number') {
      theirs[index] = kind
    } else if (kind && typeof kind.fd === 'number') {
      theirs[index] = kind.fd
    }
  })
  return { mine, theirs, close }
}

const spawnOptions = (plan, setup, extra = {}) => JSON.stringify({ env: Object.fromEntries(Object.entries(setup.env).map(([key, value]) => [key, String(value)])), fds: plan.theirs, ...extra })

/** A Readable that polls descriptor `fd` until it ends */
function pipeReader(fd, onEnd) {
  let timer
  let release
  const stream = new Readable({
    read() {
      if (timer !== undefined) return
      release ??= process.__ecmaos.hold()
      const pull = () => {
        timer = undefined
        let ready
        try { ready = sys.poll([{ fd, events: sys.POLLIN | sys.POLLHUP }], 0)[0] !== 0 } catch { ready = true }
        if (!ready) { timer = setTimeout(pull, 5); return }
        const buffer = new Uint8Array(65536)
        let n
        try { n = sys.read(fd, buffer, -1) } catch { n = 0 }
        if (n <= 0) { try { sys.close(fd) } catch { /* closed */ } release?.(); release = undefined; onEnd?.(); stream.push(null); return }
        if (stream.push(Buffer.from(buffer.subarray(0, n)))) timer = setTimeout(pull, 0)
      }
      timer = setTimeout(pull, 0)
    },
    destroy(error, callback) { if (timer !== undefined) clearTimeout(timer); release?.(); release = undefined; try { sys.close(fd) } catch { /* closed */ } callback(error) }
  })
  return stream
}

function pipeWriter(fd) {
  return new Writable({
    write(chunk, _encoding, callback) { try { sys.writeAll(fd, chunk); callback() } catch (error) { callback(error) } },
    final(callback) { try { sys.close(fd) } catch { /* closed */ } callback() },
    destroy(error, callback) { try { sys.close(fd) } catch { /* closed */ } callback(error) }
  })
}

class ChildProcess extends EventEmitter {
  constructor() {
    super()
    this.pid = undefined
    this.exitCode = null
    this.signalCode = null
    this.killed = false
    this.connected = false
    this.stdin = null
    this.stdout = null
    this.stderr = null
    this.stdio = [null, null, null]
    this.spawnfile = undefined
    this.spawnargs = []
  }

  kill(signal = 'SIGTERM') {
    if (this.pid === undefined || this.exitCode !== null || this.signalCode !== null) return false
    sys.custom('proc_kill', this.pid, typeof signal === 'number' ? signal : (SIGNALS[signal] ?? 15)).catch(() => {})
    this.killed = true
    return true
  }

  send() { throw Object.assign(new Error('Channel closed'), { code: 'ERR_IPC_CHANNEL_CLOSED' }) }
  disconnect() {}
  ref() { return this }
  unref() { return this }
  [Symbol.dispose]() { this.kill() }
}

function spawn(file, args, options) {
  const setup = normalize(file, args, options)
  const child = new ChildProcess()
  const resolved = resolveCommand(setup.command, setup.env, setup.cwd)
  child.spawnfile = setup.command
  child.spawnargs = [setup.argv0, ...setup.args]
  if (!resolved) {
    const error = notFound(setup.command, child.spawnargs)
    queueMicrotask(() => { child.emit('error', error); child.emit('close', -2, null) })
    return child
  }
  const plan = plumb(setup.stdio)
  const release = process.__ecmaos.hold()
  sys.custom('proc_spawn', resolved, JSON.stringify([setup.argv0, ...setup.args]), setup.cwd, spawnOptions(plan, setup)).then(pid => {
    for (const fd of plan.close) { try { sys.close(fd) } catch { /* closed */ } }
    child.pid = pid
    child.emit('spawn')
    return sys.custom('proc_wait', pid)
  }).then(status => {
    if (status === undefined) { release(); return }
    const code = status
    const signal = null
    child.exitCode = code
    child.signalCode = signal
    child.emit('exit', code, signal)
    // a stream nobody reads would never end, and 'close' waits for it: Node drains them at exit too
    for (const stream of [child.stdout, child.stderr]) if (stream && !stream.listenerCount('data') && !stream.listenerCount('readable')) stream.resume()
    // 'close' follows once the streams are drained
    const open = [child.stdout, child.stderr].filter(stream => stream && !stream.readableEnded && !stream.destroyed)
    const finish = () => { child.emit('close', code, signal); release() }
    if (!open.length) { setTimeout(finish, 0); return }
    let left = open.length
    for (const stream of open) stream.once('end', () => { if (--left === 0) finish() }).once('close', () => { if (--left < 0) return })
  }, error => {
    release()
    for (const fd of plan.close) { try { sys.close(fd) } catch { /* closed */ } }
    child.emit('error', Object.assign(error instanceof Error ? error : new Error(String(error)), { syscall: `spawn ${setup.command}`, path: setup.command, spawnargs: child.spawnargs }))
    child.emit('close', -1, null)
  })
  if (plan.mine[0] !== undefined) child.stdin = pipeWriter(plan.mine[0])
  if (plan.mine[1] !== undefined) child.stdout = pipeReader(plan.mine[1])
  if (plan.mine[2] !== undefined) child.stderr = pipeReader(plan.mine[2])
  child.stdio = [child.stdin, child.stdout, child.stderr]
  return child
}

function spawnSync(file, args, options) {
  const setup = normalize(file, args, options)
  const resolved = resolveCommand(setup.command, setup.env, setup.cwd)
  const spawnargs = [setup.argv0, ...setup.args]
  if (!resolved) return { pid: 0, output: null, stdout: null, stderr: null, status: null, signal: null, error: notFound(setup.command, spawnargs) }
  const plan = plumb(setup.stdio)
  const input = setup.options.input
  const pid = sys.customSync('proc_spawn', resolved, JSON.stringify(spawnargs), setup.cwd, spawnOptions(plan, setup))
  for (const fd of plan.close) { try { sys.close(fd) } catch { /* closed */ } }
  if (plan.mine[0] !== undefined) {
    if (input !== undefined) { try { sys.writeAll(plan.mine[0], typeof input === 'string' ? Buffer.from(input) : input) } catch { /* the child did not read it */ } }
    sys.close(plan.mine[0])
  }
  const chunks = { 1: [], 2: [] }
  const open = [1, 2].filter(index => plan.mine[index] !== undefined)
  const drain = timeout => {
    if (!open.length) return
    const results = sys.poll(open.map(index => ({ fd: plan.mine[index], events: sys.POLLIN | sys.POLLHUP })), timeout)
    open.slice().forEach((index, at) => {
      if (!results[at]) return
      const buffer = new Uint8Array(65536)
      let n
      try { n = sys.read(plan.mine[index], buffer, -1) } catch { n = 0 }
      if (n > 0) chunks[index].push(Buffer.from(buffer.subarray(0, n)))
      else { try { sys.close(plan.mine[index]) } catch { /* closed */ } open.splice(open.indexOf(index), 1) }
    })
  }
  const deadline = setup.options.timeout ? Date.now() + setup.options.timeout : Infinity
  let packed
  let timedOut = false
  for (;;) {
    drain(open.length ? 20 : 0)
    packed = sys.customSync('proc_waitpid', pid, 1)
    if (packed) break
    if (Date.now() > deadline) { sys.customSync('proc_kill', pid, SIGNALS[setup.options.killSignal ?? 'SIGTERM'] ?? 15); timedOut = true; packed = sys.customSync('proc_waitpid', pid, 0); break }
    if (!open.length) { packed = sys.customSync('proc_waitpid', pid, 0); break }
  }
  while (open.length) drain(20)
  const { code, signal } = unpack(packed)
  const stdout = plan.mine[1] !== undefined ? Buffer.concat(chunks[1]) : null
  const stderr = plan.mine[2] !== undefined ? Buffer.concat(chunks[2]) : null
  const encoding = setup.options.encoding
  const show = bytes => (bytes && encoding && encoding !== 'buffer' ? bytes.toString(encoding) : bytes)
  const result = { pid, output: [null, show(stdout), show(stderr)], stdout: show(stdout), stderr: show(stderr), status: code, signal }
  if (timedOut) result.error = Object.assign(new Error(`spawnSync ${setup.command} ETIMEDOUT`), { code: 'ETIMEDOUT', errno: -110, syscall: `spawnSync ${setup.command}`, path: setup.command, spawnargs })
  return result
}

function failure(command, result, encoding) {
  const text = bytes => (bytes && encoding && encoding !== 'buffer' ? bytes.toString(encoding) : bytes)
  const reason = result.signal ? `Command failed: ${command} (signal ${result.signal})` : `Command failed: ${command}${result.stderr?.length ? '\n' + String(result.stderr) : ''}`
  return Object.assign(new Error(reason), { status: result.status, signal: result.signal, output: result.output, pid: result.pid, stdout: text(result.stdout), stderr: text(result.stderr), cmd: command })
}

function execFileSync(file, args, options) {
  if (!Array.isArray(args)) { options = args; args = [] }
  const result = spawnSync(file, args, { stdio: ['pipe', 'pipe', 'inherit'], ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw failure([file, ...args].join(' '), result, options?.encoding)
  return result.stdout
}

function execSync(command, options) {
  const result = spawnSync(command, [], { shell: true, stdio: ['pipe', 'pipe', 'inherit'], ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw failure(command, result, options?.encoding)
  return result.stdout
}

/** exec and execFile: collect the output and call back once the child has closed */
function collect(file, args, options, callback, label) {
  if (typeof options === 'function') { callback = options; options = undefined }
  const child = spawn(file, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] })
  const encoding = options?.encoding === undefined ? 'utf8' : options.encoding
  const out = []
  const err = []
  child.stdout?.on('data', chunk => out.push(chunk))
  child.stderr?.on('data', chunk => err.push(chunk))
  let timer
  if (options?.timeout) timer = setTimeout(() => child.kill(options.killSignal ?? 'SIGTERM'), options.timeout)
  const done = (error, code, signal) => {
    clearTimeout(timer)
    const show = chunks => (encoding === 'buffer' ? Buffer.concat(chunks) : Buffer.concat(chunks).toString(encoding))
    const stdout = show(out)
    const stderr = show(err)
    let failed = error
    if (!failed && (code !== 0 || signal)) failed = Object.assign(new Error(`Command failed: ${label}${stderr.length ? '\n' + stderr : ''}`), { code, killed: child.killed, signal, cmd: label })
    if (failed) { failed.stdout = stdout; failed.stderr = stderr }
    callback?.(failed ?? null, stdout, stderr)
  }
  child.on('error', error => done(error))
  child.on('close', (code, signal) => done(null, code, signal))
  return child
}

const exec = (command, options, callback) => {
  if (typeof options === 'function') { callback = options; options = undefined }
  return collect(command, [], { ...options, shell: true }, callback, command)
}
const execFile = (file, args, options, callback) => {
  if (typeof args === 'function') return collect(file, [], undefined, args, file)
  if (!Array.isArray(args)) return collect(file, [], args, options, file)
  return collect(file, args, options, callback, [file, ...args].join(' '))
}
const util = require('node:util')
const promisified = fn => (...args) => {
  let child
  const promise = new Promise((resolve, reject) => {
    child = fn(...args, (error, stdout, stderr) => (error ? reject(error) : resolve({ stdout, stderr })))
  })
  promise.child = child
  return promise
}
Object.defineProperty(exec, util.promisify.custom, { value: promisified(exec) })
Object.defineProperty(execFile, util.promisify.custom, { value: promisified(execFile) })

const fork = (modulePath, args, options) => {
  if (!Array.isArray(args)) { options = args; args = [] }
  return spawn(options?.execPath ?? '/bin/node', [...(options?.execArgv ?? []), String(modulePath), ...args], { stdio: 'inherit', ...options })
}

module.exports = { ChildProcess, spawn, spawnSync, exec, execSync, execFile, execFileSync, fork }
