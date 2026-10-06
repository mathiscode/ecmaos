import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { Users } from '#users.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { hashPassword, verifyPassword } from '#lib/credentials.ts'
import { wrapKey } from '#lib/keys.ts'
import { runFsMigrations, FS_VERSION_FILE } from '#lib/fs-migrations.ts'
import { daysSinceEpoch, findEntry, parseShadow } from '#lib/shadow.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** The `/etc/shadow` an account is kept in: its shape, its states, the key pair that no longer lives there, and the move from the old format. */
describe('/etc/shadow', () => {
  let kernel: Kernel
  const fs = () => kernel.filesystem.fs
  const shadow = async () => parseShadow(await fs().readFile('/etc/shadow', 'utf-8'))
  const entry = async (name: string) => findEntry(await shadow(), name)
  /** A second `Users` over the same files: what the next boot would load */
  const reload = async (uid = 0) => {
    const users = new Users({ context: kernel.context, filesystem: kernel.filesystem, getShellCredentials: () => ({ uid }) } as never)
    await users.load()
    return users
  }

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
  }, 60000)

  describe('format', () => {
    it('writes nine fields as shadow(5) has them, with the password hash in the second', async () => {
      await kernel.users.add({ username: 'alice', password: 'alice-pass', uid: 1100, gid: 1100 }, { noHome: true })
      const text = await fs().readFile('/etc/shadow', 'utf-8')
      const line = text.split('\n').find(l => l.startsWith('alice:'))!
      const fields = line.split(':')
      expect(fields).toHaveLength(9)
      expect(fields[1]).toMatch(/^\$pbkdf2-sha256\$210000\$/)
      expect(Number(fields[2])).toBeGreaterThanOrEqual(daysSinceEpoch() - 1)
      expect(fields.slice(3, 6)).toEqual(['0', '99999', '7'])
      expect(fields.slice(6)).toEqual(['', '', ''])
      expect(text.endsWith('\n')).toBe(true)
      expect(text).not.toMatch(/\n\n/)
    })

    it('is mode 0640, owned by root and the shadow group (42)', async () => {
      const info = await fs().stat('/etc/shadow')
      expect(info.mode & 0o777).toBe(0o640)
      expect(info.uid).toBe(0)
      expect(info.gid).toBe(42)
      expect(kernel.users.findGroup('shadow')?.gid).toBe(42)
    })

    it('holds no key and no uid or gid', async () => {
      const line = (await fs().readFile('/etc/shadow', 'utf-8')).split('\n').find(l => l.startsWith('alice:'))!
      expect(line).not.toContain('eyJ') // base64 of a JWK
      expect(line.split(':')[1]).not.toBe('1100')
    })

    it('is read back after a reload, aging and all', async () => {
      await kernel.users.setAging(1100, { max: 90, warn: 14, expire: daysSinceEpoch() + 400 })
      const users = await reload()
      expect(users.get(1100)?.aging).toMatchObject({ min: 0, max: 90, warn: 14, expire: daysSinceEpoch() + 400 })
      expect(await verifyPassword('alice-pass', users.get(1100)!.password)).toBe(true)
    })

    it('matches names exactly when it removes or renames one', async () => {
      await kernel.users.add({ username: 'al', password: 'al-pass', uid: 1101, gid: 1101 }, { noHome: true })
      await kernel.users.remove(1101)
      expect(await entry('al')).toBeUndefined()
      expect(await entry('alice')).toBeDefined()
      await kernel.users.rename(1100, 'alicia')
      expect(await entry('alice')).toBeUndefined()
      expect(await entry('alicia')).toMatchObject({ lastChange: expect.any(Number), max: 90 })
      await kernel.users.rename(1100, 'alice')
    })

    it('keeps a comment and a field past the ninth when another account is rewritten', async () => {
      const text = await fs().readFile('/etc/shadow', 'utf-8')
      await fs().writeFile('/etc/shadow', '# kept\n' + text.replace(/^(alice:.*)$/m, '$1:future'), { mode: 0o640 })
      await kernel.users.add({ username: 'bob', password: 'bob-pass', uid: 1102, gid: 1102 }, { noHome: true })
      const after = await fs().readFile('/etc/shadow', 'utf-8')
      expect(after.startsWith('# kept\n')).toBe(true)
      expect(after.split('\n').find(l => l.startsWith('alice:'))).toMatch(/:future$/)
    })

    it('does not make a password change cost an account its other lines', async () => {
      const before = (await shadow()).lines.length
      await kernel.users.password('bob-pass', 'bob-new-pass', 1102)
      expect((await shadow()).lines.length).toBe(before)
      expect(await verifyPassword('bob-new-pass', (await entry('bob'))!.hash)).toBe(true)
    })
  })

  describe('key pair', () => {
    it('is not made with the account, and login does not need it', async () => {
      await kernel.users.add({ username: 'carol', password: 'carol-pass', uid: 1103, gid: 1103 })
      expect(await fs().exists('/home/carol/.ssh')).toBe(false)
      expect((await kernel.users.login('carol', 'carol-pass')).user.uid).toBe(1103)
      expect(await kernel.users.getPublicKey(1103)).toBeNull()
    })

    it('is made on first use, in ~/.ssh, private 0600 and public 0644, owned by the user', async () => {
      const publicKey = await kernel.users.ensureKeypair(1103, 'carol-pass')
      expect(publicKey).toMatchObject({ kty: 'EC', crv: 'P-384' })
      const priv = await fs().stat('/home/carol/.ssh/id_ecdsa')
      const pub = await fs().stat('/home/carol/.ssh/id_ecdsa.pub')
      expect([priv.mode & 0o777, pub.mode & 0o777]).toEqual([0o600, 0o644])
      expect([priv.uid, pub.uid, priv.gid]).toEqual([1103, 1103, 1103])
      expect((await fs().stat('/home/carol/.ssh')).mode & 0o777).toBe(0o700)
      expect(await kernel.users.getPublicKey(1103)).toEqual(publicKey)
      expect(await kernel.users.ensureKeypair(1103, 'carol-pass')).toEqual(publicKey) // the same key, not a new one
      expect(await kernel.users.unlockPrivateKey(1103, 'carol-pass')).toMatchObject({ kty: 'EC', crv: 'P-384', d: expect.any(String) })
      expect(await kernel.users.unlockPrivateKey(1103, 'wrong-pass')).toBeNull()
      await expect(kernel.users.ensureKeypair(1103, 'wrong-pass')).rejects.toThrow(/Invalid password/)
    })

    it('survives a reload and a password change (the old loader truncated it, and the first passwd destroyed it)', async () => {
      const privateBefore = await kernel.users.unlockPrivateKey(1103, 'carol-pass')
      const users = await reload(1103)
      await users.password('carol-pass', 'carol-new-pass', 1103)
      expect(await users.unlockPrivateKey(1103, 'carol-new-pass')).toEqual(privateBefore)
      expect(await users.unlockPrivateKey(1103, 'carol-pass')).toBeNull()
      expect(await users.getPublicKey(1103)).not.toBeNull()
      expect(await verifyPassword('carol-new-pass', (await entry('carol'))!.hash)).toBe(true)
      expect((await shadow()).lines.length).toBeGreaterThan(0)
    })

    it('is not replaced when an administrator has changed the password since (that would destroy it)', async () => {
      await kernel.users.resetPassword(1103, 'admin-set-pass')
      await expect(kernel.users.ensureKeypair(1103, 'admin-set-pass')).rejects.toThrow(/cannot be unlocked/)
      expect(await kernel.users.unlockPrivateKey(1103, 'carol-new-pass')).not.toBeNull()
    })
  })

  describe('states', () => {
    it('lock stops a password login, unlock restores it, and both are in the file', async () => {
      await kernel.users.add({ username: 'dave', password: 'dave-pass', uid: 1104, gid: 1104 }, { noHome: true })
      await kernel.users.lock(1104)
      expect((await entry('dave'))!.hash.startsWith('!$pbkdf2-sha256$')).toBe(true)
      await expect(kernel.users.login('dave', 'dave-pass')).rejects.toThrow('Invalid username or password')
      expect(kernel.users.isLocked(1104)).toBe(true)
      await kernel.users.unlock(1104)
      expect((await entry('dave'))!.hash.startsWith('$pbkdf2-sha256$')).toBe(true)
      expect((await kernel.users.login('dave', 'dave-pass')).user.uid).toBe(1104)
    })

    it('a system account has * and no password logs in, and unlocking * leaves it as it was', async () => {
      await kernel.users.add({ username: 'svc', password: '*', uid: 150, gid: 150 }, { noHash: true, noHome: true })
      expect((await entry('svc'))!.hash).toBe('*')
      await expect(kernel.users.login('svc', '*')).rejects.toThrow()
      await expect(kernel.users.login('svc', 'anything')).rejects.toThrow()
      await kernel.users.lock(150)
      expect((await entry('svc'))!.hash).toBe('!*')
      await kernel.users.unlock(150)
      expect((await entry('svc'))!.hash).toBe('*')
    })

    it('refuses to unlock an account that would be left with no password', async () => {
      await kernel.users.add({ username: 'ghost', password: '!', uid: 1105, gid: 1105 }, { noHash: true, noHome: true })
      await expect(kernel.users.unlock(1105)).rejects.toThrow(/passwordless/)
    })

    it('a password change records the day, and the minimum age holds a second change off', async () => {
      await kernel.users.add({ username: 'erin', password: 'erin-pass', uid: 1106, gid: 1106 }, { noHome: true })
      await kernel.users.setAging(1106, { lastChange: 100 })
      await kernel.users.password('erin-pass', 'erin-pass2', 1106)
      expect((await entry('erin'))!.lastChange).toBe(daysSinceEpoch())
      await kernel.users.setAging(1106, { min: 5 })
      await expect(kernel.users.password('erin-pass2', 'erin-pass3', 1106)).rejects.toThrow(/wait longer/)
      await kernel.users.resetPassword(1106, 'erin-reset') // an administrator is not held to it
    })

    it('an expired account is closed to a password login, once the password is right', async () => {
      await kernel.users.add({ username: 'frank', password: 'frank-pass', uid: 1107, gid: 1107 }, { noHome: true })
      await kernel.users.setAging(1107, { expire: daysSinceEpoch() - 1 })
      await expect(kernel.users.login('frank', 'frank-pass')).rejects.toThrow(/account has expired/)
      await expect(kernel.users.login('frank', 'wrong-pass')).rejects.toThrow('Invalid username or password')
      await kernel.users.setAging(1107, { expire: null })
      expect((await kernel.users.login('frank', 'frank-pass')).user.uid).toBe(1107)
    })

    it('a password past max plus inactive closes the account, and not before', async () => {
      await kernel.users.add({ username: 'gwen', password: 'gwen-pass', uid: 1108, gid: 1108 }, { noHome: true })
      await kernel.users.setAging(1108, { lastChange: daysSinceEpoch() - 40, max: 30, inactive: 20 })
      expect((await kernel.users.login('gwen', 'gwen-pass')).user.uid).toBe(1108)
      await kernel.users.setAging(1108, { inactive: 5 })
      await expect(kernel.users.login('gwen', 'gwen-pass')).rejects.toThrow(/password has expired/)
    })

    it('an account in passwd with no shadow line loads locked', async () => {
      await fs().writeFile('/etc/passwd', (await fs().readFile('/etc/passwd', 'utf-8')) + 'orphan:x:1200:1200:orphan:/home/orphan:ecmaos\n')
      const users = await reload()
      expect(users.byName('orphan')).toBeDefined()
      await expect(users.login('orphan', 'whatever')).rejects.toThrow()
      expect(users.isLocked(1200)).toBe(true)
      await fs().writeFile('/etc/passwd', (await fs().readFile('/etc/passwd', 'utf-8')).replace('orphan:x:1200:1200:orphan:/home/orphan:ecmaos\n', ''))
    })

    it('upgrades the first pbkdf2 format at the next login, and leaves a failed login alone', async () => {
      const salt = Uint8Array.from({ length: 16 }, (_, i) => i)
      const material = await crypto.subtle.importKey('raw', new TextEncoder().encode('hank-pass'), 'PBKDF2', false, ['deriveBits'])
      const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 1000, hash: 'SHA-256' }, material, 256))
      const first = `pbkdf2$1000$${btoa(String.fromCharCode(...salt))}$${btoa(String.fromCharCode(...bits))}`
      await kernel.users.add({ username: 'hank', password: first, uid: 1109, gid: 1109 }, { noHash: true, noHome: true })

      await expect(kernel.users.login('hank', 'wrong-pass')).rejects.toThrow()
      expect((await entry('hank'))!.hash).toBe(first)

      expect((await kernel.users.login('hank', 'hank-pass')).user.uid).toBe(1109)
      const upgraded = (await entry('hank'))!.hash
      expect(upgraded).toMatch(/^\$pbkdf2-sha256\$210000\$/)
      expect(await verifyPassword('hank-pass', upgraded)).toBe(true)
    })
  })

  describe('migration from the old format', () => {
    const quiet = { info() {}, warn() {} }
    const run = () => runFsMigrations({ fs: fs(), log: quiet, legacyCommandNames: new Set() })
    const reset = async () => { await fs().unlink(FS_VERSION_FILE).catch(() => {}) }
    const oldPassword = 'zed-password'

    async function oldLine(name: string, uid: number, hash: string, key: 'intact' | 'truncated' | 'legacy' | 'none' = 'intact') {
      if (key === 'none') return `${name}:${uid}:${uid}:${hash}`
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, true, ['sign', 'verify'])
      const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
      const wrapped = await wrapKey(await crypto.subtle.exportKey('jwk', pair.privateKey), oldPassword)
      const publicKey = btoa(JSON.stringify(jwk))
      if (key === 'intact') return `${name}:${uid}:${uid}:${hash}:${publicKey}:${wrapped.salt}:${wrapped.iv}:${wrapped.data}`
      if (key === 'truncated') return `${name}:${uid}:${uid}:${hash}:${publicKey}:${wrapped.salt}`
      return `${name}:${uid}:${uid}:${hash}:${publicKey}:${wrapped.iv}${wrapped.data}`
    }

    it('converts every old shape, and only moves a key that survived', async () => {
      const hash = await hashPassword(oldPassword)
      const oldStyleHash = `pbkdf2$1000$${btoa('salt')}$${btoa('hash')}`
      const sha = '0'.repeat(63) + '1'
      const names = ['zed', 'trunc', 'legacy', 'hexed', 'nohome', 'orphan2']
      const passwd = names.map((name, i) => `${name}:x:${2000 + i}:${2000 + i}:${name}:/home/${name}:ecmaos`).join('\n') + '\nbare:x:2100:2100:bare:/home/bare:ecmaos\n'
      await fs().writeFile('/etc/passwd', passwd)
      for (const name of names.filter(n => n !== 'nohome' && n !== 'orphan2')) await fs().mkdir(`/home/${name}`, { recursive: true })
      await fs().mkdir('/home/bare', { recursive: true })
      await fs().writeFile('/etc/shadow', [
        '# old',
        await oldLine('zed', 2000, hash),
        await oldLine('trunc', 2001, oldStyleHash, 'truncated'),
        await oldLine('legacy', 2002, hash, 'legacy'),
        await oldLine('hexed', 2003, sha, 'none'),
        await oldLine('nohome', 2004, hash),
        '',
        ''
      ].join('\n'))
      await reset()
      await run()

      const file = await shadow()
      expect(file.lines[0]).toEqual({ text: '# old' })
      const zed = findEntry(file, 'zed')!
      expect(zed.hash).toBe(hash)
      expect(zed).toMatchObject({ lastChange: daysSinceEpoch(), min: 0, max: 99999, warn: 7 })
      expect(findEntry(file, 'trunc')!.hash).toBe(oldStyleHash)
      expect(findEntry(file, 'hexed')!.hash).toBe(sha)
      expect(findEntry(file, 'orphan2')!.hash).toBe('!')
      expect(findEntry(file, 'bare')!.hash).toBe('!')
      for (const line of (await fs().readFile('/etc/shadow', 'utf-8')).trim().split('\n').slice(1)) expect(line.split(':')).toHaveLength(9)
      expect((await fs().stat('/etc/shadow')).mode & 0o777).toBe(0o640)

      // the intact key is in ~/.ssh and still opens with the password it had
      const users = await reload()
      expect(users.byName('zed')).toBeDefined()
      expect((await fs().stat('/home/zed/.ssh/id_ecdsa')).mode & 0o777).toBe(0o600)
      expect((await fs().stat('/home/zed/.ssh/id_ecdsa')).uid).toBe(2000)
      expect(await users.unlockPrivateKey(2000, oldPassword)).toMatchObject({ kty: 'EC', crv: 'P-384' })
      expect(await users.getPublicKey(2000)).toMatchObject({ kty: 'EC', crv: 'P-384' })
      expect(await fs().exists('/home/trunc/.ssh')).toBe(false)
      expect(await fs().exists('/home/legacy/.ssh')).toBe(false)
      expect(await fs().exists('/home/nohome')).toBe(false)
      expect((await users.login('zed', oldPassword)).user.uid).toBe(2000)
    })

    it('is safe to run twice, and does not touch a key already in ~/.ssh', async () => {
      const before = await fs().readFile('/etc/shadow', 'utf-8')
      const key = await fs().readFile('/home/zed/.ssh/id_ecdsa', 'utf-8')
      await reset()
      await run()
      expect(await fs().readFile('/etc/shadow', 'utf-8')).toBe(before)
      expect(await fs().readFile('/home/zed/.ssh/id_ecdsa', 'utf-8')).toBe(key)
    })

    it('is a no-op on a file already in the new format', async () => {
      const text = 'a:$pbkdf2-sha256$210000$AAAA$BBBB:20000:0:99999:7:::\n'
      await fs().writeFile('/etc/passwd', 'a:x:3000:3000:a:/home/a:ecmaos\n')
      await fs().writeFile('/etc/shadow', text)
      await reset()
      await run()
      expect(await fs().readFile('/etc/shadow', 'utf-8')).toBe(text)
    })
  })
})
