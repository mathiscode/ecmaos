/**
 * Whether a program may run as the user who started it.
 *
 * Rather than assume which `@zenfs/core` is installed, the kernel asks once at boot, with a throwaway context as an
 * unprivileged user:
 *
 * - it can read a root-owned file mode 0644. A program is `execve`'d by reading its file with a synchronous
 *   `open(path, 'r', mode)`, which once checked the *creation* mode as if it were the access requested, so a
 *   non-root program could not even start;
 * - it cannot read through a directory it has no search permission on, so one user's 0700 home is private
 *   (a release before `resolveFullWalk`, or the kernel not turning that on, fails this).
 *
 * When either fails every program keeps running as root, as before, and one log line says why. Changing the mode
 * or owner of a directory or a read-only file is not asked of it: `chmod` and `chown` do that through the kernel
 * (`fs_chmod`, `fs_chown`) until the filesystem can.
 */

import { bindContext } from '@zenfs/core'

import type { Credentials } from '@zenfs/core'
import type { Filesystem } from '#filesystem.ts'

/** An id nobody owns, so the probe stands for any ordinary user. */
const PROBE_ID = 64000

export async function canRunProgramsAsUser(fs: Filesystem['fs']): Promise<boolean> {
  const base = '/run/.credentials-probe'
  try {
    await fs.mkdir(base, { mode: 0o755 })
    await fs.writeFile(`${base}/file`, 'probe', { mode: 0o644 })
    await fs.mkdir(`${base}/private`, { mode: 0o700 })
    await fs.writeFile(`${base}/private/file`, 'probe', { mode: 0o644 })

    const stranger = bindContext({
      root: '/',
      pwd: '/',
      credentials: { uid: PROBE_ID, gid: PROBE_ID, suid: PROBE_ID, sgid: PROBE_ID, euid: PROBE_ID, egid: PROBE_ID, groups: [] }
    })
    if (stranger.fs.readFileSync(`${base}/file`, 'utf8') !== 'probe') return false

    try {
      stranger.fs.readFileSync(`${base}/private/file`, 'utf8')
      return false
    } catch {
      return true
    }
  } catch {
    return false
  } finally {
    await fs.rm(base, { recursive: true, force: true }).catch(() => {})
  }
}

/** A copy of `credentials`, which is what a process's context is bound with. */
export function credentialsFor(credentials: Credentials): Credentials {
  return { ...credentials, groups: [...credentials.groups] }
}

const S_ISUID = 0o4000

/**
 * What a program with the setuid bit runs as: the caller's real ids, with the effective and saved user id
 * of the file's owner, so `su` is still told who ran it while it acts as root. `undefined` when the file
 * has no bit, is already owned by the caller's effective user, or cannot be examined. With every program
 * running as root (see `canRunProgramsAsUser`) the owner is always the effective user, so this never
 * changes anything there.
 */
export function setuidCredentials(fs: { statSync(path: string): { mode: number | bigint, uid: number | bigint, isFile(): boolean } | undefined }, path: string, caller: Credentials): Credentials | undefined {
  let stats
  try { stats = fs.statSync(path) } catch { return undefined }
  if (!stats?.isFile() || !(Number(stats.mode) & S_ISUID) || Number(stats.uid) === caller.euid) return undefined
  return { ...credentialsFor(caller), euid: Number(stats.uid), suid: Number(stats.uid) }
}
