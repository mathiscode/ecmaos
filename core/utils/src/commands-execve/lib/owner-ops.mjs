/**
 * `chmod` and `chown` for someone who owns a file but has no access bits on it, or whose file is a directory.
 *
 * Changing a mode or an owner depends on owning the file, not on read or write access to it, but the filesystem
 * underneath refuses the call in two cases that Linux allows: a directory (the synchronous `chmod`) and a file
 * its owner has made read-only. When the plain call fails that way the kernel is asked (`fs_chmod`, `fs_chown`),
 * which checks ownership by Linux's rule and makes the change. Anything it refuses is refused for the same reason
 * Linux would, and its message is the one reported.
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
