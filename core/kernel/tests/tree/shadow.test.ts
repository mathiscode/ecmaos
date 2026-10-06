import { describe, expect, it } from 'vitest'

import {
  daysSinceEpoch, findEntry, hasNoPassword, isLocked, isPasswordDisabled, loginBlock, lockHash, parseShadow, removeEntry,
  renameEntry, serializeShadow, setEntry, unlockHash
} from '#lib/shadow.ts'

describe('shadow file', () => {
  it('round-trips Linux-shaped lines', () => {
    const text = 'alice:$pbkdf2-sha256$210000$c2FsdA$aGFzaA:20367:0:99999:7:::\ndaemon:*:20367:0:99999:7:::\n'
    expect(serializeShadow(parseShadow(text))).toBe(text)
  })

  it('reads every field', () => {
    const entry = findEntry(parseShadow('bob:$x$y:100:1:90:7:3:200:\n'), 'bob')!
    expect(entry).toMatchObject({ name: 'bob', hash: '$x$y', lastChange: 100, min: 1, max: 90, warn: 7, inactive: 3, expire: 200 })
  })

  it('leaves unset fields empty, and a short line is padded to nine on rewrite', () => {
    const file = parseShadow('carol:$x$y')
    expect(findEntry(file, 'carol')).toMatchObject({ lastChange: undefined, min: undefined, expire: undefined })
    expect(serializeShadow(file)).toBe('carol:$x$y:::::::\n')
  })

  it('keeps fields past the ninth, and comments, on rewrite', () => {
    const text = '# managed by ecmaOS\nalice:$x$y:1:0:99999:7:::reserved:extra\n'
    const file = parseShadow(text)
    setEntry(file, { ...findEntry(file, 'alice')!, lastChange: 2 })
    expect(serializeShadow(file)).toBe('# managed by ecmaOS\nalice:$x$y:2:0:99999:7:::reserved:extra\n')
  })

  it('always ends in a newline and has no blank lines', () => {
    expect(serializeShadow(parseShadow('a:*:::::::\n\n\nb:*:::::::'))).toBe('a:*:::::::\nb:*:::::::\n')
    expect(serializeShadow(parseShadow(''))).toBe('')
    expect(serializeShadow(parseShadow('\n\n'))).toBe('')
  })

  it('matches by exact name, not by prefix', () => {
    const file = parseShadow('al:*:::::::\nalice:*:::::::\n')
    expect(findEntry(file, 'al')?.name).toBe('al')
    expect(removeEntry(file, 'al')).toBe(true)
    expect(serializeShadow(file)).toBe('alice:*:::::::\n')
    expect(removeEntry(file, 'ali')).toBe(false)
    expect(removeEntry(file, 'al')).toBe(false)
  })

  it('replaces an entry in place and appends a new one', () => {
    const file = parseShadow('a:*:::::::\nb:*:::::::\n')
    setEntry(file, { ...findEntry(file, 'a')!, hash: '!*' })
    setEntry(file, { name: 'c', hash: '*', rest: [] })
    expect(serializeShadow(file)).toBe('a:!*:::::::\nb:*:::::::\nc:*:::::::\n')
  })

  it('renames an entry where it is, keeping the other fields', () => {
    const file = parseShadow('a:$x$y:5:0:99999:7:::\nb:*:::::::\n')
    expect(renameEntry(file, 'a', 'z')).toBe(true)
    expect(renameEntry(file, 'a', 'q')).toBe(false)
    expect(serializeShadow(file)).toBe('z:$x$y:5:0:99999:7:::\nb:*:::::::\n')
  })

  it('treats a line with no name or no hash field as text, kept as written', () => {
    const file = parseShadow(':x\njunk')
    expect(file.lines).toEqual([{ text: ':x' }, { text: 'junk' }])
    expect(serializeShadow(file)).toBe(':x\njunk\n')
  })
})

describe('hash states', () => {
  it('locks and unlocks, and says which', () => {
    expect(lockHash('$x$y')).toBe('!$x$y')
    expect(lockHash('!$x$y')).toBe('!$x$y')
    expect(unlockHash('!$x$y')).toBe('$x$y')
    expect(isLocked('!$x$y')).toBe(true)
    expect(isLocked('$x$y')).toBe(false)
    expect(isPasswordDisabled('*')).toBe(true)
    expect(isPasswordDisabled('!*')).toBe(true)
    expect(isPasswordDisabled('$x$y')).toBe(false)
    expect(hasNoPassword('')).toBe(true)
    expect(hasNoPassword('!')).toBe(true)
    expect(hasNoPassword('*')).toBe(false)
  })
})

describe('aging at login', () => {
  const today = 20_000
  it('lets an account with nothing set in', () => {
    expect(loginBlock({}, today)).toBeUndefined()
    expect(loginBlock({ lastChange: 19_000, max: 99999 }, today)).toBeUndefined()
  })
  it('closes an account on its expire day', () => {
    expect(loginBlock({ expire: today + 1 }, today)).toBeUndefined()
    expect(loginBlock({ expire: today }, today)).toBe('account expired')
    expect(loginBlock({ expire: today - 5 }, today)).toBe('account expired')
  })
  it('closes an account whose password is past max plus inactive', () => {
    expect(loginBlock({ lastChange: today - 40, max: 30, inactive: 10 }, today)).toBeUndefined()
    expect(loginBlock({ lastChange: today - 41, max: 30, inactive: 10 }, today)).toBe('password expired')
  })
  it('does not close one past max when no inactive period is set (the password still works)', () => {
    expect(loginBlock({ lastChange: today - 400, max: 30 }, today)).toBeUndefined()
  })
  it('counts days from the epoch in UTC', () => {
    expect(daysSinceEpoch(0)).toBe(0)
    expect(daysSinceEpoch(86_400_000 * 20_000 + 5)).toBe(20_000)
  })
})
