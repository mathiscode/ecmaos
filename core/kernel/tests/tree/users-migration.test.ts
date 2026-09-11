import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { isLegacyHash } from '#lib/credentials.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * Existing ecmaOS installs have users with an unsalted SHA-256 password hash and a private key
 * wrapped by an AES key derived by zero-padding the raw password -- both formats predating
 * PBKDF2 support. Those users must keep working, and be moved onto the new format transparently
 * the next time they successfully log in, since there is no other moment a plaintext password is
 * available to re-derive anything from.
 */
describe('Legacy credential migration', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()
  })

  async function legacyHash(password: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password.trim()))
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
  }

  it('logs in a legacy unsalted-SHA-256 user and migrates the hash in place', async () => {
    const password = 'legacy-user-password'
    const hash = await legacyHash(password)

    await kernel.users.add(
      { username: 'legacyuser', password: hash, uid: 500, gid: 500 },
      { noHash: true }
    )

    const before = kernel.users.get(500)
    expect(before?.password).toBe(hash)
    expect(isLegacyHash(before!.password)).toBe(true)

    const { user } = await kernel.users.login('legacyuser', password)
    expect(user.uid).toBe(500)

    const after = kernel.users.get(500)
    expect(isLegacyHash(after!.password)).toBe(false)
    expect(after!.password.startsWith('pbkdf2$')).toBe(true)

    // The migrated hash must still verify the same password, and the on-disk shadow entry
    // must reflect the migration too (not just the in-memory user object).
    const relogin = await kernel.users.login('legacyuser', password)
    expect(relogin.user.uid).toBe(500)

    const shadow = await kernel.filesystem.fs.readFile('/etc/shadow', 'utf-8')
    const line = shadow.split('\n').find(l => l.startsWith('legacyuser:'))
    expect(line).toBeDefined()
    expect(line).not.toContain(`:${hash}:`)
  })

  it('rejects a wrong password for a legacy user without migrating', async () => {
    const password = 'another-legacy-password'
    const hash = await legacyHash(password)

    await kernel.users.add(
      { username: 'legacyuser2', password: hash, uid: 501, gid: 501 },
      { noHash: true }
    )

    await expect(kernel.users.login('legacyuser2', 'wrong-password')).rejects.toThrow()

    const stillLegacy = kernel.users.get(501)
    expect(isLegacyHash(stillLegacy!.password)).toBe(true)
  })
})
