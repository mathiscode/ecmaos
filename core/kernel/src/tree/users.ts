/**
 * @experimental
 * @author Jay Mathis <code@mathis.network> (https://github.com/mathiscode)
 *
 * The Users class handles the management of users on the system.
 * It provides functionality to add, get, load, login, password, remove, and update users.
 */

import type {
  AddUserOptions,
  Aging,
  Passkey,
  User,
  UsersOptions
} from '@ecmaos/types'
import { createCredentials, Credentials } from '@zenfs/core'
import { hashPassword, needsRehash, verifyPassword } from './lib/credentials.ts'
import { AUTHORIZED_KEYS_FILE, generateKeyPair, parseAuthorizedKeys, parseWrappedKey, publicKeyLine, parsePublicKeyLine, PRIVATE_KEY_FILE, PUBLIC_KEY_FILE, unwrapKey, wrapKey } from './lib/keys.ts'
import {
  DEFAULT_AGING, daysSinceEpoch, findEntry, hasNoPassword, isLocked, lockHash, loginBlock, parseShadow, removeEntry,
  renameEntry, serializeShadow, setEntry, unlockHash
} from './lib/shadow.ts'
import type { ShadowEntry, ShadowFile } from './lib/shadow.ts'

/** The group that may read `/etc/shadow`, as on Debian */
export const SHADOW_GROUP = 'shadow'
export const SHADOW_GID = 42

/** Shortest plaintext password accepted; the documented default login (root/root) is 4. */
export const MIN_PASSWORD_LENGTH = 4

/**
 * Throws if a plaintext password can't be stored. `:` and line breaks are refused because
 * `/etc/shadow` and `/etc/passwd` are colon-separated, one entry per line.
 */
export function validatePassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length === 0) throw new Error('Password is required')
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  if (/[:\r\n]/.test(password)) throw new Error('Password may not contain ":" or line breaks')
}

/**
 * Serializes a `User` to a real 7-field `/etc/passwd` line: `name:x:uid:gid:gecos:home:shell`.
 * The password field is always `x` -- real hashes live in `/etc/shadow`, exactly like a real
 * Linux system, and always did here too; only the *shape* of this line was non-standard before.
 */
function passwdLine(user: User): string {
  return `${user.username}:x:${user.uid}:${user.gid}:${user.username}:${user.home}:${user.shell}`
}

/** Serializes every currently-loaded user to `/etc/passwd`'s full contents. */
function passwdFile(users: Iterable<User>): string {
  return Array.from(users).map(passwdLine).join('\n') + '\n'
}

/** The aging fields of a shadow line */
function agingOf(entry: ShadowEntry): Aging {
  const { lastChange, min, max, warn, inactive, expire } = entry
  return Object.fromEntries(Object.entries({ lastChange, min, max, warn, inactive, expire }).filter(([, value]) => value !== undefined)) as Aging
}

/** A group: a name for a gid. Its members are the users whose `groups` list the gid. */
export interface Group { name: string, gid: number }

/**
 * Serializes `/etc/group`: `name:x:gid:members`, `members` a comma-separated list of user names. Every group in
 * the registry gets a line, and so does each user's primary group even when nothing named it, so an account
 * is never left in a group `/etc/group` does not list (it is called after the user then, as `useradd` does).
 */
function groupFile(users: Iterable<User>, registry: Map<number, Group>): string {
  const all = new Map<number, Group>(registry)
  const taken = new Set([...all.values()].map(group => group.name))
  const people = Array.from(users)
  for (const user of people) {
    if (all.has(user.gid)) continue
    const name = taken.has(user.username) ? `group${user.gid}` : user.username
    taken.add(name)
    all.set(user.gid, { name, gid: user.gid })
  }
  return Array.from(all.values())
    .sort((a, b) => a.gid - b.gid)
    .map(({ name, gid }) => `${name}:x:${gid}:${people.filter(user => user.groups.includes(gid)).map(user => user.username).join(',')}`)
    .join('\n') + '\n'
}

export class Users {
  private _options: UsersOptions
  private _users: Map<number, User> = new Map()
  /** Group names by gid, as `/etc/group` lists them. */
  private _groups: Map<number, Group> = new Map()
  /** Changes to `/etc/shadow` run one at a time: each reads the file, edits it and writes it back whole */
  private _shadowQueue: Promise<unknown> = Promise.resolve()

  get all() { return this._users }

  private get fs() { return this._options.filesystem.fs }

  constructor(options: UsersOptions) {
    this._options = options
  }

  /** Rewrites both `/etc/passwd` and `/etc/group` from the current in-memory user map. */
  private async writePasswdAndGroup(): Promise<void> {
    const users = Array.from(this._users.values())
    await this.fs.writeFile('/etc/passwd', passwdFile(users), { encoding: 'utf-8', mode: 0o644 })
    this.registerPrimaryGroups()
    await this.fs.writeFile('/etc/group', groupFile(users, this._groups), { encoding: 'utf-8', mode: 0o644 })
  }

  /**
   * Add a user to the system
   */
  async add(user: Partial<User>, options: AddUserOptions = {}) {
    if (!user.uid) user.uid = this._users.size
    if (!user.gid) user.gid = user.uid
    if (!user.groups) user.groups = []
    if (!user.shell) user.shell = 'ecmaos'
    if (!user.home) user.home = `/home/${user.username}`

    if (!user.username || user.password === undefined) throw new Error('Username and password are required')
    if (this._users.has(user.uid) || Array.from(this._users.values()).some(u => u.username === user.username))
      throw new Error(`User with UID ${user.uid} or username ${user.username} already exists`)

    const invalidChars = /[#/\\&=:\t\r\n\f]/
    if (invalidChars.test(user.username)) throw new Error('Username contains invalid characters')
    user.username = user.username.replace(/[^\x20-\x7E]+/g, '') // remove non-printable characters

    const unhashedPassword = user.password
    if (!options.noHash) {
      validatePassword(unhashedPassword)
      user.password = await hashPassword(unhashedPassword)
    }

    if (!options.noHome) {
      await this.fs.mkdir(user.home, { recursive: true, mode: 0o750 })
    }

    if (!user.aging) user.aging = { lastChange: daysSinceEpoch(), ...DEFAULT_AGING }
    if (!options.noWrite) await this.editShadow(file => setEntry(file, this.shadowEntry(user as User, findEntry(file, user.username!))))

    this._users.set(user.uid, user as User)
    if (!options.noWrite) await this.writePasswdAndGroup()
    else this.registerPrimaryGroups()

    // Fix user home permissions
    try { await this.fs.chown(user.home, user.uid, user.gid) }
    catch {}
  }

  /**
   * Get a user by UID
   */
  get(uid: number) {
    return this._users.get(uid)
  }

  /** A user by name. */
  byName(username: string): User | undefined {
    return Array.from(this._users.values()).find(user => user.username === username)
  }

  // -- groups -------------------------------------------------------------------------------------

  /** Every group, by gid: the registry, plus the primary group of any user it does not yet name. */
  get groupList(): Array<Group & { members: string[] }> {
    this.registerPrimaryGroups()
    const people = Array.from(this._users.values())
    return Array.from(this._groups.values())
      .sort((a, b) => a.gid - b.gid)
      .map(group => ({ ...group, members: people.filter(user => user.groups.includes(group.gid)).map(user => user.username) }))
  }

  /** A group by name, or by gid when `spec` is a number. */
  findGroup(spec: string | number): Group | undefined {
    this.registerPrimaryGroups()
    if (typeof spec === 'number' || /^\d+$/.test(spec)) return this._groups.get(Number(spec))
    return Array.from(this._groups.values()).find(group => group.name === spec)
  }

  /** Names the primary group of every user that has no name yet, after the user, as `useradd` does. */
  private registerPrimaryGroups(): void {
    const taken = new Set(Array.from(this._groups.values()).map(group => group.name))
    for (const user of this._users.values()) {
      if (this._groups.has(user.gid)) continue
      const name = taken.has(user.username) ? `group${user.gid}` : user.username
      taken.add(name)
      this._groups.set(user.gid, { name, gid: user.gid })
    }
  }

  private static validName(name: string): boolean {
    return /^[a-z_][a-z0-9_-]*[$]?$/i.test(name) && name.length <= 32
  }

  /** The lowest unused id from `from`, among the users' and the groups'. */
  freeId(kind: 'uid' | 'gid', from: number, to = Infinity): number {
    const used = new Set<number>(kind === 'uid' ? this._users.keys() : [...this._groups.keys(), ...Array.from(this._users.values()).map(user => user.gid)])
    let id = from
    while (used.has(id)) id++
    if (id > to) throw new Error(`no free ${kind} between ${from} and ${to}`)
    return id
  }

  /** Creates a group. `gid` defaults to the first free one from 1000 (from 100 to 999 for a system group). */
  async addGroup(name: string, gid?: number, system = false): Promise<Group> {
    if (!Users.validName(name)) throw new Error(`'${name}' is not a valid group name`)
    this.registerPrimaryGroups()
    if (this.findGroup(name)) throw new Error(`group '${name}' already exists`)
    if (gid !== undefined && (!Number.isInteger(gid) || gid < 0)) throw new Error(`invalid group ID '${gid}'`)
    if (gid !== undefined && this._groups.has(gid)) throw new Error(`GID '${gid}' already exists`)
    const group = { name, gid: gid ?? (system ? this.freeId('gid', 100, 999) : this.freeId('gid', 1000)) }
    this._groups.set(group.gid, group)
    await this.writePasswdAndGroup()
    return group
  }

  /** Creates the group when it is missing; a preferred gid is used if it is free, else the first free system gid. */
  async ensureGroup(name: string, preferredGid?: number): Promise<Group> {
    const existing = this.findGroup(name)
    if (existing) return existing
    const free = preferredGid !== undefined && !this._groups.has(preferredGid)
    return this.addGroup(name, free ? preferredGid : undefined, true)
  }

  /** Removes a group. A user's primary group cannot go while the user exists. */
  async removeGroup(gid: number): Promise<void> {
    const group = this.findGroup(gid)
    if (!group) throw new Error(`group does not exist`)
    const owner = Array.from(this._users.values()).find(user => user.gid === gid)
    if (owner) throw new Error(`cannot remove the primary group of user '${owner.username}'`)
    this._groups.delete(gid)
    for (const user of this._users.values()) if (user.groups.includes(gid)) user.groups = user.groups.filter(id => id !== gid)
    await this.writePasswdAndGroup()
  }

  /** Renames a group and/or gives it another gid; users in it follow, but files keep the gid they have. */
  async modifyGroup(gid: number, changes: { name?: string, gid?: number }): Promise<Group> {
    const group = this.findGroup(gid)
    if (!group) throw new Error('group does not exist')
    if (changes.name !== undefined) {
      if (!Users.validName(changes.name)) throw new Error(`'${changes.name}' is not a valid group name`)
      if (changes.name !== group.name && this.findGroup(changes.name)) throw new Error(`group '${changes.name}' already exists`)
    }
    if (changes.gid !== undefined) {
      if (!Number.isInteger(changes.gid) || changes.gid < 0) throw new Error(`invalid group ID '${changes.gid}'`)
      if (changes.gid !== gid && this._groups.has(changes.gid)) throw new Error(`GID '${changes.gid}' already exists`)
    }
    const next = { name: changes.name ?? group.name, gid: changes.gid ?? group.gid }
    this._groups.delete(gid)
    this._groups.set(next.gid, next)
    if (next.gid !== gid) {
      for (const user of this._users.values()) {
        if (user.gid === gid) user.gid = next.gid
        if (user.groups.includes(gid)) user.groups = user.groups.map(id => id === gid ? next.gid : id)
      }
    }
    await this.writePasswdAndGroup()
    return next
  }

  /** Adds or removes a user from a group's members. */
  async setMembership(uid: number, gid: number, member: boolean): Promise<void> {
    const user = this._users.get(uid)
    if (!user) throw new Error(`User with UID ${uid} not found`)
    if (!this.findGroup(gid)) throw new Error('group does not exist')
    const groups = member ? Array.from(new Set([...user.groups, gid])) : user.groups.filter(id => id !== gid)
    await this.update(uid, { groups })
  }

  /** Gives the user a new name everywhere it is written: the account, `/etc/shadow`, and the private group when it had one. */
  async rename(uid: number, name: string): Promise<void> {
    const user = this._users.get(uid)
    if (!user) throw new Error(`User with UID ${uid} not found`)
    if (!Users.validName(name)) throw new Error(`'${name}' is not a valid user name`)
    if (this.byName(name) && name !== user.username) throw new Error(`user '${name}' already exists`)
    const old = user.username
    this.registerPrimaryGroups()
    const group = this._groups.get(user.gid)
    if (group && group.name === old && !this.findGroup(name)) this._groups.set(group.gid, { ...group, name })
    user.username = name
    await this.editShadow(file => { if (!renameEntry(file, old, name)) setEntry(file, this.shadowEntry(user)) })
    await this.writePasswdAndGroup()
  }

  /** Gives an account another uid, and hands over the files in its home directory (`/etc/shadow` is keyed by name, so it does not change). */
  async changeUid(uid: number, newUid: number): Promise<void> {
    const user = this._users.get(uid)
    if (!user) throw new Error(`User with UID ${uid} not found`)
    if (!Number.isInteger(newUid) || newUid < 0) throw new Error(`invalid user ID '${newUid}'`)
    if (newUid === uid) return
    if (this._users.has(newUid)) throw new Error(`UID '${newUid}' already exists`)
    this._users.delete(uid)
    user.uid = newUid
    this._users.set(newUid, user)
    await this.writePasswdAndGroup()
    const hand = async (path: string): Promise<void> => {
      const info = await this.fs.lstat(path).catch(() => undefined)
      if (!info || info.uid !== uid) return
      await this.fs.chown(path, newUid, info.gid).catch(() => {})
      if (info.isDirectory()) for (const name of await this.fs.readdir(path).catch(() => [])) await hand(`${path}/${name}`)
    }
    await hand(user.home)
  }

  /**
   * An administrator sets a password without knowing the old one. The hash and `/etc/shadow` are rewritten, and a lock
   * is lifted. The private key in `~/.ssh` stays encrypted under the old password, so it can no longer be unlocked, as
   * with an encrypted home directory on Linux; nothing at login needs it.
   */
  async resetPassword(uid: number, newPassword: string): Promise<void> {
    const user = this._users.get(uid)
    if (!user) throw new Error(`User with UID ${uid} not found`)
    validatePassword(newPassword)
    user.password = await hashPassword(newPassword)
    user.aging = { ...user.aging, lastChange: daysSinceEpoch() }
    await this.writeShadowEntry(user)
  }

  /**
   * Load users from the filesystem
   */
  async load() {
    const { context } = this._options
    const passwd = await this.fs.readFile('/etc/passwd', 'utf-8')
    const shadow = parseShadow(await this.fs.readFile('/etc/shadow', 'utf-8'))
    const group = await this.fs.exists('/etc/group') ? await this.fs.readFile('/etc/group', 'utf-8') : ''

    // Supplementary groups now live in /etc/group, keyed by username -> the numeric gids of every
    // group line that lists them as a member (a user's own primary gid, from passwd, is separate).
    const supplementaryGroups = new Map<string, number[]>()
    this._groups.clear()
    for (const groupLine of group.split('\n')) {
      if (!groupLine.trim() || groupLine.startsWith('#')) continue
      const [groupName, , gidStr, membersStr] = groupLine.split(':')
      const gid = Number(gidStr)
      if (!gidStr || Number.isNaN(gid)) continue
      if (groupName) this._groups.set(gid, { name: groupName, gid })
      for (const member of (membersStr ?? '').split(',').filter(Boolean)) {
        supplementaryGroups.set(member, [...(supplementaryGroups.get(member) ?? []), gid])
      }
    }

    for (const line of passwd.split('\n')) {
      if (line.trim() === '' || line.trim() === '\n' || line.startsWith('#')) continue
      // Standard 7-field format: name:x:uid:gid:gecos:home:shell. Filesystems on an older
      // format are upgraded by the boot migration before `load()` ever runs.
      const [username, , uid, gid, , home, shell] = line.split(':')
      if (!username || !uid || !gid || !home || !shell) continue
      const entry = findEntry(shadow, username)
      // Like Linux, an account with no shadow line exists but cannot log in
      if (!entry) context.log.warn(`User ${username} not found in /etc/shadow; the account is locked`)

      await this.add({
        username,
        password: entry?.hash ?? '!',
        uid: parseInt(uid),
        gid: parseInt(gid),
        groups: supplementaryGroups.get(username) ?? [],
        home,
        shell,
        aging: entry ? agingOf(entry) : { lastChange: daysSinceEpoch(), ...DEFAULT_AGING }
      }, { noWrite: true, noHome: true, noHash: true })
    }
  }

  /**
   * Login a user
   */
  async login(username: string, password?: string, passkeyCredential?: PublicKeyCredential): Promise<{ user: User, cred: Credentials }> {
    const user = Array.from(this._users.values()).find(u => u.username === username)
    if (!user) throw new Error('Invalid username or password')
    let usedPassword = false

    if (passkeyCredential) {
      const passkeys = await this.getPasskeys(user.uid)
      const credential = passkeyCredential as PublicKeyCredential
      
      const credentialId = btoa(String.fromCharCode(...new Uint8Array(credential.rawId)))
      const matchingPasskey = passkeys.find(pk => pk.credentialId === credentialId)
      
      if (!matchingPasskey) {
        throw new Error('Passkey not found for this user')
      }

      matchingPasskey.lastUsed = Date.now()
      await this.savePasskeys(user.uid, passkeys)
    } else if (password) {
      if (!(await verifyPassword(password, user.password))) {
        throw new Error('Invalid username or password')
      }
      usedPassword = true

      // A successful login is the one safe moment to upgrade an older (unsalted SHA-256, or the first
      // PBKDF2 format) hash in place: the plaintext password is in hand, and the user has just proven
      // they own the account.
      if (needsRehash(user.password)) await this.upgradeHash(user, password)
    } else {
      throw new Error('Password or passkey required')
    }

    // What `chage` sets. Said only once the caller has proved who they are, so a name cannot be probed for it. A lock
    // (`passwd -l`) stops password logins above, as on Linux; only an expired account is closed to a passkey too.
    const block = loginBlock(usedPassword ? { ...user.aging } : { expire: user.aging?.expire }, daysSinceEpoch())
    if (block) throw new Error(`Your ${block.replace(' ', ' has ')}; please contact your system administrator`)

    const cred = createCredentials({
      uid: user.uid,
      gid: user.gid,
      euid: user.uid,
      egid: user.gid,
      groups: user.groups
    })

    return { user, cred }
  }

  /**
   * A session for `username` without a password, for a login that has already been proved some other way (a key).
   * An expired account is closed to it as to any login; a locked password is not (that stops passwords, as on Linux).
   * Fails with the same message as a wrong password so a name cannot be probed.
   */
  async sessionFor(username: string): Promise<{ user: User, cred: Credentials }> {
    const user = Array.from(this._users.values()).find(u => u.username === username)
    if (!user) throw new Error('Invalid username or password')
    const block = loginBlock({ expire: user.aging?.expire }, daysSinceEpoch())
    if (block) throw new Error(`Your ${block.replace(' ', ' has ')}; please contact your system administrator`)
    return { user, cred: createCredentials({ uid: user.uid, gid: user.gid, euid: user.uid, egid: user.gid, groups: user.groups }) }
  }

  /** The keys the user may log in with (`~/.ssh/authorized_keys`); none when the file is missing */
  async getAuthorizedKeys(username: string): Promise<JsonWebKey[] | undefined> {
    const user = Array.from(this._users.values()).find(u => u.username === username)
    if (!user) return undefined
    const path = `${user.home}/${AUTHORIZED_KEYS_FILE}`
    if (!(await this.fs.exists(path))) return []
    return parseAuthorizedKeys(await this.fs.readFile(path, 'utf-8'))
  }

  /** Adds a key to the user's `authorized_keys` (a directory of mode 0700, a file of 0600, both theirs). A key already there is not added twice. */
  async authorizeKey(username: string, key: JsonWebKey, comment: string): Promise<void> {
    const user = Array.from(this._users.values()).find(u => u.username === username)
    if (!user) throw new Error(`User ${username} not found`)
    const { directory } = this.keyPaths(user)
    const path = `${user.home}/${AUTHORIZED_KEYS_FILE}`
    const existing = await this.fs.exists(path) ? await this.fs.readFile(path, 'utf-8') : ''
    if (parseAuthorizedKeys(existing).some(known => known.x === key.x && known.y === key.y)) return
    await this.fs.mkdir(directory, { recursive: true, mode: 0o700 })
    await this.fs.chown(directory, user.uid, user.gid).catch(() => {})
    const separator = existing && !existing.endsWith('\n') ? '\n' : ''
    await this.writeKeyFile(user, path, existing + separator + publicKeyLine(key, comment.replace(/\s+/g, '_')), 0o600)
  }

  /** Changes `uid`'s password (the first terminal's user, when none is given), after checking the old one */
  async password(oldPassword: string, newPassword: string, uid: number = this._options.getShellCredentials().uid) {
    const user = this._users.get(uid)
    if (!user) throw new Error(this._options.context.i18n.t('User not found'))

    try {
      if (!(await verifyPassword(oldPassword, user.password))) throw new Error('Invalid password')
      validatePassword(newPassword)

      const today = daysSinceEpoch()
      const { lastChange, min } = user.aging ?? {}
      if (min && min > 0 && lastChange !== undefined && today - lastChange < min) throw new Error('You must wait longer to change your password')

      user.password = await hashPassword(newPassword)
      user.aging = { ...user.aging, lastChange: today }
      await this.rewrapKey(user, oldPassword, newPassword)
      await this.update(user.uid, user)
      await this.writeShadowEntry(user)
    } catch (err) {
      console.error(err)
      throw err
    }
  }

  /**
   * Sets `uid`'s password without knowing the old one, which only root may ask for (`passwd LOGIN`). The
   * account's private key stays encrypted under the old password, since there is nothing to unlock it with.
   */
  async resetPassword(uid: number, newPassword: string) {
    const user = this._users.get(uid)
    if (!user) throw new Error(this._options.context.i18n.t('User not found'))
    validatePassword(newPassword)
    user.password = await hashPassword(newPassword)
    user.aging = { ...user.aging, lastChange: daysSinceEpoch() }
    await this.update(user.uid, user)
    await this.writeShadowEntry(user)
  }

  // -- /etc/shadow ----------------------------------------------------------------------------------

  /** The line `/etc/shadow` holds for `user`: what it knows, and whatever the file had past the ninth field */
  private shadowEntry(user: User, existing?: ShadowEntry): ShadowEntry {
    const aging = user.aging ?? {}
    return { name: user.username, hash: user.password, ...aging, rest: existing?.rest ?? [] }
  }

  /** Rewrites one user's line, leaving every other line as it is */
  private writeShadowEntry(user: User): Promise<void> {
    return this.editShadow(file => setEntry(file, this.shadowEntry(user, findEntry(file, user.username))))
  }

  /** Reads `/etc/shadow`, lets `edit` change it, and writes it back; edits are queued, so two cannot lose each other's change */
  private editShadow(edit: (file: ShadowFile) => void): Promise<void> {
    const work = async () => {
      const text = await this.fs.readFile('/etc/shadow', 'utf-8').catch(() => '')
      const file = parseShadow(text)
      edit(file)
      await this.fs.writeFile('/etc/shadow', serializeShadow(file), { encoding: 'utf-8', mode: 0o640 })
      await this.secureShadow()
    }
    const next = this._shadowQueue.then(work, work)
    this._shadowQueue = next.catch(() => {})
    return next
  }

  /** Mode `0640`, owned by root and the `shadow` group (root's own group until that exists) */
  async secureShadow(): Promise<void> {
    try {
      await this.fs.chmod('/etc/shadow', 0o640)
      await this.fs.chown('/etc/shadow', 0, this.findGroup(SHADOW_GROUP)?.gid ?? 0)
    } catch (error) {
      this._options.context.log.warn(`Could not set the mode of /etc/shadow: ${error}`)
    }
  }

  /** Makes the account unusable for password logins: a `!` before the hash (`passwd -l`) */
  async lock(uid: number): Promise<void> {
    const user = this._users.get(uid)
    if (!user) throw new Error(`User with UID ${uid} not found`)
    user.password = lockHash(user.password)
    await this.writeShadowEntry(user)
  }

  /** Takes the `!` away (`passwd -u`); refused when that would leave no password at all */
  async unlock(uid: number): Promise<void> {
    const user = this._users.get(uid)
    if (!user) throw new Error(`User with UID ${uid} not found`)
    const hash = unlockHash(user.password)
    if (hasNoPassword(hash)) throw new Error('unlocking the password would result in a passwordless account; give it a password first')
    user.password = hash
    await this.writeShadowEntry(user)
  }

  /** Whether the account is locked (`passwd -l`) */
  isLocked(uid: number): boolean {
    const user = this._users.get(uid)
    return !!user && isLocked(user.password)
  }

  /** Sets the password aging fields (`chage`): a number sets one, `null` clears it. The password itself is not touched. */
  async setAging(uid: number, changes: Partial<Record<keyof Aging, number | null>>): Promise<void> {
    const user = this._users.get(uid)
    if (!user) throw new Error(`User with UID ${uid} not found`)
    const aging: Aging = { ...user.aging }
    for (const [field, value] of Object.entries(changes) as Array<[keyof Aging, number | null | undefined]>) {
      if (value === undefined) continue
      if (value === null) delete aging[field]
      else if (!Number.isInteger(value) || value < 0) throw new Error(`invalid ${field} value '${value}'`)
      else aging[field] = value
    }
    user.aging = aging
    await this.writeShadowEntry(user)
  }

  /** Re-hashes a password in an older form, from the plaintext of the login that just succeeded */
  private async upgradeHash(user: User, password: string): Promise<void> {
    try {
      user.password = await hashPassword(password)
      this._users.set(user.uid, user)
      await this.writeShadowEntry(user)
      this._options.context.log.info(`Upgraded the password hash for user ${user.username}`)
    } catch (error) {
      // Best-effort: a failure here must not block the login that already succeeded.
      this._options.context.log.warn(`Failed to upgrade the password hash for user ${user.username}: ${error}`)
    }
  }

  // -- the user's key pair (~/.ssh) -----------------------------------------------------------------

  private keyPaths(user: User) {
    return { directory: `${user.home}/.ssh`, privateKey: `${user.home}/${PRIVATE_KEY_FILE}`, publicKey: `${user.home}/${PUBLIC_KEY_FILE}` }
  }

  /** The user's public key (`~/.ssh/id_ecdsa.pub`), or `null` when there is none yet */
  async getPublicKey(uid: number): Promise<JsonWebKey | null> {
    const user = this._users.get(uid)
    if (!user) return null
    const { publicKey } = this.keyPaths(user)
    if (!(await this.fs.exists(publicKey))) return null
    return parsePublicKeyLine(await this.fs.readFile(publicKey, 'utf-8'))
  }

  /**
   * The user's public key, making the pair first if there is none. The private half is encrypted under `password`,
   * which has to be the user's current one. A key that exists but cannot be unlocked with it (an administrator
   * changed the password since) is not replaced: that would destroy it.
   */
  async ensureKeypair(uid: number, password: string): Promise<JsonWebKey> {
    const user = this._users.get(uid)
    if (!user) throw new Error(`User with UID ${uid} not found`)
    if (!(await verifyPassword(password, user.password))) throw new Error('Invalid password')

    const { directory, privateKey, publicKey } = this.keyPaths(user)
    if (await this.fs.exists(privateKey)) {
      const wrapped = parseWrappedKey(await this.fs.readFile(privateKey, 'utf-8'))
      if (wrapped && await unwrapKey(wrapped, password)) {
        const existing = await this.getPublicKey(uid)
        if (existing) return existing
      }
      throw new Error(`${privateKey} exists and cannot be unlocked with this password`)
    }

    const pair = await generateKeyPair(password)
    await this.fs.mkdir(directory, { recursive: true, mode: 0o700 })
    await this.fs.chown(directory, user.uid, user.gid).catch(() => {})
    await this.writeKeyFile(user, privateKey, JSON.stringify(pair.wrapped) + '\n', 0o600)
    await this.writeKeyFile(user, publicKey, publicKeyLine(pair.publicKey, user.username), 0o644)
    return pair.publicKey
  }

  /** The private key, decrypted with the user's password, or `null` (no key, or a wrong password) */
  async unlockPrivateKey(uid: number, password: string): Promise<JsonWebKey | null> {
    const user = this._users.get(uid)
    if (!user) return null
    const { privateKey } = this.keyPaths(user)
    if (!(await this.fs.exists(privateKey))) return null
    const wrapped = parseWrappedKey(await this.fs.readFile(privateKey, 'utf-8'))
    return wrapped ? unwrapKey(wrapped, password) : null
  }

  /**
   * Signs `data` with the user's key (making the pair first if there is none), for a login to another machine. The private key
   * is decrypted here with the user's password and never leaves; the caller gets the public key and the signature.
   */
  async signWithKey(uid: number, password: string, data: Uint8Array): Promise<{ publicKey: JsonWebKey, signature: Uint8Array }> {
    const publicKey = await this.ensureKeypair(uid, password)
    const privateKey = await this.unlockPrivateKey(uid, password)
    if (!privateKey) throw new Error('Could not unlock the key')
    const key = await crypto.subtle.importKey('jwk', privateKey, { name: 'ECDSA', namedCurve: 'P-384' }, false, ['sign'])
    const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-384' }, key, data as BufferSource))
    return { publicKey, signature }
  }

  private async writeKeyFile(user: User, path: string, text: string, mode: number): Promise<void> {
    await this.fs.writeFile(path, text, { encoding: 'utf-8', mode })
    await this.fs.chmod(path, mode).catch(() => {})
    await this.fs.chown(path, user.uid, user.gid).catch(() => {})
  }

  /** After a password change: encrypts the private key under the new password. A key that cannot be read is left alone. */
  private async rewrapKey(user: User, oldPassword: string, newPassword: string): Promise<void> {
    const { privateKey } = this.keyPaths(user)
    try {
      if (!(await this.fs.exists(privateKey))) return
      const wrapped = parseWrappedKey(await this.fs.readFile(privateKey, 'utf-8'))
      const jwk = wrapped ? await unwrapKey(wrapped, oldPassword) : null
      if (!jwk) { this._options.context.log.warn(`Could not unlock ${privateKey} to change its password; it is unchanged`); return }
      await this.writeKeyFile(user, privateKey, JSON.stringify(await wrapKey(jwk, newPassword)) + '\n', 0o600)
    } catch (error) {
      this._options.context.log.warn(`Could not re-encrypt ${privateKey}: ${error}`)
    }
  }

  /**
   * Remove a user from the system
  */
  async remove(uid: number) {
    const user = this._users.get(uid)
    this._users.delete(uid)
    // the group the user was named after goes with them, unless someone else is in it or uses it
    if (user) {
      const group = this._groups.get(user.gid)
      const used = Array.from(this._users.values()).some(other => other.gid === user.gid || other.groups.includes(user.gid))
      if (group && group.name === user.username && !used) this._groups.delete(user.gid)
    }
    await this.writePasswdAndGroup()
    if (user) await this.editShadow(file => { removeEntry(file, user.username) })
    // we leave the home directory behind for the admin to delete manually
  }

  /**
   * Update a user
   */
  async update(uid: number, user: Partial<User>) {
    const existingUser = this._users.get(uid);
    if (existingUser) {
      this._users.set(uid, { ...existingUser, ...user });
      await this.writePasswdAndGroup()
    } else {
      throw new Error(`User with UID ${uid} not found`);
    }
  }

  /**
   * Get all passkeys for a user
   */
  async getPasskeys(uid: number): Promise<Passkey[]> {
    const user = this._users.get(uid)
    if (!user) return []

    const passkeysPath = `${user.home}/.passkeys`
    try {
      const exists = await this.fs.exists(passkeysPath)
      if (!exists) return []

      const content = await this.fs.readFile(passkeysPath, 'utf-8')
      const parsed = JSON.parse(content) as Array<Omit<Passkey, 'publicKey'> & { publicKey: string }>
      
      return parsed.map(pk => {
        const publicKeyArray = JSON.parse(pk.publicKey)
        return {
          ...pk,
          publicKey: new Uint8Array(publicKeyArray)
        }
      })
    } catch (error) {
      this._options.context.log.warn(`Failed to read passkeys for user ${uid}: ${error}`)
      return []
    }
  }

  /**
   * Save passkeys for a user
   */
  async savePasskeys(uid: number, passkeys: Passkey[]): Promise<void> {
    const user = this._users.get(uid)
    if (!user) throw new Error(`User with UID ${uid} not found`)

    const passkeysPath = `${user.home}/.passkeys`
    
    const serialized = passkeys.map(pk => {
      const publicKeyArray = pk.publicKey instanceof ArrayBuffer 
        ? Array.from(new Uint8Array(pk.publicKey))
        : Array.from(pk.publicKey)
      
      return {
        ...pk,
        publicKey: JSON.stringify(publicKeyArray)
      }
    })

    await this.fs.writeFile(
      passkeysPath,
      JSON.stringify(serialized, null, 2),
      { encoding: 'utf-8', mode: 0o600 }
    )
    
    try {
      await this.fs.chown(passkeysPath, uid, user.gid)
    } catch {}
  }

  /**
   * Add a passkey to a user's collection
   */
  async addPasskey(uid: number, passkey: Passkey): Promise<void> {
    const existing = await this.getPasskeys(uid)
    existing.push(passkey)
    await this.savePasskeys(uid, existing)
  }

  /**
   * Remove a passkey by ID
   */
  async removePasskey(uid: number, passkeyId: string): Promise<void> {
    const existing = await this.getPasskeys(uid)
    const filtered = existing.filter(pk => pk.id !== passkeyId)
    await this.savePasskeys(uid, filtered)
  }

  /**
   * Check if a user has any registered passkeys
   */
  async hasPasskeys(uid: number): Promise<boolean> {
    const passkeys = await this.getPasskeys(uid)
    return passkeys.length > 0
  }
}
