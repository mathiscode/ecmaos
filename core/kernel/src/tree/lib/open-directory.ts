/**
 * `open` with `O_DIRECTORY` of something that is not a directory fails with `ENOTDIR`, as on Linux; zenfs opens it
 * anyway. Programs that walk a path one directory at a time without following links (rsync's safe open, `find`'s
 * `openat` walks) depend on the error to know where the directories end.
 */

import { fs } from '@zenfs/core'
import { syscalls, type Process } from '@zenfs/linux'
import { withErrno } from 'kerium'

const O_DIRECTORY = 0x10000
const O_NOFOLLOW = 0x20000
const S_IFMT = 0o170000
const S_IFDIR = 0o040000

type Handler = (proc: Process, path: string, flags: number, ...rest: unknown[]) => unknown

let installed = false
export function installOpenDirectory(): void {
  if (installed) return
  installed = true
  const open = syscalls.get('open') as unknown as Handler | undefined
  if (!open) return
  syscalls.set('open', ((proc: Process, path: string, flags: number, ...rest: unknown[]) => {
    if (typeof path === 'string' && typeof flags === 'number' && flags & O_DIRECTORY) {
      let mode: number | undefined
      try {
        const stats = flags & O_NOFOLLOW ? fs.lstatSync.call(proc.context, path) : fs.statSync.call(proc.context, path)
        if (stats) mode = Number(stats.mode)
      } catch { /* the open says why */ }
      if (mode !== undefined && (mode & S_IFMT) !== S_IFDIR) throw withErrno('ENOTDIR')
    }
    return open(proc, path, flags, ...rest)
  }) as never)
}
