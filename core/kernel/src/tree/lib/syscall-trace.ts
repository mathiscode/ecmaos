/**
 * `strace` support: a record of the system calls a process makes.
 *
 * Every call a program makes crosses to the main thread through `dispatch`, which runs the handler registered in
 * `@zenfs/linux`'s `syscalls` table. This wraps those handlers, the way `installSyscallPolicy` does, so a process with
 * a {@link Tracer} gets one line per call and any other process pays one `Map` lookup. The wrapper goes outside the
 * policy one, so a call a manifest refuses (`EPERM`) still shows up.
 *
 * It logs the stream; it is not `ptrace`. The traced program is never stopped, stepped or have its memory read, and the
 * arguments are what the kernel received, already decoded by the worker's syscall layer (strings and byte arrays rather
 * than pointers).
 */

import { syscalls, thread_of } from '@zenfs/linux'
import type { Process } from '@zenfs/linux'
import { Errno, strerror } from 'kerium'

export interface TraceOptions {
  /** How much of a string or buffer is shown (`strace -s`) */
  strsize?: number
  /** Only these syscalls (`-e trace=`): names, or the sets `file`, `desc`, `process`, `network`, `signal`, `memory`, `ipc` */
  include?: string[]
  /** Not these (`-e trace=!`) */
  exclude?: string[]
  /** A time on each line: `time` is `HH:MM:SS`, `micro` adds microseconds (`-tt`), `relative` is since the last call (`-r`) */
  clock?: 'time' | 'micro' | 'relative'
  /** Follow the processes the traced one starts (`-f`) */
  follow?: boolean
  /** Count instead of printing, and print a table at the end (`-c`) */
  summary?: boolean
  /** Show the path an fd was opened from beside its number (`-y`) */
  paths?: boolean
}

export interface Tracer {
  readonly options: TraceOptions
  /** Appends text to wherever the trace goes; resolves when it has been taken, which is what paces the traced program */
  write(text: string): Promise<void>
  /** Per syscall name: calls, errors, milliseconds */
  readonly counts: Map<string, { calls: number, errors: number, ms: number }>
  /** Lines already waiting to be written: a slow reader slows the traced program rather than growing this */
  last: number
  /** Pids this tracer is following */
  readonly pids: Set<number>
}

const tracers = new Map<number, Tracer>()

export function createTracer(options: TraceOptions, write: (text: string) => Promise<void>): Tracer {
  return { options, write, counts: new Map(), last: 0, pids: new Set() }
}

/** Starts recording `pid`'s calls into `tracer` */
export function traceProcess(pid: number, tracer: Tracer): void {
  tracers.set(pid, tracer)
  tracer.pids.add(pid)
}

export function tracerOf(pid: number): Tracer | undefined {
  return tracers.get(pid)
}

/** Stops recording `pid` (it ended, or the reader of the trace went away) */
export function untraceProcess(pid: number): void {
  const tracer = tracers.get(pid)
  tracers.delete(pid)
  tracer?.pids.delete(pid)
}

// ---------------------------------------------------------------------------------------------------------------------
// Names for things

const SIGNALS: Record<number, string> = {
  1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 4: 'SIGILL', 5: 'SIGTRAP', 6: 'SIGABRT', 7: 'SIGBUS', 8: 'SIGFPE', 9: 'SIGKILL',
  10: 'SIGUSR1', 11: 'SIGSEGV', 12: 'SIGUSR2', 13: 'SIGPIPE', 14: 'SIGALRM', 15: 'SIGTERM', 17: 'SIGCHLD', 18: 'SIGCONT',
  19: 'SIGSTOP', 20: 'SIGTSTP', 21: 'SIGTTIN', 22: 'SIGTTOU', 28: 'SIGWINCH'
}

const OPEN_FLAGS: Array<[number, string]> = [
  [0o100, 'O_CREAT'], [0o200, 'O_EXCL'], [0o400, 'O_NOCTTY'], [0o1000, 'O_TRUNC'], [0o2000, 'O_APPEND'],
  [0o4000, 'O_NONBLOCK'], [0o200000, 'O_DIRECTORY'], [0o400000, 'O_NOFOLLOW'], [0o2000000, 'O_CLOEXEC']
]

export function formatOpenFlags(flags: number): string {
  const access = ['O_RDONLY', 'O_WRONLY', 'O_RDWR'][flags & 3] ?? `${flags & 3}`
  const names = OPEN_FLAGS.filter(([bit]) => flags & bit).map(([, name]) => name)
  const known = OPEN_FLAGS.reduce((all, [bit]) => all | bit, 3)
  const rest = flags & ~known
  return [access, ...names, ...(rest ? [`0x${rest.toString(16)}`] : [])].join('|')
}

const WHENCE = ['SEEK_SET', 'SEEK_CUR', 'SEEK_END']

export function formatSignal(signal: number): string {
  return SIGNALS[signal] ?? `${signal}`
}

/** `"text"...` with control characters escaped as C does, cut at `limit` bytes */
export function formatBytes(data: Uint8Array | string, limit: number): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  const shown = bytes.subarray(0, limit)
  let out = ''
  for (const byte of shown) {
    if (byte === 0x22) out += '\\"'
    else if (byte === 0x5c) out += '\\\\'
    else if (byte === 0x0a) out += '\\n'
    else if (byte === 0x0d) out += '\\r'
    else if (byte === 0x09) out += '\\t'
    else if (byte >= 0x20 && byte < 0x7f) out += String.fromCharCode(byte)
    else out += `\\${byte.toString(8).padStart(3, '0')}`
  }
  return `"${out}"${bytes.length > limit ? '...' : ''}`
}

// ---------------------------------------------------------------------------------------------------------------------
// What each syscall's arguments are

type Kind = 'path' | 'fd' | 'int' | 'oct' | 'hex' | 'open' | 'data' | 'count' | 'signal' | 'whence' | 'argv' | 'env' | 'skip' | 'pid'

const ARGS: Record<string, Kind[]> = {
  open: ['path', 'open', 'oct'], close: ['fd'], read: ['fd', 'count'], write: ['fd', 'data'],
  lseek: ['fd', 'int', 'whence'], ftruncate: ['fd', 'int'], fsync: ['fd'], fdatasync: ['fd'], dup: ['fd'], dup2: ['fd', 'fd'],
  ioctl: ['fd', 'hex', 'hex'], poll: ['skip', 'int'], pipe: ['hex'], stat: ['path'], lstat: ['path'], fstat: ['fd'],
  statfs: ['path'], fstatfs: ['fd'], getdents: ['fd'], mkdir: ['path', 'oct'], rmdir: ['path'], unlink: ['path'],
  rename: ['path', 'path'], link: ['path', 'path'], symlink: ['path', 'path'], readlink: ['path'], realpath: ['path'],
  truncate: ['path', 'int'], chmod: ['path', 'oct'], fchmod: ['fd', 'oct'], chown: ['path', 'int', 'int'], fchown: ['fd', 'int', 'int'],
  access: ['path', 'oct'], chdir: ['path'], getcwd: [], exit: ['int'], spawn: ['path', 'argv', 'env', 'path'],
  execve: ['path', 'argv', 'env'], wait: ['pid'], kill: ['pid', 'signal'], sigaction: ['signal', 'skip'],
  proc_spawn: ['path', 'argv', 'path'], proc_wait: ['pid'], proc_waitpid: ['pid', 'hex'], proc_kill: ['pid', 'signal'],
  proc_killpg: ['pid', 'signal'], proc_setpgid: ['pid', 'pid'], proc_getpgid: ['pid'], proc_tcsetpgrp: ['pid']
}

/** Sets of calls, as `strace -e trace=SET` names them */
const SETS: Record<string, string[]> = {
  file: ['open', 'stat', 'lstat', 'statfs', 'mkdir', 'rmdir', 'unlink', 'rename', 'link', 'symlink', 'readlink', 'realpath', 'truncate', 'chmod', 'chown', 'access', 'chdir', 'getxattr', 'setxattr', 'removexattr', 'listxattr', 'execve', 'utimes'],
  desc: ['open', 'close', 'read', 'write', 'lseek', 'ftruncate', 'fsync', 'fdatasync', 'dup', 'dup2', 'ioctl', 'poll', 'pipe', 'fstat', 'fstatfs', 'getdents', 'fchmod', 'fchown', 'futimes'],
  process: ['spawn', 'execve', 'exit', 'wait', 'kill', 'proc_spawn', 'proc_wait', 'proc_waitpid', 'proc_kill', 'proc_killpg', 'proc_setpgid', 'proc_getpgid', 'proc_tcsetpgrp'],
  signal: ['kill', 'sigaction', 'proc_kill', 'proc_killpg'],
  network: ['net_bind', 'net_listen', 'net_connect', 'net_accept', 'sockets_create', 'sockets_connect', 'sockets_close', 'sockets_list']
}

/** Whether the options let this call through */
export function wanted(name: string, options: TraceOptions): boolean {
  const expand = (names: string[]) => names.flatMap(entry => SETS[entry] ?? [entry])
  if (options.exclude && expand(options.exclude).includes(name)) return false
  if (options.include && !expand(options.include).includes(name)) return false
  return true
}

/** Bytes arrive as a typed array or, after crossing the worker, as a plain array of numbers */
function asBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  if (Array.isArray(value) && value.every(item => typeof item === 'number')) return Uint8Array.from(value as number[])
  return undefined
}

function formatArg(kind: Kind, value: unknown, options: TraceOptions, fdPath: (fd: number) => string | undefined): string {
  const limit = options.strsize ?? 32
  switch (kind) {
    case 'path': return typeof value === 'string' ? formatBytes(value, 4096) : String(value)
    case 'fd': {
      const where = options.paths && typeof value === 'number' ? fdPath(value) : undefined
      return where ? `${value}<${where}>` : String(value)
    }
    case 'open': return typeof value === 'number' ? formatOpenFlags(value) : String(value)
    case 'oct': return typeof value === 'number' ? `0${value.toString(8)}` : String(value)
    case 'hex': return typeof value === 'number' || typeof value === 'bigint' ? `0x${value.toString(16)}` : String(value)
    case 'signal': return typeof value === 'number' ? formatSignal(value) : String(value)
    case 'whence': return typeof value === 'number' ? (WHENCE[value] ?? String(value)) : String(value)
    case 'data': { const bytes = typeof value === 'string' ? value : asBytes(value); return bytes ? formatBytes(bytes, limit) : String(value) }
    case 'argv': return Array.isArray(value) ? `[${value.slice(0, 8).map(item => formatBytes(String(item), limit)).join(', ')}${value.length > 8 ? ', ...' : ''}]` : String(value)
    case 'env': return Array.isArray(value) ? `/* ${value.length} vars */` : value && typeof value === 'object' ? `/* ${Object.keys(value).length} vars */` : String(value)
    case 'skip': return '...'
    default: return typeof value === 'bigint' ? value.toString() : String(value)
  }
}

/** Arguments as a line shows them: known calls by kind, others as the values were given */
export function formatCall(name: string, args: unknown[], options: TraceOptions, fdPath: (fd: number) => string | undefined = () => undefined): string {
  const kinds = ARGS[name]
  const shown = kinds
    ? kinds.map((kind, index) => formatArg(kind, args[index], options, fdPath))
    : args.map(value => asBytes(value) ? formatBytes(asBytes(value)!, options.strsize ?? 32) : typeof value === 'string' ? formatBytes(value, options.strsize ?? 32) : typeof value === 'object' && value !== null ? JSON.stringify(value).slice(0, 64) : String(value))
  if (name === 'write') shown.push(String(asBytes(args[1])?.byteLength ?? (typeof args[1] === 'string' ? new TextEncoder().encode(args[1]).byteLength : '?')))
  return `${name}(${shown.join(', ')})`
}

/** `= 3`, or `= -1 ENOENT (No such file or directory)` */
export function formatResult(result: number | bigint | void, error: unknown): { text: string, failed: boolean } {
  const errno = error ? (error as { errno?: number }).errno : typeof result === 'number' && result < 0 && -result in Errno ? -result : undefined
  if (error && errno === undefined) return { text: `= -1 EIO (${(error as Error).message ?? error})`, failed: true }
  if (errno !== undefined) {
    const code = Errno[errno] ?? `E${errno}`
    let message = ''
    try { const text = strerror(errno as Errno); message = text.charAt(0).toUpperCase() + text.slice(1) } catch { /* an errno kerium has no text for */ }
    return { text: `= -1 ${code}${message ? ` (${message})` : ''}`, failed: true }
  }
  return { text: `= ${result ?? 0}`, failed: false }
}

// ---------------------------------------------------------------------------------------------------------------------
// The wrapper

const wrapped = new WeakSet<object>()
const pace = new Map<Tracer, Promise<void>>()

function clockPrefix(tracer: Tracer, now: number): string {
  const { clock } = tracer.options
  if (!clock) return ''
  if (clock === 'relative') {
    const gap = tracer.last ? (now - tracer.last) / 1000 : 0
    tracer.last = now
    return `${gap.toFixed(6)} `
  }
  const date = new Date(performance.timeOrigin + now)
  const time = date.toTimeString().slice(0, 8)
  return clock === 'micro' ? `${time}.${String(Math.floor((performance.timeOrigin + now) % 1000 * 1000)).padStart(6, '0')} ` : `${time} `
}

/** Queues a line behind the ones before it and resolves when it has been written */
function emit(tracer: Tracer, text: string): Promise<void> {
  const next = (pace.get(tracer) ?? Promise.resolve()).then(() => tracer.write(text)).catch(() => { for (const pid of [...tracer.pids]) untraceProcess(pid) })
  pace.set(tracer, next)
  return next
}

/** The line a call prints. `read` shows what came back, taken from the thread's shared region before the worker sees it. */
async function record(tracer: Tracer, proc: Process, name: string, args: unknown[], result: number | bigint | void, error: unknown, start: number, fixed?: string): Promise<void> {
  const end = performance.now()
  const formatted = formatResult(result, error)
  const text = fixed ?? formatted.text
  const failed = formatted.failed
  const entry = tracer.counts.get(name) ?? { calls: 0, errors: 0, ms: 0 }
  entry.calls++
  entry.ms += end - start
  if (failed) entry.errors++
  tracer.counts.set(name, entry)
  if (tracer.options.summary) return

  const fdText = (fd: unknown) => formatArg('fd', fd, tracer.options, number => fdPathOf(proc, number))
  let line: string
  if (name === 'read' && !failed) {
    let data = new Uint8Array(0)
    if (typeof result === 'number' && result > 0) { try { data = thread_of(proc).region.slice(0, result) } catch { /* the region is not readable here */ } }
    line = `read(${fdText(args[0])}, ${formatBytes(data, tracer.options.strsize ?? 32)}, ${args[1]}) ${text}`
  } else line = `${formatCall(name, args, tracer.options, number => fdPathOf(proc, number))} ${text}`
  const pid = tracer.pids.size > 1 ? `[pid ${String(proc.pid).padStart(3)}] ` : ''
  await emit(tracer, `${clockPrefix(tracer, end)}${pid}${line}\n`)
}

function fdPathOf(proc: Process, fd: number): string | undefined {
  try { return proc.context.descriptors.get(fd)?.path } catch { return undefined }
}

/**
 * Wraps every syscall handler now registered. Safe to call again after later `define_syscall`s: a handler already
 * wrapped is skipped.
 */
export function installSyscallTrace(): void {
  for (const [name, handler] of syscalls.entries()) {
    if (wrapped.has(handler as object)) continue
    const original = handler as (proc: Process, ...args: unknown[]) => number | bigint | void | Promise<number | bigint | void>
    const traced = async (proc: Process, ...args: unknown[]): Promise<number | bigint | void> => {
      const tracer = tracers.get(proc.pid)
      if (!tracer || !wanted(name as string, tracer.options)) return original(proc, ...args)
      const start = performance.now()
      // `exit` never returns to the caller, so its line is written before it runs, as `exit_group(0) = ?` is
      if (name === 'exit') { await record(tracer, proc, name, args, undefined, undefined, start, '= ?'); return original(proc, ...args) }
      let result: number | bigint | void
      try {
        result = await original(proc, ...args)
      } catch (error) {
        await record(tracer, proc, name as string, args, undefined, error, start)
        throw error
      }
      await record(tracer, proc, name as string, args, result, undefined, start)
      return result
    }
    wrapped.add(traced)
    syscalls.set(name, traced as typeof handler)
  }
}

/** The `-c` table */
export function summaryTable(tracer: Tracer): string {
  const rows = [...tracer.counts.entries()].sort((a, b) => b[1].ms - a[1].ms)
  const total = rows.reduce((sum, [, entry]) => sum + entry.ms, 0) || 1
  const calls = rows.reduce((sum, [, entry]) => sum + entry.calls, 0)
  const errors = rows.reduce((sum, [, entry]) => sum + entry.errors, 0)
  const head = '% time     seconds  usecs/call     calls    errors syscall\n------ ----------- ----------- --------- --------- ----------------\n'
  const body = rows.map(([name, entry]) => `${(entry.ms / total * 100).toFixed(2).padStart(6)} ${(entry.ms / 1000).toFixed(6).padStart(11)} ${String(Math.round(entry.ms * 1000 / entry.calls)).padStart(11)} ${String(entry.calls).padStart(9)} ${(entry.errors ? String(entry.errors) : '').padStart(9)} ${name}`).join('\n')
  const foot = `\n------ ----------- ----------- --------- --------- ----------------\n100.00 ${(total / 1000).toFixed(6).padStart(11)} ${''.padStart(11)} ${String(calls).padStart(9)} ${(errors ? String(errors) : '').padStart(9)} total\n`
  return head + body + foot
}

/** The line at the end of a traced process */
export function exitLine(proc: Process, tracer: Tracer): string {
  const code = proc.code
  return `${tracer.pids.size > 1 ? `[pid ${String(proc.pid).padStart(3)}] ` : ''}+++ exited with ${code ?? 0} +++\n`
}

export async function finishTrace(proc: Process, tracer: Tracer): Promise<void> {
  if (tracer.options.summary) {
    if (tracer.pids.size <= 1) await emit(tracer, summaryTable(tracer))
  } else {
    await emit(tracer, exitLine(proc, tracer))
  }
}
