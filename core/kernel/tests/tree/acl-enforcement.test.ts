import { beforeAll, describe, expect, it } from 'vitest'
import { InMemory, bindContext, configure, fs as rootFs, vfs, xattr } from '@zenfs/core'

/**
 * POSIX ACLs are enforced by the filesystem's permission check: a named user or group is granted what its entry and the mask
 * allow, the owner and everyone else are judged as ever, and a new file in a directory with a default ACL starts with it.
 */

const ACCESS = 'system.posix_acl_access'
const DEFAULT = 'system.posix_acl_default'
const USER_OBJ = 1, USER = 2, GROUP_OBJ = 4, GROUP = 8, MASK = 16, OTHER = 32
type Entry = [tag: number, perm: number, id?: number]

const encode = (entries: Entry[]) => {
  const bytes = new Uint8Array(4 + entries.length * 8)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 2, true)
  entries.forEach(([tag, perm, id], index) => {
    view.setUint16(4 + index * 8, tag, true)
    view.setUint16(6 + index * 8, perm, true)
    view.setUint32(8 + index * 8, id ?? 0xffffffff, true)
  })
  return bytes
}
const decode = (bytes: Uint8Array): Entry[] => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const entries: Entry[] = []
  for (let at = 4; at + 8 <= bytes.length; at += 8) entries.push([view.getUint16(at, true), view.getUint16(at + 2, true), view.getUint32(at + 4, true)])
  return entries
}

const as = (uid: number, groups: number[]) => bindContext({ root: '/', pwd: '/', umask: 0o022, credentials: { uid, gid: groups[0], suid: uid, sgid: groups[0], euid: uid, egid: groups[0], groups } })

describe('ACL enforcement', () => {
  const alice = () => as(1000, [1000])
  const bob = () => as(1001, [1001, 2000])
  const carol = () => as(1002, [1002])
  let a: ReturnType<typeof as>, b: ReturnType<typeof as>, c: ReturnType<typeof as>

  beforeAll(async () => {
    await configure({ mounts: { '/': { backend: InMemory } }, resolveFullWalk: true })
    vfs.xattr.allowedRestrictedNames.add(ACCESS)
    vfs.xattr.allowedRestrictedNames.add(DEFAULT)
    rootFs.mkdirSync('/work', { mode: 0o777 })
    a = alice(); b = bob(); c = carol()
  })

  /** A file of alice's with `mode` and the extended ACL `entries`, set as root (the mode's group bits are the mask) */
  const file = (name: string, mode: number, entries?: Entry[]) => {
    const path = `/work/${name}`
    rootFs.writeFileSync(path, 'data')
    rootFs.chownSync(path, 1000, 1000)
    rootFs.chmodSync(path, mode)
    if (entries) xattr.setSync(path, ACCESS, encode(entries))
    return path
  }
  const can = (who: ReturnType<typeof as>, path: string, access: 'r' | 'w') => {
    try {
      who.fs.accessSync(path, access === 'r' ? 4 : 2)
      const fd = who.fs.openSync(path, access === 'r' ? 'r' : 'r+')
      who.fs.closeSync(fd)
      return true
    } catch {
      return false
    }
  }

  it('grants a named user what its entry allows, limited by the mask', () => {
    // mode 0o640: owner rw-, mask r--; user:bob:rw- is cut to r--
    const path = file('named', 0o640, [[USER_OBJ, 6], [USER, 6, 1001], [GROUP_OBJ, 0], [MASK, 4], [OTHER, 0]])
    expect(can(b, path, 'r')).toBe(true)
    expect(can(b, path, 'w')).toBe(false)
    expect(can(c, path, 'r')).toBe(false)

    rootFs.chmodSync(path, 0o660) // a wider mask lets the entry's own write through
    expect(can(b, path, 'w')).toBe(true)
    expect(can(c, path, 'w')).toBe(false)
  })

  it('judges the owner by the mode and root as ever', () => {
    const path = file('owner', 0o600, [[USER_OBJ, 6], [USER, 6, 1001], [GROUP_OBJ, 0], [MASK, 6], [OTHER, 0]])
    expect(can(a, path, 'w')).toBe(true)
    expect(rootFs.accessSync(path, 6)).toBeUndefined()
  })

  it('grants a named group, and refuses a process in the group class that no entry satisfies', () => {
    const path = file('group', 0o640, [[USER_OBJ, 6], [GROUP_OBJ, 0], [GROUP, 4, 2000], [MASK, 4], [OTHER, 0]])
    expect(can(b, path, 'r')).toBe(true) // bob is in group 2000
    expect(can(c, path, 'r')).toBe(false)

    // carol is in the owning group (1000) here: group:: is --- and the others have rw, but the group class does not fall through
    const owned = file('owned-group', 0o664, [[USER_OBJ, 6], [USER, 4, 1002], [GROUP_OBJ, 0], [MASK, 6], [OTHER, 6]])
    rootFs.chownSync(owned, 1000, 1002)
    xattr.setSync(owned, ACCESS, encode([[USER_OBJ, 6], [GROUP_OBJ, 0], [GROUP, 0, 2000], [MASK, 6], [OTHER, 4]]))
    expect(can(c, owned, 'r')).toBe(false)
    expect(can(as(1003, [1003]), owned, 'r')).toBe(true) // someone in no class gets other::
  })

  it('leaves a file with no ACL to its mode', () => {
    const path = file('plain', 0o604)
    expect(can(c, path, 'r')).toBe(true)
    expect(can(c, path, 'w')).toBe(false)
  })

  it('lets a named user search a directory', () => {
    rootFs.mkdirSync('/work/private', { mode: 0o700 })
    rootFs.chownSync('/work/private', 1000, 1000)
    rootFs.writeFileSync('/work/private/inside', 'x')
    rootFs.chmodSync('/work/private/inside', 0o644)
    expect(() => b.fs.readFileSync('/work/private/inside')).toThrow()
    xattr.setSync('/work/private', ACCESS, encode([[USER_OBJ, 7], [USER, 1, 1001], [GROUP_OBJ, 0], [MASK, 1], [OTHER, 0]]))
    rootFs.chmodSync('/work/private', 0o710)
    expect(b.fs.readFileSync('/work/private/inside', 'utf8')).toBe('x')
    expect(() => c.fs.readFileSync('/work/private/inside')).toThrow()
  })

  it('starts a new entry with its directory\'s default ACL', async () => {
    rootFs.mkdirSync('/work/shared', { mode: 0o755 })
    rootFs.chownSync('/work/shared', 1000, 1000)
    xattr.setSync('/work/shared', DEFAULT, encode([[USER_OBJ, 7], [USER, 7, 1001], [GROUP_OBJ, 5], [MASK, 7], [OTHER, 0]]))

    a.fs.writeFileSync('/work/shared/new.txt', 'hello')
    const stat = rootFs.statSync('/work/shared/new.txt')
    expect(stat.mode & 0o777).toBe(0o640) // the requested 0o644 limited by the default; the umask is not applied
    expect(decode(xattr.getSync('/work/shared/new.txt', ACCESS) as Uint8Array)).toEqual([[USER_OBJ, 6, 0xffffffff], [USER, 7, 1001], [GROUP_OBJ, 5, 0xffffffff], [MASK, 4, 0xffffffff], [OTHER, 0, 0xffffffff]])
    expect(can(b, '/work/shared/new.txt', 'r')).toBe(true)
    expect(can(b, '/work/shared/new.txt', 'w')).toBe(false) // rwx for bob, cut to r-- by the mask
    expect(can(c, '/work/shared/new.txt', 'r')).toBe(false)

    await a.fs.promises.writeFile('/work/shared/async.txt', 'hello')
    expect(rootFs.statSync('/work/shared/async.txt').mode & 0o777).toBe(0o640)

    a.fs.mkdirSync('/work/shared/sub')
    expect(rootFs.statSync('/work/shared/sub').mode & 0o777).toBe(0o770)
    expect(xattr.getSync('/work/shared/sub', DEFAULT)).toBeDefined()
    expect(xattr.getSync('/work/shared/sub', ACCESS)).toBeDefined()
    await a.fs.promises.mkdir('/work/shared/sub2')
    expect(xattr.getSync('/work/shared/sub2', DEFAULT)).toBeDefined()
  })

  it('applies the umask where there is no default ACL', () => {
    a.fs.writeFileSync('/work/umask.txt', 'x')
    expect(rootFs.statSync('/work/umask.txt').mode & 0o777).toBe(0o644)
    a.fs.mkdirSync('/work/umask-dir')
    expect(rootFs.statSync('/work/umask-dir').mode & 0o777).toBe(0o755)
    expect(() => xattr.getSync('/work/umask.txt', ACCESS)).toThrow()
  })
})
