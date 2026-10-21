/**
 * ENOTDIR where Linux says it: a path whose lookup goes through something that is not a directory (`/dev/null/x`,
 * `file.txt/name`) fails with ENOTDIR, not ENOENT. The file systems answer ENOENT for any lookup that finds nothing,
 * so when a path call fails that way, the path's ancestors are looked at: the first that exists and is not a directory
 * makes it ENOTDIR. Programs tell the two apart (libc-test's `utime` does; `mkdir -p` and shells report them
 * differently).
 */
import { fs, type Credentials } from '@zenfs/core'
import { syscalls, type Process } from '@zenfs/linux'
import { withErrno } from 'kerium'

/** Each call, and which of its arguments are paths */
const PATH_ARGUMENTS: Record<string, number[]> = {
  open: [0], stat: [0], lstat: [0], access: [0], utimes: [0], truncate: [0], chmod: [0], chown: [0], readlink: [0],
  realpath: [0], mkdir: [0], rmdir: [0], unlink: [0], statfs: [0], rename: [0, 1], link: [0, 1], symlink: [1]
}

const S_IFMT = 0o170000, S_IFDIR = 0o040000

/** Whether a lookup of `path` would pass through something that exists and is not a directory */
function throughFile(proc: Process, path: string): boolean {
  const absolute = path.startsWith('/') ? path : `${proc.cwd.replace(/\/$/, '')}/${path}`
  const parts = absolute.split('/').filter(Boolean)
  for (let i = 1; i < parts.length; i++) {
    const ancestor = '/' + parts.slice(0, i).join('/')
    let mode: number
    try {
      mode = (fs.statSync.call(proc.context as { credentials: Credentials }, ancestor) as { mode: number }).mode
    } catch {
      return false
    }
    if ((mode & S_IFMT) !== S_IFDIR) return true
  }
  return false
}

let installed = false
export function installNotDirectory(): void {
  if (installed) return
  installed = true
  for (const [name, indexes] of Object.entries(PATH_ARGUMENTS)) {
    const original = syscalls.get(name as never) as ((proc: Process, ...args: unknown[]) => unknown) | undefined
    if (!original) continue
    syscalls.set(name as never, (async (proc: Process, ...args: unknown[]) => {
      try {
        return await original(proc, ...args)
      } catch (error) {
        if ((error as { code?: string })?.code !== 'ENOENT') throw error
        if (indexes.some(index => typeof args[index] === 'string' && throughFile(proc, args[index] as string))) {
          throw withErrno('ENOTDIR', 'Not a directory')
        }
        throw error
      }
    }) as never)
  }
}
