import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { parseAuthorizedKeys } from '#lib/keys.ts'
import { daysSinceEpoch } from '#lib/shadow.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** Logging in with a key rather than a password: `authorized_keys`, a session without one, signing, and a terminal for it. */
describe('login by key', () => {
  let kernel: Kernel
  const fs = () => kernel.filesystem.fs
  const jwk = (x: string): JsonWebKey => ({ kty: 'EC', crv: 'P-384', x: x.repeat(64), y: 'y'.repeat(64) })

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
    await kernel.users.add({ username: 'erin', password: 'erin-pass', uid: 1200, gid: 1200 })
  }, 60000)

  describe('authorized_keys', () => {
    it('has no keys until one is added, and none at all for a user that does not exist', async () => {
      expect(await kernel.users.getAuthorizedKeys('erin')).toEqual([])
      expect(await kernel.users.getAuthorizedKeys('nobody')).toBeUndefined()
    })

    it('adds a key to ~/.ssh/authorized_keys, private and theirs, and reads it back', async () => {
      await kernel.users.authorizeKey('erin', jwk('a'), 'laptop')
      const file = await fs().stat('/home/erin/.ssh/authorized_keys')
      expect([file.mode & 0o777, file.uid, file.gid]).toEqual([0o600, 1200, 1200])
      expect((await fs().stat('/home/erin/.ssh')).mode & 0o777).toBe(0o700)
      expect(await kernel.users.getAuthorizedKeys('erin')).toEqual([jwk('a')])
      expect(await fs().readFile('/home/erin/.ssh/authorized_keys', 'utf-8')).toMatch(/^ecdsa-p384 \S+ laptop\n$/)
    })

    it('does not add the same key twice, adds others after it, and keeps a comment on one line', async () => {
      await kernel.users.authorizeKey('erin', jwk('a'), 'again')
      await kernel.users.authorizeKey('erin', jwk('b'), 'a comment with spaces')
      expect(await kernel.users.getAuthorizedKeys('erin')).toEqual([jwk('a'), jwk('b')])
      expect((await fs().readFile('/home/erin/.ssh/authorized_keys', 'utf-8')).split('\n').filter(Boolean)).toHaveLength(2)
    })

    it('reads a hand-edited file: comments, blank lines, a file with no final newline, and lines it cannot read are skipped', () => {
      const line = (x: string) => `ecdsa-p384 ${btoa(JSON.stringify(jwk(x)))} c`
      expect(parseAuthorizedKeys(`# mine\n\n${line('a')}\nssh-ed25519 AAAA other\nnot a key\n${line('b')}`)).toEqual([jwk('a'), jwk('b')])
    })

    it('is not a login by itself: an unknown user cannot be given a key', async () => {
      await expect(kernel.users.authorizeKey('nobody', jwk('a'), 'x')).rejects.toThrow(/not found/)
    })
  })

  describe('a session without a password', () => {
    it('is the user\'s own credentials', async () => {
      const { user, cred } = await kernel.users.sessionFor('erin')
      expect([user.uid, cred.uid, cred.euid, cred.gid]).toEqual([1200, 1200, 1200, 1200])
    })

    it('fails for an unknown user like a wrong password does', async () => {
      await expect(kernel.users.sessionFor('nobody')).rejects.toThrow('Invalid username or password')
    })

    it('is closed to an expired account, and not to a locked password (that stops passwords only)', async () => {
      await kernel.users.add({ username: 'frank', password: 'frank-pass', uid: 1201, gid: 1201 }, { noHome: true })
      await kernel.users.lock(1201)
      expect((await kernel.users.sessionFor('frank')).user.uid).toBe(1201)
      await kernel.users.unlock(1201)
      await kernel.users.update(1201, { aging: { ...kernel.users.get(1201)!.aging!, expire: daysSinceEpoch() - 1 } })
      await expect(kernel.users.sessionFor('frank')).rejects.toThrow(/expired/)
    })
  })

  describe('signing with the key', () => {
    it('signs with the user\'s key, making it first, and the signature verifies with the public key it returns', async () => {
      const data = new TextEncoder().encode('a challenge')
      const { publicKey, signature } = await kernel.users.signWithKey(1200, 'erin-pass', data)
      expect(publicKey).toMatchObject({ kty: 'EC', crv: 'P-384' })
      const key = await crypto.subtle.importKey('jwk', publicKey, { name: 'ECDSA', namedCurve: 'P-384' }, false, ['verify'])
      expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-384' }, key, signature as BufferSource, data as BufferSource)).toBe(true)
      expect(await kernel.users.getPublicKey(1200)).toEqual(publicKey)
    })

    it('needs the right password, and says nothing about the key otherwise', async () => {
      await expect(kernel.users.signWithKey(1200, 'wrong', new Uint8Array(1))).rejects.toThrow(/Invalid password/)
    })
  })

  describe('a terminal for the session', () => {
    it('opens a shell for the user on a free TTY, writes to the caller, and frees the TTY at the end', async () => {
      const output: string[] = []
      let ended = false
      const session = await kernel.openSession({ username: 'erin', cols: 90, rows: 20, write: data => output.push(typeof data === 'string' ? data : new TextDecoder().decode(data)), onEnd: () => { ended = true } })
      expect(session.tty).toBeGreaterThanOrEqual(1)
      expect(session.terminal.cols).toBe(90)
      expect(kernel.getShell(session.tty)).toBe(session.shell)
      expect(session.shell.env.get('USER')).toBe('erin')
      expect(session.shell.env.get('HOME')).toBe('/home/erin')
      expect(output.join('')).toContain('erin')
      await session.close()
      expect(ended).toBe(true)
      expect(kernel.getShell(session.tty)).toBeUndefined()
      await session.close() // again: nothing happens
    })

    it('gives out TTY 1 to 7 only, refuses an eighth, and takes a freed one back', async () => {
      const sessions = []
      for (let index = 0; index < 7; index++) sessions.push(await kernel.openSession({ username: 'erin', write: () => {} }))
      expect(sessions.map(session => session.tty).sort()).toEqual([1, 2, 3, 4, 5, 6, 7])
      await expect(kernel.openSession({ username: 'erin', write: () => {} })).rejects.toThrow(/No free terminal/)
      await sessions[3]!.close()
      const again = await kernel.openSession({ username: 'erin', write: () => {} })
      expect(again.tty).toBe(sessions[3]!.tty)
      for (const session of [...sessions.filter((_, index) => index !== 3), again]) await session.close()
    })

    it('refuses a user who may not log in without leaving a TTY behind', async () => {
      await expect(kernel.openSession({ username: 'nobody', write: () => {} })).rejects.toThrow('Invalid username or password')
      expect(kernel.getShell(1)).toBeUndefined()
    })
  })
})
