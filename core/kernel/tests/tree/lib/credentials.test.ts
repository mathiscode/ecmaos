import { describe, expect, it } from 'vitest'

import { deriveAesKey, generateKeySalt, hashPassword, isLegacyHash, verifyPassword } from '#lib/credentials.ts'

describe('isLegacyHash', () => {
  it('recognizes a 64-character hex digest as legacy', () => {
    expect(isLegacyHash('a'.repeat(64))).toBe(true)
  })

  it('does not treat a pbkdf2-tagged hash as legacy', () => {
    expect(isLegacyHash('pbkdf2$210000$c2FsdA==$aGFzaA==')).toBe(false)
  })
})

describe('hashPassword / verifyPassword', () => {
  it('hashes a password and verifies it correctly', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(hash.startsWith('pbkdf2$')).toBe(true)
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true)
    expect(await verifyPassword('wrong password', hash)).toBe(false)
  })

  it('produces a different salt (and hash) each time for the same password', async () => {
    const a = await hashPassword('same password')
    const b = await hashPassword('same password')
    expect(a).not.toBe(b)
  })

  it('verifies against a legacy unsalted SHA-256 hex digest', async () => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('legacy password'))
    const legacyHash = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
    expect(isLegacyHash(legacyHash)).toBe(true)
    expect(await verifyPassword('legacy password', legacyHash)).toBe(true)
    expect(await verifyPassword('wrong', legacyHash)).toBe(false)
  })

  it('trims whitespace the same way both sides', async () => {
    const hash = await hashPassword('  padded  ')
    expect(await verifyPassword('padded', hash)).toBe(true)
  })
})

describe('deriveAesKey', () => {
  it('derives usable, deterministic AES-GCM keys from the same password and salt', async () => {
    const salt = generateKeySalt()
    const keyA = await deriveAesKey('a password', salt)
    const keyB = await deriveAesKey('a password', salt)

    const iv = crypto.getRandomValues(new Uint8Array(12))
    const plaintext = new TextEncoder().encode('secret payload')
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keyA, plaintext)
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, keyB, ciphertext)
    expect(new TextDecoder().decode(decrypted)).toBe('secret payload')
  })

  it('derives a different key for a different salt', async () => {
    const saltA = generateKeySalt()
    const saltB = generateKeySalt()
    const keyA = await deriveAesKey('a password', saltA)

    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keyA, new TextEncoder().encode('data'))

    const keyB = await deriveAesKey('a password', saltB)
    await expect(crypto.subtle.decrypt({ name: 'AES-GCM', iv }, keyB, ciphertext)).rejects.toThrow()
  })
})
