/**
 * Whether a program may run as the user who started it.
 *
 * A program is `execve`'d by reading its file with a synchronous `open(path, 'r', mode)`. Before the
 * fix in `@zenfs/core` (sync `open` checked the *creation* mode as if it were the access requested),
 * that call failed for any user who does not own the file, so a non-root program could not even start.
 * Rather than assume which `@zenfs/core` is installed, the kernel asks it once at boot: a throwaway
 * context as an unprivileged user tries to read a root-owned file mode 0644. When that fails every
 * program keeps running as root, as before, and one log line says why.
 */

import { bindContext } from '@zenfs/core'

import type { Credentials } from '@zenfs/core'
import type { Filesystem } from '#filesystem.ts'

/** An id nobody owns, so the probe stands for any ordinary user. */
const PROBE_ID = 64000

export async function canRunProgramsAsUser(fs: Filesystem['fs']): Promise<boolean> {
  const path = '/run/.credentials-probe'
  try {
    await fs.writeFile(path, 'probe', { mode: 0o644 })
    const stranger = bindContext({
      root: '/',
      pwd: '/',
      credentials: { uid: PROBE_ID, gid: PROBE_ID, suid: PROBE_ID, sgid: PROBE_ID, euid: PROBE_ID, egid: PROBE_ID, groups: [] }
    })
    return stranger.fs.readFileSync(path, 'utf8') === 'probe'
  } catch {
    return false
  } finally {
    await fs.unlink(path).catch(() => {})
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
