/**
 * ecmaOS's `/bin/node` interpreter: the worker-hosted body `binfmt_js` points plain JS/ESM programs at.
 * It is bundled (`vite-plugin-bin-node.ts`) into one module with no imports and written to `/bin/node` at boot,
 * because the kernel loads an interpreter from a `blob:`/`data:` URL, which cannot resolve bare specifiers. The
 * program it loads cannot import anything either.
 * The syscall channel (`ready`) is private to this module instance, so a loaded program cannot import
 * `@zenfs/linux/uapi/*` itself; this interpreter exposes its wrappers on `globalThis.ecmaosSyscalls`.
 */

import { ready, exit, getpid, getppid, getuid, geteuid, getgid, getegid } from '@zenfs/linux/uapi/process'
import {
  open as openRaw, read, close, write, getcwd,
  mkdir as mkdirRaw, rmdir, unlink, rename, chmod, chown, stat, lstat, access, getdents,
  link, symlink, readlink, utimes, statfs, chdir, lseek, ioctl, tcgetattr, tcsetattr, winsize, pipe, dup, dup2
} from '@zenfs/linux/uapi/fs'
import { parseArgs, installConsole, runSource, readStdin, isTty, startRepl, Usage } from './node-cli.mjs'
import { syscall, syscall_async, copyOut, on_signal, off_signal, pending as pending_signals } from '@zenfs/linux/uapi/base'

/**
 * `poll(2)`: waits until one of `fds` (`[{ fd, events }]`) is ready or `timeout` ms pass (negative waits forever, 0
 * only looks) and returns each `revents` in order. A pipe whose other end closed reports `POLLIN`, so a read returns
 * 0.
 */
function poll(fds, timeout = -1) {
  syscall('poll', fds, timeout)
  const { view } = copyOut(class { constructor(buffer, offset) { this.view = new DataView(buffer, offset) } })
  return fds.map((_, i) => view.getUint16(i * 2, true))
}

const POLLIN = 0x1
const POLLOUT = 0x4
const POLLERR = 0x8
const POLLHUP = 0x10

/**
 * The file mode creation mask. The kernel holds the real one for the process (`proc_umask`); this copy is read once
 * when the program starts, and the wrappers below take it off the mode of everything the program creates, which is
 * where POSIX applies it. `umask(mask)` sets it for this process and for what it starts afterwards.
 */
let creationMask = 0o022
const open = (path, flags, mode = 0) => openRaw(path, flags, flags & 0x40 ? mode & ~creationMask : mode)
const mkdir = (path, mode = 0o777) => mkdirRaw(path, mode & ~creationMask)
const umask = mask => {
  const old = creationMask
  if (mask !== undefined) {
    creationMask = mask & 0o777
    syscall_async('proc_umask', creationMask).catch(() => {})
  }
  return old
}

const O_RDONLY = 0
const O_WRONLY = 1
const O_CREAT = 0x40
const O_TRUNC = 0x200
const O_DIRECTORY = 0x10000
const S_IFMT = 0xf000
const S_IFDIR = 0x4000
const S_IFLNK = 0xa000

/** `readdir`, `copyFile` and recursive `rm`, built once over raw syscalls for the coreutils. */

/**
 * Directory listing: `open(O_DIRECTORY)`, one `getdents`, `close`. `getdents` has no cursor and returns the whole
 * directory on every call, so it is called once; a listing that does not fit in one region write is truncated.
 */
function readdir(path) {
  const fd = open(path, O_RDONLY | O_DIRECTORY, 0)
  try {
    const names = []
    const entries = getdents(fd)
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue
      names.push(entry.name)
    }
    return names
  } finally {
    close(fd)
  }
}

/** `true` if `path` is a directory, via a real `stat`, not a name-based guess. */
function isDirectory(path) {
  return (stat(path).mode & S_IFMT) === S_IFDIR
}

/** `true` if `path` is itself a symlink, via a real `lstat` (unlike `stat`, does not follow it). */
function isSymbolicLink(path) {
  return (lstat(path).mode & S_IFMT) === S_IFLNK
}

/**
 * Writes `data` in full, looping on short writes (a pipe holds 65536 bytes and may accept less). `position` (-1 for
 * the descriptor's own) is advanced after each partial write; `dd` and `tee -a` write at an explicit offset since
 * there is no `O_APPEND`.
 */
function writeAll(fd, data, position = -1) {
  let offset = 0
  let pos = position
  while (offset < data.byteLength) {
    const n = write(fd, data.subarray(offset), pos)
    offset += n
    if (pos >= 0) pos += n
  }
}

/**
 * Real file copy: read the source in chunks, write them to a freshly created/truncated destination.
 * `mode` is the mode a destination that does not exist yet is created with; an existing one keeps its own.
 */
function copyFile(source, destination, mode = 0o644) {
  const srcFd = open(source, O_RDONLY, 0)
  try {
    const destFd = open(destination, O_WRONLY | O_CREAT | O_TRUNC, mode)
    try {
      const chunkSize = 65536
      while (true) {
        const buffer = new Uint8Array(chunkSize)
        const n = read(srcFd, buffer, -1)
        if (n <= 0) break
        writeAll(destFd, buffer.subarray(0, n))
      }
    } finally {
      close(destFd)
    }
  } finally {
    close(srcFd)
  }
}

/** Recursively remove a real directory tree: `readdir` + recurse, `unlink` files, `rmdir` on the way back up. */
function rmRecursive(path) {
  if (isDirectory(path)) {
    for (const name of readdir(path)) rmRecursive(`${path}/${name}`)
    rmdir(path)
  } else {
    unlink(path)
  }
}

/** A short read is not EOF (a pipe or device can return less mid-stream), so loop until `read()` returns 0. */
function readWholeFile(path) {
  const fd = open(path, 0 /* O_RDONLY */)
  const chunkSize = 65536
  const chunks = []

  try {
    while (true) {
      const buffer = new Uint8Array(chunkSize)
      const n = read(fd, buffer, -1)
      if (n <= 0) break
      chunks.push(buffer.subarray(0, n))
    }
  } finally {
    close(fd)
  }

  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  return bytes
}

/** Base64-encode into a `data:` URL, which (unlike `blob:`) a bare Node worker_threads Worker can import too. */
function toDataUrl(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return 'data:text/javascript;base64,' + btoa(binary)
}

const ready_ = await ready
// the mask this process starts with: its shell's, or its parent's
try { const mask = Number(await syscall_async('proc_umask', -1)); if (mask >= 0) creationMask = mask & 0o777 } catch { /* the default stands */ }

// Run as `node file [args...]`: the program is the file, and it sees its own path as `argv[0]`, as it would under
// `execve`. With no file there is nothing to run, and this interpreter is not a REPL.
const hosted = ready_.exe === '/bin/node'
const say = text => { try { write(2, new TextEncoder().encode(text)) } catch { /* nowhere to say it */ } }
// What `node ...` was asked to do (a file, `-e`, a script on stdin, the REPL, or just `--help`); a program run by its
// own path is not that, and has no command line of this kind.
const cli = hosted ? parseArgs(ready_.argv.slice(1)) : undefined
const init = cli?.action === 'file' ? (() => {
  const exe = cli.file.startsWith('/') ? cli.file : `${getcwd().replace(/\/$/, '')}/${cli.file}`
  return { ...ready_, exe, argv: [exe, ...cli.rest] }
})() : hosted ? { ...ready_, argv: ['/bin/node', ...(cli.rest ?? [])] } : ready_

// The wrappers exposed to the loaded program. `readdir`, `isDirectory`, `copyFile` and `rmRecursive` are this
// interpreter's own helpers. `custom` is `syscall_async`, because a main-thread capability can take unboundedly long
// and the sync path would block the worker with `Atomics.wait`.
globalThis.ecmaosSyscalls = {
  open, read, write, writeAll, close, getcwd, exit, custom: syscall_async,
  mkdir, umask, rmdir, unlink, rename, chmod, chown, stat, lstat, access, utimes, statfs,
  readdir, isDirectory, isSymbolicLink, copyFile, rmRecursive,
  link, symlink, readlink,
  // The terminal ioctls a program needs for raw mode and window size: `tcgetattr`/`tcsetattr`
  // (`TCGETS`/`TCSETS`, `lflag`/`iflag`/`oflag`/`cc`), `winsize` (`TIOCGWINSZ`), and the bare `ioctl`.
  ioctl, tcgetattr, tcsetattr, winsize,
  // `pipe()` returns `[read, write]`; `dup`/`dup2` copy a descriptor. Together they are how a shell
  // wires a child's stdin and stdout; the child inherits fds 0 to 2 only, so a pipe is handed over
  // by `dup2`ing its end onto one of those before the spawn.
  pipe, dup, dup2,
  // Process identity, and the fd/cwd calls a shell needs.
  getpid, getppid, getuid, geteuid, getgid, getegid, chdir, lseek,
  // The job-control shim (`job-control.ts`), each op named for the POSIX call it stands in for. `waitpid` returns `{
  // pid, code, signal }`, or `null` for `WNOHANG` with nothing ready; `untraced` (`WUNTRACED`) also returns for a
  // stopped child as `{ pid, stopped: true, signal }`. `spawn` is `posix_spawn`: `{ env, fds: { childFd: myFd } }`.
  waitpid: async (pid, nohang = false, untraced = false) => {
    const packed = await syscall_async('proc_waitpid', pid, (nohang ? 1 : 0) | (untraced ? 2 : 0))
    if (!packed) return null
    const status = packed % 65536
    if ((status & 0xff) === 0x7f) return { pid: Math.floor(packed / 65536), stopped: true, signal: (status >> 8) & 0xff }
    const signal = status & 0x7f
    return { pid: Math.floor(packed / 65536), ...(signal ? { signal } : { code: (status >> 8) & 0xff }) }
  },
  setpgid: (pid, pgid) => syscall_async('proc_setpgid', pid, pgid),
  getpgid: (pid = 0) => syscall_async('proc_getpgid', pid),
  killpg: (pgid, signal) => syscall_async('proc_killpg', pgid, signal),
  tcsetpgrp: pid => syscall_async('proc_tcsetpgrp', pid),
  spawn: (command, argv, options = {}) =>
    syscall_async('proc_spawn', command, JSON.stringify(argv), options.cwd ?? '', JSON.stringify({ env: options.env, fds: options.fds, pgid: options.pgid, tty: options.tty, credentials: options.credentials, trace: options.trace })),
  // Signal handlers (`sigaction`): a handler runs when the blocking syscall it interrupted returns
  // `EINTR`, so a program blocked in `read()` on the terminal sees `SIGWINCH` this way.
  onSignal: on_signal, offSignal: off_signal,
  // The signals raised on this thread and not yet delivered, as `1 << sig`. A handler runs only when a
  // *blocking* syscall returns, and the next one clears whatever is left, so a program that waits in an
  // async syscall (`waitpid`) reads this afterwards to see what arrived meanwhile.
  pendingSignals: pending_signals,
  // `poll(fds, timeout)` and its event bits: wait on several fds at once (a terminal and a socket).
  poll, POLLIN, POLLOUT, POLLERR, POLLHUP,
  O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC, O_DIRECTORY,
  // `argv` and `env` come from the `init` message; `argv[0]` is the program's path. `cwd` is read with `getcwd()`
  // since the process may `chdir()`.
  argv: init.argv, env: init.env
}

// A rejection nobody handles (an asynchronous syscall the program did not await, which the kernel then refused)
// would stop this worker without ending the process, and whatever waits for the process would wait for ever. It is
// the program's error: say so on stderr and end with status 1, as an uncaught exception does.
function reportUnhandled(reason) {
  const name = String(init.argv?.[0] ?? 'program').split('/').pop()
  const message = reason instanceof Error ? reason.message : String(reason)
  try { write(2, new TextEncoder().encode(`${name}: ${message}\n`)) } catch { /* nowhere to say it */ }
  exit(1)
}
if (typeof globalThis.addEventListener === 'function') {
  globalThis.addEventListener('unhandledrejection', event => { event.preventDefault?.(); reportUnhandled(event.reason) })
}
if (typeof globalThis.process?.on === 'function') globalThis.process.on('unhandledRejection', reportUnhandled)

// `console` is the guest's: its output goes to fd 1 and 2, where redirection and pipes can see it
const sys = { read, write, writeAll, open, close, tcgetattr, tcsetattr, winsize, poll, POLLIN, POLLHUP, onSignal: on_signal, offSignal: off_signal, readWholeFile, O_WRONLY, O_CREAT, O_TRUNC }
const { inspect } = installConsole(sys)
// `process.argv` is the guest's: the program and its arguments
if (globalThis.process) globalThis.process.argv = init.argv

/**
 * `node` with an option or no file: help, version, `-e`/`-p`, a script on stdin, the REPL. Returns the exit status.
 */
async function runCommandLine() {
  if (cli.error) { say(`node: ${cli.error}\n`); return 9 }
  if (cli.action === 'help') { writeAll(1, new TextEncoder().encode(Usage)); return 0 }
  if (cli.action === 'version') { writeAll(1, new TextEncoder().encode(`${globalThis.process?.version ?? 'v0.0.0'}\n`)); return 0 }

  const run = async source => {
    try { await runSource(source, { module: cli.module, print: cli.print, toDataUrl, inspect, sys }); return 0 } catch (error) {
      // The stack names the program by its whole `data:` URL; say `[eval]` instead
      const text = error instanceof Error ? error.stack ?? error.message : String(error)
      say(`${text.replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g, '[eval]')}\n`)
      return 1
    }
  }
  const repl = () => startRepl(sys, { env: init.env ?? {} })

  if (cli.action === 'eval') {
    const status = await run(cli.code)
    return cli.interactive && status === 0 ? repl() : status
  }
  if (cli.action === 'stdin') return run(readStdin(sys))
  // No file and no script: a terminal gets the REPL, a pipe or file on stdin is the script (as Node does)
  return isTty(sys, 0) ? repl() : run(readStdin(sys))
}

try {
  if (hosted && cli.action !== 'file') exit(await runCommandLine())

  let source
  try { source = readWholeFile(init.exe) } catch (error) {
    // `node missing.js` is an ordinary mistake, not a crash in the interpreter
    if (!hosted) throw error
    say(`node: ${cli.file}: ${error instanceof Error ? error.message : error}\n`)
    exit(1)
  }
  await import(toDataUrl(source))
  exit(0)
} catch (error) {
  // A program that calls exit() itself never reaches here - exit() tears the thread down.
  console.error(error)
  exit(1)
}
