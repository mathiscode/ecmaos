/**
 * `posix_spawn` for both C libraries: WALI's musl (`wali-host.mjs`, through the sysroot's musl patch) and Emscripten's
 * with libecmaos (`wasi-preview1.mjs`, through `core/utils/wasm/lib/ecmaos/process.c`) make the same call,
 * `__ecmaos_spawn(path, argv, envp, actions, count, flags, pgrp, sigdefault, sigmask)`, with the same layout: 32-bit
 * pointers, a 24-byte file action and 8 bytes read from each sigset.
 *
 * There is no fork. The child starts with a copy of this process's descriptor table, close-on-exec flags and all; the
 * file actions are replayed on that copy (a file to open is opened here and handed over, and `dup2` clears the flag on
 * its target, as it does in a forked child); then what is still close-on-exec goes, as the exec would close it, and
 * the kernel starts the program with exactly the rest. Its directory, process group, session and signals are what the
 * actions and attributes say.
 */
import { syscall_raw, returned } from '@zenfs/linux/uapi/base'
import { getdents } from '@zenfs/linux/uapi/fs'

const EBADF = 9, ENOTDIR = 20, EINVAL = 22
const O_CLOEXEC = 0x80000
const S_IFMT = 0o170000, S_IFDIR = 0o040000
const FDOP_CLOSE = 1, FDOP_DUP2 = 2, FDOP_OPEN = 3, FDOP_CHDIR = 4, FDOP_FCHDIR = 5
const POSIX_SPAWN_SETPGROUP = 2, POSIX_SPAWN_SETSIGDEF = 4, POSIX_SPAWN_SETSIGMASK = 8, POSIX_SPAWN_SETSID = 0x80
/** SIGKILL and SIGSTOP, which no mask holds back */
const UNBLOCKABLE = (1n << 8n) | (1n << 18n)

const decoder = new TextDecoder()

export function getcwd() {
  const value = syscall_raw('getcwd')
  return value < 0 ? '/' : decoder.decode(returned.slice())
}

export const absolute = (path, cwd) => path.startsWith('/') ? path : `${cwd.endsWith('/') ? cwd : `${cwd}/`}${path}`

/** The path an open descriptor names, through procfs */
function pathOf(fd) {
  const length = syscall_raw('readlink', `/proc/self/fd/${fd}`)
  return length < 0 ? length : decoder.decode(returned.slice(0, length))
}

/** Whether a path is a directory, or the errno that says why it cannot be one */
function directory(path) {
  const value = syscall_raw('stat', path)
  if (value < 0) return value
  const mode = new DataView(returned.buffer, returned.byteOffset).getUint32(24, true)
  return (mode & S_IFMT) === S_IFDIR ? 0 : -ENOTDIR
}

/** The descriptors open in this process, as procfs lists them: also the ones the host did not see made */
export function openDescriptors() {
  const dir = syscall_raw('open', '/proc/self/fd', 0x10000 /* O_DIRECTORY */, 0)
  if (dir >= 0) {
    try {
      return getdents(dir).map(entry => Number(entry.name)).filter(fd => Number.isInteger(fd) && fd !== dir)
    } catch {
      // listed below instead
    } finally {
      syscall_raw('close', dir)
    }
  }
  return Array.from({ length: 256 }, (_, fd) => fd).filter(fd => syscall_raw('fstat', fd) >= 0)
}

/** `NAME=value` strings as the object the kernel takes for an environment */
export const environment_of = entries => Object.fromEntries(entries.map(entry => {
  const equals = entry.indexOf('=')
  return equals < 0 ? [entry, ''] : [entry.slice(0, equals), entry.slice(equals + 1)]
}))

/**
 * Starts the child `__ecmaos_spawn` asks for.
 * @param memory `view()` of the program's memory, `string(ptr)` and `strings(ptr)` (a NULL-terminated array) read from it
 * @param signals the caller's `ignored(resets)` (a kernel sigset: the signals it ignores, less those reset to their
 * default) and `mask()` (its mask, as a 64-bit sigset)
 * @param isCloexec whether one of the caller's descriptors is close-on-exec
 * @returns the child's pid, or a negative Linux errno
 */
export function spawn(memory, signals, isCloexec, pathPtr, argvPtr, envpPtr, opsPtr, count, flags, pgrp, defaultsPtr, maskPtr) {
  const path = memory.string(pathPtr)
  const argv = memory.strings(argvPtr)
  const env = environment_of(memory.strings(envpPtr))
  // child fd -> { source: this process's fd, cloexec }
  const children = new Map(openDescriptors().map(fd => [fd, { source: fd, cloexec: isCloexec(fd) }]))
  let cwd = getcwd()
  const opened = []
  try {
    const dv = memory.view()
    for (let i = 0; i < count; i++) {
      const op = opsPtr + i * 24
      const cmd = dv.getInt32(op, true), fd = dv.getInt32(op + 4, true), srcfd = dv.getInt32(op + 8, true)
      const oflag = dv.getInt32(op + 12, true), mode = dv.getInt32(op + 16, true)
      const opPath = () => memory.string(dv.getUint32(op + 20, true))
      switch (cmd) {
        case FDOP_CLOSE:
          children.delete(fd)
          break
        case FDOP_DUP2: {
          const source = children.get(srcfd)
          if (!source) return -EBADF
          children.set(fd, { source: source.source, cloexec: false })
          break
        }
        case FDOP_OPEN: {
          const file = syscall_raw('open', absolute(opPath(), cwd), oflag, mode)
          if (file < 0) return file
          opened.push(file)
          children.set(fd, { source: file, cloexec: (oflag & O_CLOEXEC) !== 0 })
          break
        }
        case FDOP_CHDIR: {
          const dir = absolute(opPath(), cwd)
          const check = directory(dir)
          if (check < 0) return check
          cwd = dir
          break
        }
        case FDOP_FCHDIR: {
          const source = children.get(fd)
          if (!source) return -EBADF
          const dir = pathOf(source.source)
          if (typeof dir === 'number') return dir
          const check = directory(dir)
          if (check < 0) return check
          cwd = dir
          break
        }
        default:
          return -EINVAL
      }
    }
    const kept = Object.fromEntries([...children].filter(([, entry]) => !entry.cloexec).map(([fd, entry]) => [fd, entry.source]))
    const resets = flags & POSIX_SPAWN_SETSIGDEF ? memory.view().getBigUint64(defaultsPtr, true) : 0n
    const blocked = flags & POSIX_SPAWN_SETSIGMASK ? memory.view().getBigUint64(maskPtr, true) : signals.mask()
    const options = {
      env,
      fds: kept,
      exactFds: true,
      signals: { ignored: signals.ignored(resets), blocked: Number(blocked & ~UNBLOCKABLE & 0x7fffffffn) },
      ...(flags & POSIX_SPAWN_SETPGROUP ? { pgid: pgrp } : {}),
      ...(flags & POSIX_SPAWN_SETSID ? { setsid: true } : {})
    }
    return syscall_raw('proc_spawn', path, JSON.stringify(argv), cwd, JSON.stringify(options))
  } finally {
    for (const file of opened) syscall_raw('close', file)
  }
}
