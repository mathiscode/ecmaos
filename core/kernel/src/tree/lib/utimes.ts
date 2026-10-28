/**
 * `utimes` that works on a directory and a file one may not write, and `lutimes`, which sets a symbolic link's own times.
 * zenfs sets times through a descriptor opened for writing, which a directory cannot have, so `touch dir` and rsync
 * keeping a directory's times failed with EISDIR; Linux only asks that the caller own the file (or be root). Here the
 * file is opened for reading and its times are set on that open file, which checks ownership.
 */

import * as vfs from '@zenfs/core/vfs/sync'
import { define_syscall, syscalls, type Process } from '@zenfs/linux'

declare module '@zenfs/linux/uapi/abi' {
  interface Syscalls {
    lutimes(path: string, atime: number, mtime: number): number
  }
}

/** Sets the times (in seconds) of `path`, or of the link itself with `noFollow` */
function setTimes(proc: Process, path: string, atime: number, mtime: number, noFollow: boolean): number {
  const handle = vfs.open(proc.context, path, { flag: 'r', allowDirectory: true, preserveSymlinks: noFollow })
  try {
    handle.utimesSync(atime * 1000, mtime * 1000)
  } finally {
    handle.closeSync()
  }
  return 0
}

let installed = false
export function installUtimes(): void {
  if (installed) return
  installed = true
  syscalls.set('utimes', ((proc: Process, path: string, atime: number, mtime: number) => setTimes(proc, path, atime, mtime, false)) as never)
  define_syscall('lutimes', (proc: Process, path: string, atime: number, mtime: number) => setTimes(proc, path, atime, mtime, true))
}
