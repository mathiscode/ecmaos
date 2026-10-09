/**
 * Per-user storage quotas on the IndexedDB root. `/etc/quota` lists them, one per line (`alice 100M`, `1001 2G`; `#` starts a
 * comment); a user with no line has none, and root cannot have one. What counts is the size of the files a user owns on the root
 * (hard links once; `/tmp` and the other mounts are not the root's). A write or truncate that would grow a file past its owner's
 * quota fails with `EDQUOT`, as a quota on Linux does.
 *
 * Measuring every owner's files on each write would cost a walk, so usage is kept as an estimate that only grows with each write and is
 * measured exactly (a walk of the root) the first time a user is checked and whenever the estimate says a write would go over: space
 * freed by deleting files is found then, and the write is refused only if the exact figure still does not fit.
 */

import { withErrno } from 'kerium'

const MiB = 1024 * 1024

export const parseQuotaSize = (text: string): number | undefined => {
  const match = /^(\d+(?:\.\d+)?)([kKmMgGtT]?)$/.exec(text)
  if (!match) return undefined
  const unit = { '': 1, k: 1024, m: MiB, g: 1024 * MiB, t: 1024 * 1024 * MiB }[match[2]!.toLowerCase() as '' | 'k' | 'm' | 'g' | 't']
  return Math.floor(Number(match[1]) * unit)
}

export interface ParsedQuotas { limits: Map<number, number>, errors: string[] }

/** `resolve` turns a user name into a uid (`undefined` when there is no such user) */
export function parseQuotas(text: string, resolve: (name: string) => number | undefined): ParsedQuotas {
  const limits = new Map<number, number>()
  const errors: string[] = []
  text.split('\n').forEach((raw, index) => {
    const line = raw.replace(/#.*/, '').trim()
    if (!line) return
    const [who, size, ...extra] = line.split(/\s+/)
    const where = `line ${index + 1}`
    const limit = size ? parseQuotaSize(size) : undefined
    const uid = who && /^\d+$/.test(who) ? Number(who) : who ? resolve(who) : undefined
    if (extra.length || limit === undefined) errors.push(`${where}: expected USER SIZE (such as alice 100M)`)
    else if (uid === undefined) errors.push(`${where}: no such user '${who}'`)
    else if (uid === 0) errors.push(`${where}: root has no quota`)
    else limits.set(uid, limit)
  })
  return { limits, errors }
}

let limits = new Map<number, number>()
const estimate = new Map<number, number>()
let measure: ((uid: number) => number) | undefined

/** Installs the quotas and how to measure what a user owns; usage is measured afresh the next time each user is checked */
export function configureQuotas(next: Map<number, number>, measurer?: (uid: number) => number): void {
  limits = next
  estimate.clear()
  if (measurer) measure = measurer
}

export const quotaLimit = (uid: number): number | undefined => limits.get(uid)
export const quotaLimits = (): ReadonlyMap<number, number> => limits

/** What `uid` owns on the root now, measured */
export function quotaUsage(uid: number): number {
  const used = measure?.(uid) ?? 0
  estimate.set(uid, used)
  return used
}

/** Call before a file owned by `inode.uid` grows to `end` bytes; throws `EDQUOT` when that would put its owner over the quota */
export function chargeQuota(inode: { uid: number, size: number }, end: number, path: string): void {
  const limit = limits.get(inode.uid)
  if (limit === undefined || !measure) return
  const growth = end - inode.size
  if (growth <= 0) return
  const known = estimate.get(inode.uid) ?? quotaUsage(inode.uid)
  if (known + growth <= limit) { estimate.set(inode.uid, known + growth); return }
  // the estimate only ever grows between measurements, so look again before refusing
  const exact = quotaUsage(inode.uid)
  if (exact + growth > limit) throw withErrno('EDQUOT', `${path}: over the storage quota (${Math.round(limit / 1024)} KiB, ${Math.round(exact / 1024)} KiB used)`)
  estimate.set(inode.uid, exact + growth)
}
