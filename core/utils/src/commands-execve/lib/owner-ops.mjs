/**
 * `chmod`, `chown` and `utimes` for an owner who has no access bits on a file, or on a directory. The filesystem
 * refuses the plain call in those cases, so the kernel is asked (`fs_chmod`, `fs_chown`, `fs_utimes`); it applies
 * Linux's rule (the owner or root) and its message is the one reported.
 */

const refusedByTheFilesystem = error => /EISDIR|EACCES/.test(`${error?.code ?? ''} ${error?.message ?? ''}`)

export async function chmodOwned(sys, path, mode) {
  try {
    sys.chmod(path, mode)
  } catch (error) {
    if (!refusedByTheFilesystem(error)) throw error
    await sys.custom('fs_chmod', path, mode)
  }
}

export async function chownOwned(sys, path, uid, gid) {
  try {
    sys.chown(path, uid, gid)
  } catch (error) {
    if (!refusedByTheFilesystem(error)) throw error
    await sys.custom('fs_chown', path, uid, gid)
  }
}

/** Seconds, as Node's `utimes` takes them; a negative time means now. */
export async function utimesOwned(sys, path, atime, mtime) {
  try {
    sys.utimes(path, atime < 0 ? Date.now() / 1000 : atime, mtime < 0 ? Date.now() / 1000 : mtime)
  } catch (error) {
    if (!refusedByTheFilesystem(error)) throw error
    await sys.custom('fs_utimes', path, atime, mtime)
  }
}

/** `lutimes`: the times of a symlink itself. There is no such call in the program's syscalls, so the kernel does it. */
export async function lutimesOwned(sys, path, atime, mtime) {
  await sys.custom('fs_utimes', path, atime < 0 ? Date.now() / 1000 : atime, mtime < 0 ? Date.now() / 1000 : mtime, 1)
}
