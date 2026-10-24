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

/** What `setuid(2)` and the calls like it change: the user ids or the group ids of the caller */
export type IdKind = 'user' | 'group'

const names = { user: ['uid', 'euid', 'suid'], group: ['gid', 'egid', 'sgid'] } as const

/**
 * `setres[ug]id(2)` on `credentials`, with Linux's rules: an id of -1 is left alone, and a caller that is not root
 * (the effective user is the one that counts for both kinds) may only set each to one of its real, effective or saved
 * ids. `setuid(2)`, `seteuid(3)` and `setreuid(2)` are written in terms of it by `setIds`.
 * @returns 0, or -EPERM and nothing is changed
 */
export function setResIds(credentials: Credentials, kind: IdKind, real: number, effective: number, saved: number): number {
  const [r, e, s] = names[kind]
  const held = [credentials[r], credentials[e], credentials[s]]
  const next = [real, effective, saved]
  if (credentials.euid !== 0 && next.some(id => id !== -1 && !held.includes(id))) return -1
  if (real !== -1) credentials[r] = real
  if (effective !== -1) credentials[e] = effective
  if (saved !== -1) credentials[s] = saved
  return 0
}

/**
 * The calls that set ids, by `op`: 0 `setuid`/`setgid`, 1 `setreuid`/`setregid`, 2 `setresuid`/`setresgid`. Ids are
 * numbers, -1 for "unchanged". `setuid` by root sets all three ids; by anyone else only the effective one, to the
 * real or saved id. `setreuid` also makes the saved id the new effective one when the real id is set or the effective
 * one differs from the old real one.
 * @returns 0 or -1 for EPERM
 */
export function setIds(credentials: Credentials, kind: IdKind, op: number, a: number, b: number, c: number): number {
  const [r, e, s] = names[kind]
  if (op === 2) return setResIds(credentials, kind, a, b, c)
  if (op === 0) {
    if (a === -1) return -1
    if (credentials.euid === 0) return setResIds(credentials, kind, a, a, a)
    if (a !== credentials[r] && a !== credentials[s]) return -1
    credentials[e] = a
    return 0
  }
  const oldReal = credentials[r]
  const privileged = credentials.euid === 0
  if (!privileged) {
    if (a !== -1 && a !== credentials[r] && a !== credentials[e]) return -1
    if (b !== -1 && b !== credentials[r] && b !== credentials[e] && b !== credentials[s]) return -1
  }
  const saves = a !== -1 || (b !== -1 && b !== oldReal)
  if (a !== -1) credentials[r] = a
  if (b !== -1) credentials[e] = b
  if (saves) credentials[s] = credentials[e]
  return 0
}
