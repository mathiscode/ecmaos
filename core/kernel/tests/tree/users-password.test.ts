import { describe, expect, it } from 'vitest'

import { MIN_PASSWORD_LENGTH, Users, validatePassword } from '#users.ts'

describe('validatePassword', () => {
  it('accepts an ordinary password, including the documented root/root default', () => {
    expect(() => validatePassword('root')).not.toThrow()
    expect(() => validatePassword('correct horse battery staple')).not.toThrow()
  })

  it('rejects empty, too-short, and non-string input', () => {
    expect(() => validatePassword('')).toThrow(/required/)
    expect(() => validatePassword(undefined)).toThrow(/required/)
    expect(() => validatePassword('x'.repeat(MIN_PASSWORD_LENGTH - 1))).toThrow(/at least/)
  })

  it('rejects ":" and line breaks, which would corrupt /etc/shadow and /etc/passwd', () => {
    expect(() => validatePassword('pass:word')).toThrow(/":"/)
    expect(() => validatePassword('pass\nword')).toThrow(/line breaks/)
    expect(() => validatePassword('pass\rword')).toThrow(/line breaks/)
  })
})

describe('Users.add password validation', () => {
  const users = new Users({
    filesystem: { fs: { chown: async () => {} } },
    context: { log: { warn() {}, info() {} } }
  } as never)

  it('refuses a plaintext password that fails validation', async () => {
    await expect(users.add({ username: 'shorty', password: 'abc', uid: 4001 }, { noHome: true, noWrite: true }))
      .rejects.toThrow(/at least/)
    expect(users.get(4001)).toBeUndefined()
  })

  it('does not re-validate an already-hashed password loaded from /etc/shadow', async () => {
    await users.add({ username: 'loaded', password: 'x', uid: 4002, keypair: { publicKey: {} } as never }, { noHash: true, noHome: true, noWrite: true })
    expect(users.get(4002)?.username).toBe('loaded')
  })
})
