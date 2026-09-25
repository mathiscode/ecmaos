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

/**
 * Serializes `/etc/group`: one line per group a user actually belongs to (`name:x:gid:members`),
 * `members` a comma-separated list of usernames. A user's own primary group (`gid`) always gets
 * an entry even with no members, matching `groupadd`'s behavior on a real system; a user's
 * supplementary groups (`user.groups`, numeric gids) add that user to each named group's member
 * list. Group names are synthesized from the owning/primary user's username when no other name is
 * known -- this system has no separate group-creation API yet, only users with a primary gid.
 */
function groupFile(users: Iterable<User>): string {
  const byGid = new Map<number, { name: string, members: Set<string> }>()
  const nameFor = (gid: number, fallbackUser?: User) => byGid.get(gid)?.name ?? fallbackUser?.username ?? `group${gid}`

  for (const user of users) {
    if (!byGid.has(user.gid)) byGid.set(user.gid, { name: nameFor(user.gid, user), members: new Set() })
  }
  for (const user of users) {
    for (const gid of user.groups) {
      if (!byGid.has(gid)) byGid.set(gid, { name: nameFor(gid), members: new Set() })
      byGid.get(gid)!.members.add(user.username)
    }
  }

  return Array.from(byGid.entries())
    .sort(([a], [b]) => a - b)
    .map(([gid, { name, members }]) => `${name}:x:${gid}:${Array.from(members).join(',')}`)
    .join('\n') + '\n'
}

export class Users {
  private _options: UsersOptions
  private _users: Map<number, User> = new Map()

  get all() { return this._users }

  private get fs() { return this._options.filesystem.fs }

  constructor(options: UsersOptions) {
    this._options = options
  }

  /** Rewrites both `/etc/passwd` and `/etc/group` from the current in-memory user map. */
  private async writePasswdAndGroup(): Promise<void> {
    const users = Array.from(this._users.values())
    await this.fs.writeFile('/etc/passwd', passwdFile(users), { encoding: 'utf-8', mode: 0o644 })
    await this.fs.writeFile('/etc/group', groupFile(users), { encoding: 'utf-8', mode: 0o644 })
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
      if (!options.noWrite) await this.fs.appendFile('/etc/shadow', `${user.username}:${user.uid}:${user.gid}:${user.password}:${btoa(JSON.stringify(publicKey))}:${encryptedPrivateKey}\n\n`, { encoding: 'utf-8', mode: 0o700 })
    }

    this._users.set(user.uid, user as User)
    if (!options.noWrite) await this.writePasswdAndGroup()

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
    for (const groupLine of group.split('\n')) {
      if (!groupLine.trim() || groupLine.startsWith('#')) continue
      const [, , gidStr, membersStr] = groupLine.split(':')
      const gid = Number(gidStr)
      if (!gidStr || Number.isNaN(gid)) continue
      for (const member of (membersStr ?? '').split(',').filter(Boolean)) {
        supplementaryGroups.set(member, [...(supplementaryGroups.get(member) ?? []), gid])
      }
    }

    for (const line of passwd.split('\n')) {
      if (line.trim() === '' || line.trim() === '\n' || line.startsWith('#')) continue
      // Real 7-field format: name:x:uid:gid:gecos:home:shell. A pre-1.0 6-field line
      // (name:uid:gid:groups:home:shell) is handled by the boot migration (`kernel.ts`'s
      // versioned-migration list), not here -- by the time `load()` runs, the fs is already current.
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

      // A successful login with a legacy (unsalted SHA-256, or unsalted zero-padded AES key)
      // credential is the one safe moment to migrate it in place: we have the plaintext
      // password in hand, and the user has just proven they own the account.
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

  async password(oldPassword: string, newPassword: string) {
    const user = this._users.get(this._options.getShellCredentials().uid)
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
   * format and the legacy format (iv+ciphertext only, key derived by zero-padding the password).
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

      // Legacy format: base64(iv ++ ciphertext), key = password zero-padded to 32 bytes
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
   * Migrate a user's on-disk credentials from the legacy unsalted-SHA-256 password hash and
   * legacy zero-padded-AES key wrapping to PBKDF2 + salted AES-GCM, in place, using the
   * plaintext password from the login that just succeeded against the legacy hash.
   */
  private async migrateLegacyCredentials(user: User, password: string): Promise<void> {
    try {
      user.password = await hashPassword(password)
      await this.rewrapPrivateKey(user, password, password)
      this._users.set(user.uid, user)
      await this.writeShadowEntry(user)
      this._options.context.log.info(`Migrated legacy credentials for user ${user.username} to PBKDF2`)
    } catch (error) {
      // Migration is best-effort: a failure here must not block the login that already succeeded.
      this._options.context.log.warn(`Failed to migrate legacy credentials for user ${user.username}: ${error}`)
    }
  }

  /**
   * Remove a user from the system
  */
  async remove(uid: number) {
    this._users.delete(uid)
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
