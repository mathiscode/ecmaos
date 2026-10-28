/**
 * The immutable (`i`) and append-only (`a`) attributes, which `chattr` sets and the filesystem keeps for everyone,
 * root included, as Linux's does. They are zenfs's own inode flags, set and read with the real `FS_IOC_SETFLAGS` and
 * `FS_IOC_GETFLAGS`; zenfs refuses writes to an immutable file, and this does the rest:
 *
 * - An immutable file cannot be removed, renamed, linked to, truncated, or have its mode, owner, times or extended
 *   attributes changed, and an immutable directory gains and loses no entries.
 * - An append-only file is written only at its end (opened with `O_APPEND`), and is not truncated, removed, renamed,
 *   linked to or chmod/chowned; an append-only directory gains entries but loses none.
 * - Only root sets or clears `i` and `a` (`CAP_LINUX_IMMUTABLE`); the owner may set the other flags.
 *
 * The checks are in the store-backed filesystems (the IndexedDB root, `/tmp`, the Node host's SQLite root) and in the
 * open file, so they hold for the kernel's own writes as well as for programs'. The flags with no zenfs inode bit
 * (`c`, `d`, `s`, `u` and the others `lsattr` shows) are accepted and kept in an extended attribute for display.
 */

import { StoreFS, vfs } from '@zenfs/core'
import { syscalls, type Process } from '@zenfs/linux'
import { withErrno } from 'kerium'

// zenfs's inode flags
const INODE_APPEND = 4
const INODE_IMMUTABLE = 8
const LOCKED = INODE_APPEND | INODE_IMMUTABLE

// `FS_IOC_GETFLAGS`/`FS_IOC_SETFLAGS` and their 32-bit forms, and the `FS_*_FL` bits (`<linux/fs.h>`)
const GETFLAGS = [0x80086601, 0x80046601]
const SETFLAGS = [0x40086602, 0x40046602]
const FS_IMMUTABLE_FL = 0x10
const FS_APPEND_FL = 0x20
/** What zenfs keeps in the inode: sync, immutable, append-only, no-atime and dirsync */
const NATIVE = 0x8 | FS_IMMUTABLE_FL | FS_APPEND_FL | 0x80 | 0x10000
/** What a user may set (`FS_FL_USER_MODIFIABLE`) */
const MODIFIABLE = 0x000380ff
/** The extended attribute that keeps the flags with no inode bit */
export const EXTRA_FLAGS = 'system.ecmaos.chattr'

const O_ACCMODE = 3
const O_RDONLY = 0
const O_TRUNC = 0o1000
const O_APPEND = 0o2000

interface InodeLike { flags?: number, mode?: number, uid?: number, gid?: number, size?: number, attributes?: { entries(): Iterable<(string | Uint8Array)[]> } }
type Store = {
  stat(path: string): Promise<InodeLike>
  statSync(path: string): InodeLike
}

const parentOf = (path: string) => path.replace(/\/[^/]*\/?$/, '') || '/'
const flagsOf = (inode: InodeLike | undefined) => inode?.flags ?? 0
const deny = () => { throw withErrno('EPERM') }

/** Set while `FS_IOC_SETFLAGS` writes the flags (and the attribute beside them), which the checks let through */
let settingFlags = false

const attributesOf = (inode: InodeLike) => JSON.stringify([...(inode.attributes?.entries() ?? [])].map(([name, value]) => [name, Array.from(value as Uint8Array)]))

/**
 * What a change to the inode at `path` may do when the inode is locked: `'deny'`, `'skip'` (only its times would
 * change, as a read does to an immutable file, which Linux leaves alone), or `'allow'`
 */
function judgeTouch(existing: InodeLike, metadata: InodeLike): 'allow' | 'skip' | 'deny' {
  const flags = flagsOf(existing)
  if (!(flags & LOCKED) || settingFlags) return 'allow'
  if (metadata.flags !== undefined && metadata.flags !== flags) return 'allow'
  const changed = (key: 'mode' | 'uid' | 'gid') => metadata[key] !== undefined && metadata[key] !== existing[key]
  if (changed('mode') || changed('uid') || changed('gid')) return 'deny'
  if (metadata.attributes !== undefined && attributesOf(metadata) !== attributesOf(existing)) return 'deny'
  if (metadata.size !== undefined && metadata.size !== existing.size) {
    if (flags & INODE_IMMUTABLE) return 'deny'
    if (metadata.size < (existing.size ?? 0)) return 'deny'
  }
  return flags & INODE_IMMUTABLE ? 'skip' : 'allow'
}

/** Whether `path` may be removed (or renamed away) from its directory */
function checkRemove(target: InodeLike | undefined, parent: InodeLike | undefined): void {
  if (flagsOf(target) & LOCKED) deny()
  if (flagsOf(parent) & LOCKED) deny()
}

/** Whether a name may be added in a directory */
function checkAdd(parent: InodeLike | undefined): void {
  if (flagsOf(parent) & INODE_IMMUTABLE) deny()
}

const quiet = <T>(get: () => T): T | undefined => { try { return get() } catch { return undefined } }
const quietAsync = async <T>(get: () => Promise<T>): Promise<T | undefined> => { try { return await get() } catch { return undefined } }

type Method = (...args: never[]) => unknown

function installStoreChecks(): void {
  const proto = StoreFS.prototype as unknown as Record<string, Method> & Store
  const wrap = (name: string, check: (this: Store, ...args: never[]) => void | 'skip') => {
    const original = proto[name] as Method
    proto[name] = function (this: Store, ...args: never[]) {
      if (check.apply(this, args) === 'skip') return undefined
      return original.apply(this, args)
    }
  }
  const wrapAsync = (name: string, check: (this: Store, ...args: never[]) => Promise<void | 'skip'>) => {
    const original = proto[name] as Method
    proto[name] = async function (this: Store, ...args: never[]) {
      if (await check.apply(this, args) === 'skip') return undefined
      return original.apply(this, args)
    }
  }

  wrap('removeSync', function (path: string) { checkRemove(quiet(() => this.statSync(path)), quiet(() => this.statSync(parentOf(path)))) })
  wrapAsync('remove', async function (path: string) { checkRemove(await quietAsync(() => this.stat(path)), await quietAsync(() => this.stat(parentOf(path)))) })

  wrap('renameSync', function (from: string, to: string) {
    checkRemove(quiet(() => this.statSync(from)), quiet(() => this.statSync(parentOf(from))))
    checkAdd(quiet(() => this.statSync(parentOf(to))))
    if (flagsOf(quiet(() => this.statSync(to))) & LOCKED) deny()
  })
  wrapAsync('rename', async function (from: string, to: string) {
    checkRemove(await quietAsync(() => this.stat(from)), await quietAsync(() => this.stat(parentOf(from))))
    checkAdd(await quietAsync(() => this.stat(parentOf(to))))
    if (flagsOf(await quietAsync(() => this.stat(to))) & LOCKED) deny()
  })

  wrap('linkSync', function (target: string, link: string) {
    if (flagsOf(quiet(() => this.statSync(target))) & LOCKED) deny()
    checkAdd(quiet(() => this.statSync(parentOf(link))))
  })
  wrapAsync('link', async function (target: string, link: string) {
    if (flagsOf(await quietAsync(() => this.stat(target))) & LOCKED) deny()
    checkAdd(await quietAsync(() => this.stat(parentOf(link))))
  })

  // every new file, directory and symbolic link is made by commitNew
  wrap('commitNewSync', function (path: string) { checkAdd(quiet(() => this.statSync(parentOf(path)))) })
  wrapAsync('commitNew', async function (path: string) { checkAdd(await quietAsync(() => this.stat(parentOf(path)))) })

  const touchCheck = (existing: InodeLike | undefined, metadata: InodeLike) => {
    if (!existing) return
    const verdict = judgeTouch(existing, metadata)
    if (verdict === 'deny') deny()
    if (verdict === 'skip') return 'skip' as const
  }
  wrap('touchSync', function (path: string, metadata: InodeLike) { return touchCheck(quiet(() => this.statSync(path)), metadata) })
  wrapAsync('touch', async function (path: string, metadata: InodeLike) { return touchCheck(await quietAsync(() => this.stat(path)), metadata) })

  wrap('writeSync', function (path: string) { if (flagsOf(quiet(() => this.statSync(path))) & INODE_IMMUTABLE) deny() })
  wrapAsync('write', async function (path: string) { if (flagsOf(await quietAsync(() => this.stat(path))) & INODE_IMMUTABLE) deny() })
}

/**
 * On the open file: an append-only file is written only where `O_APPEND` puts it, and not truncated; neither kind has
 * its mode, owner or times set. These are refused before the open file changes its copy of the inode, which a refusal
 * further down would leave changed.
 */
function installHandleChecks(): void {
  const proto = vfs.Handle.prototype as unknown as Record<string, Method> & { inode: InodeLike, flag: number }
  const refuse = (name: string, handle: typeof proto) => {
    const flags = flagsOf(handle.inode)
    if (/^(chmod|chown|utimes)/.test(name)) return !!(flags & LOCKED)
    return !!(flags & INODE_APPEND) && (name.startsWith('truncate') || !(handle.flag & O_APPEND))
  }
  for (const name of ['writeSync', 'write', 'truncateSync', 'truncate', 'chmodSync', 'chmod', 'chownSync', 'chown', 'utimesSync', 'utimes']) {
    const original = proto[name] as Method
    proto[name] = function (this: typeof proto, ...args: never[]) {
      if (refuse(name, this)) {
        if (name.endsWith('Sync')) deny()
        return Promise.reject(withErrno('EPERM'))
      }
      return original.apply(this, args)
    }
  }
}

/** The attribute flags of `path`, or 0 for a file that has none (a device, a file on a filesystem without them) */
export function fileFlags(proc: Process, path: string): number {
  return quiet(() => (vfs.ioctlSync as unknown as (this: unknown, path: string, command: number) => number).call(proc.context, path, GETFLAGS[0] as number)) ?? 0
}

/**
 * Whether `path`, seen from `context` (a shell's), is immutable or append-only; neither for a file that does not exist
 * or has no flags
 */
export async function lockOf(context: unknown, path: string): Promise<{ immutable: boolean, appendOnly: boolean }> {
  const ioctl = vfs.ioctl as unknown as (this: unknown, path: string, command: number) => Promise<number>
  const flags = await ioctl.call(context, path, GETFLAGS[0] as number).catch(() => 0)
  return { immutable: !!(flags & FS_IMMUTABLE_FL), appendOnly: !!(flags & FS_APPEND_FL) }
}

type Handler = (proc: Process, ...args: never[]) => unknown

function installSyscalls(): void {
  vfs.xattr.allowedRestrictedNames.add(EXTRA_FLAGS)

  // `open`: an immutable file is not opened for writing, an append-only one only for appending, neither truncated
  const open = syscalls.get('open') as unknown as Handler | undefined
  if (open) {
    syscalls.set('open', ((proc: Process, path: string, flags: number, ...rest: never[]) => {
      if (typeof path === 'string' && typeof flags === 'number' && ((flags & O_ACCMODE) !== O_RDONLY || flags & O_TRUNC)) {
        const locked = fileFlags(proc, path)
        if (locked & FS_IMMUTABLE_FL) deny()
        if (locked & FS_APPEND_FL && (flags & O_TRUNC || !(flags & O_APPEND))) deny()
      }
      return open(proc, path as never, flags as never, ...rest)
    }) as never)
  }

  const ioctl = syscalls.get('ioctl') as unknown as Handler | undefined
  if (!ioctl) return
  syscalls.set('ioctl', ((proc: Process, fd: number, request: number, arg: unknown) => {
    if (!GETFLAGS.includes(request) && !SETFLAGS.includes(request)) return ioctl(proc, fd as never, request as never, arg as never)
    const handle = vfs.fromFD(proc.context, fd) as unknown as { path: string, inode: InodeLike }
    const extraOf = () => {
      const value = quiet(() => vfs.xattr.getSync.call(proc.context, handle.path, EXTRA_FLAGS, { encoding: 'utf8' }))
      return value ? Number(value) || 0 : 0
    }
    const native = ioctl(proc, fd as never, GETFLAGS[0] as never, undefined as never) as number
    if (GETFLAGS.includes(request)) return native | extraOf()

    const wanted = Number(arg) >>> 0
    const { euid } = proc.context.credentials
    if (euid !== 0 && euid !== handle.inode.uid) deny()
    if (((native ^ wanted) & (FS_IMMUTABLE_FL | FS_APPEND_FL)) && euid !== 0) deny()
    if (wanted & ~(MODIFIABLE | NATIVE)) throw withErrno('ENOTSUP')
    const extra = wanted & MODIFIABLE & ~NATIVE
    settingFlags = true
    try {
      ioctl(proc, fd as never, request as never, (wanted & NATIVE) as never)
      if (extra) vfs.xattr.setSync.call(proc.context, handle.path, EXTRA_FLAGS, new TextEncoder().encode(String(extra)))
      else if (extraOf()) vfs.xattr.removeSync.call(proc.context, handle.path, EXTRA_FLAGS)
    } finally {
      settingFlags = false
    }
    return 0
  }) as never)
}

let installed = false
export function installInodeFlags(): void {
  if (installed) return
  installed = true
  installStoreChecks()
  installHandleChecks()
  installSyscalls()
}
