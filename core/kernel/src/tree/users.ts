/**
 * @experimental
 * @author Jay Mathis <code@mathis.network> (https://github.com/mathiscode)
 *
 * The Users class handles the management of users on the system.
 * It provides functionality to add, get, load, login, password, remove, and update users.
 */

import type {
  AddUserOptions,
  Passkey,
  User,
  UsersOptions
} from '@ecmaos/types'
import { createCredentials, Credentials } from '@zenfs/core'
import { deriveAesKey, fromBase64, generateKeySalt, hashPassword, isLegacyHash, toBase64, verifyPassword } from './lib/credentials.ts'
import { appendText } from './lib/append-file.ts'

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

    if (!user.username || !user.password) throw new Error('Username and password are required')
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

    if (!user.keypair) {
      const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, true, ['sign', 'verify'])
      const privateKey = await crypto.subtle.exportKey('jwk', keyPair.privateKey)
      const publicKey = await crypto.subtle.exportKey('jwk', keyPair.publicKey)

      const keySalt = generateKeySalt()
      let aesKey
      try {
        aesKey = await deriveAesKey(unhashedPassword, keySalt)
      } catch (err) {
        console.error(err)
        throw err
      }

      const iv = crypto.getRandomValues(new Uint8Array(12))
      const encryptedPrivateKeyBuffer = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        aesKey,
        new TextEncoder().encode(JSON.stringify(privateKey))
      )

      // Store as keySalt:iv:ciphertext, each base64, so unwrapping doesn't need a re-derivation guess
      const encryptedPrivateKey = `${toBase64(keySalt)}:${toBase64(iv)}:${toBase64(new Uint8Array(encryptedPrivateKeyBuffer))}`

      user.keypair = { publicKey }
      if (!options.noWrite) await appendText(this.fs, '/etc/shadow', `${user.username}:${user.uid}:${user.gid}:${user.password}:${btoa(JSON.stringify(publicKey))}:${encryptedPrivateKey}\n\n`, { mode: 0o700 })
    }

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
    const shadow = await this.fs.readFile('/etc/shadow', 'utf-8').catch(() => '')
    await this.fs.writeFile('/etc/shadow', shadow.split('\n').filter((line: string) => line.trim() && !line.startsWith(`${old}:`)).join('\n') + '\n', { encoding: 'utf-8', mode: 0o700 })
    await this.writeShadowEntry(user)
    await this.writePasswdAndGroup()
  }

  /** Gives an account another uid: its `/etc/shadow` line follows, and the files in its home directory are handed over. */
  async changeUid(uid: number, newUid: number): Promise<void> {
    const user = this._users.get(uid)
    if (!user) throw new Error(`User with UID ${uid} not found`)
    if (!Number.isInteger(newUid) || newUid < 0) throw new Error(`invalid user ID '${newUid}'`)
    if (newUid === uid) return
    if (this._users.has(newUid)) throw new Error(`UID '${newUid}' already exists`)
    this._users.delete(uid)
    user.uid = newUid
    this._users.set(newUid, user)
    await this.writeShadowEntry(user)
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
   * An administrator sets a password without knowing the old one. The hash and `/etc/shadow` are rewritten. The
   * private key stays wrapped under the old password, so it can no longer be unlocked, as with an encrypted home
   * directory on Linux; nothing at login needs it.
   */
  async resetPassword(uid: number, newPassword: string): Promise<void> {
    const user = this._users.get(uid)
    if (!user) throw new Error(`User with UID ${uid} not found`)
    validatePassword(newPassword)
    user.password = await hashPassword(newPassword)
    await this.writeShadowEntry(user)
  }

  /**
   * Load users from the filesystem
   */
  async load() {
    const { context } = this._options
    const passwd = await this.fs.readFile('/etc/passwd', 'utf-8')
    const shadow = await this.fs.readFile('/etc/shadow', 'utf-8')
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
      const shadowEntry = shadow.split('\n').find((l: string) => l.startsWith(username + ':'))

      if (shadowEntry) {
        const [,,, password, publicKey, encryptedPrivateKey] = shadowEntry.split(':')
        if (!publicKey || !encryptedPrivateKey) {
          context.log.warn(`User ${username} has no keypair`)
          continue
        }

        const keypair = { publicKey: JSON.parse(atob(publicKey!)), privateKey: encryptedPrivateKey }
        await this.add({
          username,
          password,
          uid: parseInt(uid),
          gid: parseInt(gid),
          groups: supplementaryGroups.get(username) ?? [],
          home,
          shell,
          keypair
        }, { noWrite: true, noHome: true, noHash: true })
      } else {
        context.log.warn(`User ${username} not found in /etc/shadow`)
      }
    }
  }

  /**
   * Login a user
   */
  async login(username: string, password?: string, passkeyCredential?: PublicKeyCredential): Promise<{ user: User, cred: Credentials }> {
    const user = Array.from(this._users.values()).find(u => u.username === username)
    if (!user) throw new Error('Invalid username or password')

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

      // A successful login is the one safe moment to upgrade an older (unsalted SHA-256, or
      // unsalted zero-padded AES key) credential in place: the plaintext password is in hand,
      // and the user has just proven they own the account.
      if (isLegacyHash(user.password)) {
        await this.migrateLegacyCredentials(user, password)
      }
    } else {
      throw new Error('Password or passkey required')
    }

    const cred = createCredentials({
      uid: user.uid,
      gid: user.gid,
      euid: user.uid,
      egid: user.gid,
      groups: user.groups
    })

    return { user, cred }
  }

  /** Changes `uid`'s password (the first terminal's user, when none is given), after checking the old one */
  async password(oldPassword: string, newPassword: string, uid: number = this._options.getShellCredentials().uid) {
    const user = this._users.get(uid)
    if (!user) throw new Error(this._options.context.i18n.t('User not found'))

    try {
      if (!(await verifyPassword(oldPassword, user.password))) throw new Error('Invalid password')
      validatePassword(newPassword)

      user.password = await hashPassword(newPassword)
      await this.rewrapPrivateKey(user, newPassword)
      await this.update(user.uid, user)
      await this.writeShadowEntry(user)
    } catch (err) {
      console.error(err)
      throw err
    }
  }

  /**
   * Re-encrypt the given /etc/shadow line for one user with its current in-memory password hash
   * and keypair, leaving every other user's line untouched.
   */
  private async writeShadowEntry(user: User): Promise<void> {
    const shadow = await this.fs.readFile('/etc/shadow', 'utf-8')
    const lines = shadow.split('\n').filter((l: string) => l.trim() !== '' && !l.startsWith(`${user.username}:`))
    const publicKeyB64 = btoa(JSON.stringify(user.keypair?.publicKey))
    const encryptedPrivateKey = user.keypair?.privateKey ?? ''
    lines.push(`${user.username}:${user.uid}:${user.gid}:${user.password}:${publicKeyB64}:${encryptedPrivateKey}`)
    await this.fs.writeFile('/etc/shadow', lines.join('\n') + '\n', { encoding: 'utf-8', mode: 0o700 })
  }

  /**
   * Re-wrap a user's ECDSA private key under a freshly derived AES key for a new password.
   * Requires the private key to already be decryptable with the *old* password -- call this
   * before overwriting `user.password`'s in-memory value is not required, only that the caller
   * has already verified the old password and still holds the plaintext new password.
   */
  private async rewrapPrivateKey(user: User, newPassword: string, oldPassword?: string): Promise<void> {
    if (!user.keypair?.privateKey || typeof user.keypair.privateKey !== 'string') return

    const privateKeyJwk = await this.decryptPrivateKey(user.keypair.privateKey, oldPassword ?? newPassword, user)
    if (!privateKeyJwk) return

    const keySalt = generateKeySalt()
    const aesKey = await deriveAesKey(newPassword, keySalt)
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, new TextEncoder().encode(JSON.stringify(privateKeyJwk)))
    user.keypair.privateKey = `${toBase64(keySalt)}:${toBase64(iv)}:${toBase64(new Uint8Array(encrypted))}`
  }

  /**
   * Decrypt a wrapped private key, transparently handling both the current keySalt:iv:ciphertext
   * format and the older format (iv+ciphertext only, key derived by zero-padding the password).
   */
  private async decryptPrivateKey(wrapped: string, password: string, _user: User): Promise<JsonWebKey | null> {
    try {
      const parts = wrapped.split(':')
      if (parts.length === 3) {
        const [saltB64, ivB64, dataB64] = parts as [string, string, string]
        const aesKey = await deriveAesKey(password, fromBase64(saltB64))
        const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(ivB64) as BufferSource }, aesKey, fromBase64(dataB64) as BufferSource)
        return JSON.parse(new TextDecoder().decode(decrypted))
      }

      // Older format: base64(iv ++ ciphertext), key = password zero-padded to 32 bytes
      const raw = fromBase64(wrapped)
      const iv = raw.slice(0, 12)
      const data = raw.slice(12)
      const paddedPassword = new TextEncoder().encode(password.padEnd(32, '\0')).slice(0, 32)
      const aesKey = await crypto.subtle.importKey('raw', paddedPassword as BufferSource, 'AES-GCM', false, ['decrypt'])
      const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, aesKey, data as BufferSource)
      return JSON.parse(new TextDecoder().decode(decrypted))
    } catch (error) {
      this._options.context.log.warn(`Failed to decrypt private key: ${error}`)
      return null
    }
  }

  /**
   * Upgrade a user's on-disk credentials from an unsalted-SHA-256 password hash and zero-padded
   * AES key wrapping to PBKDF2 + salted AES-GCM, in place, using the plaintext password from the
   * login that just succeeded.
   */
  private async migrateLegacyCredentials(user: User, password: string): Promise<void> {
    try {
      user.password = await hashPassword(password)
      await this.rewrapPrivateKey(user, password, password)
      this._users.set(user.uid, user)
      await this.writeShadowEntry(user)
      this._options.context.log.info(`Upgraded credentials for user ${user.username} to PBKDF2`)
    } catch (error) {
      // Best-effort: a failure here must not block the login that already succeeded.
      this._options.context.log.warn(`Failed to upgrade credentials for user ${user.username}: ${error}`)
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
