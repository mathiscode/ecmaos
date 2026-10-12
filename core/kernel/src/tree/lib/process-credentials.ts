/**
 * Whether a program may run as the user who started it. Checked once at boot with a throwaway unprivileged context:
 * it must be able to read a root-owned 0644 file (`execve` opens with `open(path, 'r', mode)`, which once checked the
 * creation mode as access), and must not read through a directory it has no search permission on (`resolveFullWalk`).
 * If either fails, every program runs as root and one log line says why. `chmod` and `chown` on directories and read-
 * only files go through the kernel (`fs_chmod`, `fs_chown`).
 */

import { bindContext, boundContexts } from '@zenfs/core'

import type { Credentials } from '@zenfs/core'
import type { Filesystem } from '#filesystem.ts'

/** An id nobody owns, so the probe stands for any ordinary user. */
const PROBE_ID = 64000

export async function canRunProgramsAsUser(fs: Filesystem['fs']): Promise<boolean> {
  const base = '/run/.credentials-probe'
  let stranger: ReturnType<typeof bindContext> | undefined
  try {
    await fs.mkdir(base, { mode: 0o755 })
    await fs.writeFile(`${base}/file`, 'probe', { mode: 0o644 })
    await fs.mkdir(`${base}/private`, { mode: 0o700 })
    await fs.writeFile(`${base}/private/file`, 'probe', { mode: 0o644 })

    stranger = bindContext({
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
    // the probe's context is not a process: left bound, `ps` lists it as a kernel row owned by an id nobody has
    if (stranger) boundContexts.delete(stranger.id)
    await fs.rm(base, { recursive: true, force: true }).catch(() => {})
  }
}

/** A copy of `credentials`, which is what a process's context is bound with. */
export function credentialsFor(credentials: Credentials): Credentials {
  return { ...credentials, groups: [...credentials.groups] }
}

const S_ISUID = 0o4000

/**
 * What a setuid program runs as: the caller's real ids with the file owner as effective and saved user id.
 * `undefined` when there is no setuid bit, the owner is already the effective user, or the file cannot be examined.
 */
export function setuidCredentials(fs: { statSync(path: string): { mode: number | bigint, uid: number | bigint, isFile(): boolean } | undefined }, path: string, caller: Credentials): Credentials | undefined {
  let stats
  try { stats = fs.statSync(path) } catch { return undefined }
  if (!stats?.isFile() || !(Number(stats.mode) & S_ISUID) || Number(stats.uid) === caller.euid) return undefined
  return { ...credentialsFor(caller), euid: Number(stats.uid), suid: Number(stats.uid) }
}
