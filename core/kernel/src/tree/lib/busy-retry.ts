/**
 * File system calls, tried again while the file is busy. The store behind a file system answers synchronously from what
 * it has loaded, and refuses with EAGAIN a call that needs a part of a file still loading (or a file whose metadata a
 * background flush holds); by then nothing has changed (`close` writes the metadata out before it lets the descriptor
 * go), so trying again is safe. Linux never says EAGAIN for a regular file or a path: a program takes it for a failure
 * (GNU make exits 1 when reading its own binary or closing a file is refused). A read or write of a pipe, a device or a
 * socket is left alone, since EAGAIN is what a non-blocking one gives. See `execve-retry.ts`.
 */
import { syscalls, type Process } from '@zenfs/linux'

const ATTEMPTS = 50
const PAUSE_MS = 4
const S_IFMT = 0o170000, S_IFREG = 0o100000, S_IFDIR = 0o040000

/** Calls on a path, or on a descriptor whatever it is */
const ALWAYS = ['open', 'close', 'dup2', 'dup3', 'stat', 'lstat', 'fstat', 'statfs', 'fstatfs', 'getdents', 'lseek', 'ftruncate',
  'fsync', 'fdatasync', 'truncate', 'rename', 'unlink', 'mkdir', 'rmdir', 'link', 'symlink', 'readlink', 'realpath', 'chmod',
  'fchmod', 'chown', 'fchown', 'access', 'utimes', 'futimes']
/** Calls on a descriptor that are retried only for a regular file or a directory */
const ON_FILES = ['read', 'write']

/** Whether `fd` is a regular file or a directory, whose EAGAIN can only be the store's */
function isFile(proc: Process, fd: unknown): boolean {
  try {
    const handle = proc.context.descriptors.get(fd as number) as unknown as { inode: { mode: number } } | undefined
    const type = (handle?.inode.mode ?? 0) & S_IFMT
    return type === S_IFREG || type === S_IFDIR
  } catch {
    return false
  }
}

let installed = false
export function installBusyRetry(): void {
  if (installed) return
  installed = true
  for (const name of [...ALWAYS, ...ON_FILES]) {
    const original = syscalls.get(name as never) as ((proc: Process, ...args: unknown[]) => unknown) | undefined
    if (!original) continue
    const always = ALWAYS.includes(name)
    syscalls.set(name as never, (async (proc: Process, ...args: unknown[]) => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await original(proc, ...args)
        } catch (error) {
          if ((error as { code?: string })?.code !== 'EAGAIN' || attempt >= ATTEMPTS || (!always && !isFile(proc, args[0]))) throw error
          await new Promise(resolve => setTimeout(resolve, PAUSE_MS))
        }
      }
    }) as never)
  }
}
