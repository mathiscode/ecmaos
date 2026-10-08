import { describe, expect, it } from 'vitest'

import { DEFAULT_GETTY_ENTRIES, gettyEntries, DEFAULT_INITTAB, RespawnTracker, entryKey, gettyTerminals, isUntouchedInittab, parseInittab, splitCommand, withGettyEntries, withoutGettyEntries } from '../../src/lib/inittab.ts'

describe('splitCommand', () => {
  it('splits on whitespace and drops the quotes', () => {
    expect(splitCommand('/bin/crond -f  --name "a b" \'c d\'')).toEqual(['/bin/crond', '-f', '--name', 'a b', 'c d'])
  })

  it('keeps an empty quoted word, and joins adjacent quoted pieces', () => {
    expect(splitCommand('echo "" a"b"\'c\'')).toEqual(['echo', '', 'abc'])
  })

  it('escapes with a backslash outside quotes, and only quotes and backslashes inside double quotes', () => {
    expect(splitCommand('a\\ b "x\\"y" "p\\qr"')).toEqual(['a b', 'x"y', 'p\\qr'])
  })

  it('refuses an open quote and a trailing backslash', () => {
    expect(() => splitCommand('echo "oops')).toThrow(/unterminated "/)
    expect(() => splitCommand("echo 'oops")).toThrow(/unterminated '/)
    expect(() => splitCommand('echo oops\\')).toThrow(/backslash/)
  })
})

describe('parseInittab', () => {
  it('reads the default file', () => {
    const { entries, errors } = parseInittab(DEFAULT_INITTAB)
    expect(errors).toEqual([])
    expect(entries.map(entry => [entry.action, entry.argv])).toEqual([
      ['sysinit', ['/boot/init']],
      ['respawn', ['/bin/crond']]
    ])
  })

  it('takes id, runlevels, action and command, and keeps colons that belong to the command', () => {
    const { entries } = parseInittab('tty1:2345:respawn:/bin/sh -c "echo a:b"\n::once:/bin/true')
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ id: 'tty1', runlevels: '2345', action: 'respawn', command: '/bin/sh -c "echo a:b"', argv: ['/bin/sh', '-c', 'echo a:b'], line: 1 })
    expect(entries[1]).toMatchObject({ id: '', runlevels: '', action: 'once', argv: ['/bin/true'], line: 2 })
  })

  it('skips comments and blank lines, tolerates indentation and CRLF, and counts lines', () => {
    const { entries, errors } = parseInittab('# a comment\r\n\r\n   # indented\r\n  ::wait:/bin/a  \r\n::once:/bin/b')
    expect(errors).toEqual([])
    expect(entries.map(entry => [entry.line, entry.command])).toEqual([[4, '/bin/a'], [5, '/bin/b']])
  })

  it('reports an unusable line and still reads the rest of the file', () => {
    const { entries, errors } = parseInittab([
      '::sysinit:/boot/init',
      'not an entry',
      '::sometimes:/bin/x',
      '::respawn:',
      '::respawn:/bin/y "open',
      '::once:/bin/z'
    ].join('\n'))
    expect(entries.map(entry => entry.command)).toEqual(['/boot/init', '/bin/z'])
    expect(errors.map(error => [error.line, error.reason])).toEqual([
      [2, 'expected id:runlevels:action:command'],
      [3, 'unknown action "sometimes"'],
      [4, 'missing command'],
      [5, 'unterminated " quote']
    ])
  })

  it('says why a BusyBox-only action was skipped', () => {
    const { entries, errors } = parseInittab('::ctrlaltdel:/bin/reboot\n::askfirst:/bin/sh\n::restart:/sbin/init')
    expect(entries).toEqual([])
    expect(errors[2]!.reason).toMatch(/restart action is not supported/)
    expect(errors[0]!.reason).toMatch(/ctrlaltdel action is not supported.*reboot command/)
    expect(errors[1]!.reason).toMatch(/askfirst action is not supported/)
  })

  it('accepts every supported action', () => {
    const text = ['sysinit', 'wait', 'once', 'respawn', 'shutdown'].map(action => `::${action}:/bin/${action}`).join('\n')
    const { entries, errors } = parseInittab(text)
    expect(errors).toEqual([])
    expect(entries.map(entry => entry.action)).toEqual(['sysinit', 'wait', 'once', 'respawn', 'shutdown'])
  })
})

describe('entryKey', () => {
  it('is the same for the same line and different for another command or action', () => {
    const [a, b, c] = parseInittab('::respawn:/bin/a\n::respawn:/bin/a\n::once:/bin/a').entries
    expect(entryKey(a!)).toBe(entryKey(b!))
    expect(entryKey(a!)).not.toBe(entryKey(c!))
  })
})

describe('RespawnTracker', () => {
  const options = { initialMs: 1000, maxMs: 8000, resetAfterMs: 30_000 }

  it('doubles the delay for a service that keeps dying, up to the cap', () => {
    const tracker = new RespawnTracker(options)
    const delays: number[] = []
    let now = 0
    for (let i = 0; i < 6; i++) {
      tracker.start('k', now)
      now += 100
      delays.push(tracker.exit('k', now))
      now += delays[i]!
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 8000, 8000])
  })

  it('restarts a healthy service at once and forgets the history', () => {
    const tracker = new RespawnTracker(options)
    tracker.start('k', 0)
    expect(tracker.exit('k', 100)).toBe(1000)
    tracker.start('k', 1100)
    expect(tracker.exit('k', 1200)).toBe(2000)
    tracker.start('k', 3200)
    expect(tracker.exit('k', 3200 + 30_000)).toBe(0)
    tracker.start('k', 40_000)
    expect(tracker.exit('k', 40_050)).toBe(1000)
  })

  it('keeps each service on its own, and forget starts one over', () => {
    const tracker = new RespawnTracker(options)
    tracker.start('a', 0)
    tracker.start('b', 0)
    expect(tracker.exit('a', 10)).toBe(1000)
    tracker.start('a', 1010)
    expect(tracker.exit('a', 1020)).toBe(2000)
    expect(tracker.exit('b', 10)).toBe(1000)
    tracker.forget('a')
    tracker.start('a', 5000)
    expect(tracker.exit('a', 5010)).toBe(1000)
  })
})

describe('an untouched inittab', () => {
  const oldHeader = '# /etc/inittab\n::sysinit:/boot/init\n::respawn:/bin/crond\n'

  it('is any file holding only the entries the kernel writes, whatever its comments say', () => {
    expect(isUntouchedInittab(DEFAULT_INITTAB)).toBe(true)
    expect(isUntouchedInittab(DEFAULT_INITTAB + DEFAULT_GETTY_ENTRIES)).toBe(true)
    expect(isUntouchedInittab(oldHeader)).toBe(true)
    expect(isUntouchedInittab(oldHeader + 'tty0::respawn:/sbin/getty tty0\n')).toBe(true)
  })

  it('is not one with another entry, a changed command or a line that does not parse', () => {
    expect(isUntouchedInittab(oldHeader + '::respawn:/bin/mything\n')).toBe(false)
    expect(isUntouchedInittab(oldHeader + 'tty0::respawn:/sbin/getty tty1\n')).toBe(false)
    expect(isUntouchedInittab(oldHeader + '::shutdown:/bin/echo bye\n')).toBe(false)
    expect(isUntouchedInittab(oldHeader + 'garbage\n')).toBe(false)
    expect(isUntouchedInittab('')).toBe(false)
  })

  it('gains a getty for each missing terminal, keeping its text', () => {
    const text = withGettyEntries(oldHeader)
    expect(text.startsWith(oldHeader)).toBe(true)
    expect([...gettyTerminals(text)].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(withGettyEntries(text)).toBe(text)
  })

  it('loses its getty entries and nothing else', () => {
    expect(withoutGettyEntries(oldHeader + DEFAULT_GETTY_ENTRIES)).toBe(oldHeader)
    expect(withoutGettyEntries(oldHeader)).toBe(oldHeader)
  })

  it('writes a getty for only as many terminals as the machine has', () => {
    expect(gettyTerminals(withGettyEntries(DEFAULT_INITTAB, 1))).toEqual(new Set([0]))
    expect(gettyTerminals(DEFAULT_INITTAB + gettyEntries(3))).toEqual(new Set([0, 1, 2]))
    expect(gettyTerminals(withGettyEntries(DEFAULT_INITTAB))).toEqual(new Set([0, 1, 2, 3, 4, 5, 6, 7]))
    expect(isUntouchedInittab(DEFAULT_INITTAB + gettyEntries(1))).toBe(true)
  })
})
