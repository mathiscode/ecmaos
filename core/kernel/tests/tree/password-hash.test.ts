import { describe, expect, it } from 'vitest'

import { fromAb64, hashPassword, isLegacyHash, needsRehash, toAb64, verifyPassword } from '#lib/credentials.ts'

describe('password hashes', () => {
  it('writes the passlib pbkdf2-sha256 shape, with nothing a shadow line or a $ split could trip on', async () => {
    const hash = await hashPassword('correct horse')
    expect(hash).toMatch(/^\$pbkdf2-sha256\$210000\$[./A-Za-z0-9]+\$[./A-Za-z0-9]+$/)
    expect(hash.split('$')).toHaveLength(5)
    expect(hash).not.toContain(':')
    expect(await verifyPassword('correct horse', hash)).toBe(true)
    expect(await verifyPassword('wrong horse', hash)).toBe(false)
  })

  it('salts each hash', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'))
  })

  it('reads a hash made by another implementation (a Python hashlib vector)', async () => {
    const stored = '$pbkdf2-sha256$1000$AAECAwQFBgcICQoLDA0ODw$yRTMTwbMbo9G0VfjobWqerzuuxe7BETNTErBbKKumGQ'
    expect(await verifyPassword('correct horse', stored)).toBe(true)
    expect(await verifyPassword('correct hors', stored)).toBe(false)
  })

  it('still verifies the first pbkdf2 format and unsalted hex, and says they want an upgrade', async () => {
    const old = 'pbkdf2$1000$AAECAwQFBgcICQoLDA0ODw==$yRTMTwbMbo9G0VfjobWqerzuuxe7BETNTErBbKKumGQ='
    expect(await verifyPassword('correct horse', old)).toBe(true)
    expect(needsRehash(old)).toBe(true)

    const hex = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('legacy')))).map(b => b.toString(16).padStart(2, '0')).join('')
    expect(isLegacyHash(hex)).toBe(true)
    expect(await verifyPassword('legacy', hex)).toBe(true)
    expect(needsRehash(hex)).toBe(true)
  })

  it('wants an upgrade only for a hash that has one to go to', async () => {
    expect(needsRehash(await hashPassword('fresh'))).toBe(false)
    expect(needsRehash('$pbkdf2-sha256$1000$AAECAwQFBgcICQoLDA0ODw$yRTMTwbMbo9G0VfjobWqerzuuxe7BETNTErBbKKumGQ')).toBe(true) // fewer rounds
    for (const state of ['', '*', '!', '!*', '!$pbkdf2-sha256$210000$AAECAwQFBgcICQoLDA0ODw$yRTMTwbMbo9G0VfjobWqerzuuxe7BETNTErBbKKumGQ']) expect(needsRehash(state)).toBe(false)
  })

  it('never verifies a locked, disabled or empty hash, or garbage', async () => {
    const good = await hashPassword('secret')
    for (const stored of ['', '*', '!', '!*', `!${good}`, '$pbkdf2-sha256$0$AAAA$AAAA', '$pbkdf2-sha256$1000$!!$!!', '$6$salt$hash', 'garbage']) {
      expect(await verifyPassword('secret', stored), stored).toBe(false)
    }
  })

  it('round-trips adapted base64, which uses . where base64 has +', () => {
    const bytes = Uint8Array.from([0xfb, 0xef, 0xbe, 0xff, 0xfe, 1, 2])
    const text = toAb64(bytes)
    expect(text).toMatch(/^[./A-Za-z0-9]+$/)
    expect(text).toContain('.')
    expect(Array.from(fromAb64(text))).toEqual(Array.from(bytes))
  })
})
