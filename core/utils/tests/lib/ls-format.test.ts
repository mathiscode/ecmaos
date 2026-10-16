import { describe, expect, it } from 'vitest'

import { columnLines, humanSize, indicator, longDate, longLines, modeString, parseLsArguments, parseNames, quoteName, sortEntries, type LsEntry } from '../../src/lib/ls-format'

const entry = (over: Partial<LsEntry>): LsEntry => ({ name: 'f', mode: 0o100644, size: 0, mtimeMs: 0, uid: 0, gid: 0, nlink: 1, ino: 1, rdev: 0, blocks: 0, ...over })

describe('parseLsArguments', () => {
  it('reads clustered short flags, long flags and operands', () => {
    const { options, error } = parseLsArguments(['-laR', '--human-readable', 'a', 'b'])
    expect(error).toBeUndefined()
    expect(options).toMatchObject({ long: true, all: true, recursive: true, human: true, operands: ['a', 'b'] })
  })

  it('-- ends options and - is an operand', () => {
    expect(parseLsArguments(['--', '-l', '-']).options.operands).toEqual(['-l', '-'])
    expect(parseLsArguments(['-']).options.operands).toEqual(['-'])
  })

  it('-1 undoes -l and the last sort flag wins', () => {
    expect(parseLsArguments(['-l', '-1']).options.long).toBe(false)
    expect(parseLsArguments(['-tS']).options.sort).toBe('size')
  })

  it('rejects an unknown option and recognizes --help', () => {
    expect(parseLsArguments(['-y']).error).toBe("invalid option -- 'y'")
    expect(parseLsArguments(['--nope']).error).toBe("unrecognized option '--nope'")
    expect(parseLsArguments(['--help']).options.help).toBe(true)
  })
})

describe('modeString', () => {
  it('prints type and permission characters', () => {
    expect(modeString(0o100644)).toBe('-rw-r--r--')
    expect(modeString(0o040755)).toBe('drwxr-xr-x')
    expect(modeString(0o120777)).toBe('lrwxrwxrwx')
    expect(modeString(0o120000)).toBe('lrwxrwxrwx')
    expect(modeString(0o020666)).toBe('crw-rw-rw-')
  })

  it('folds setuid, setgid and sticky into the execute column', () => {
    expect(modeString(0o104755)).toBe('-rwsr-xr-x')
    expect(modeString(0o104644)).toBe('-rwSr--r--')
    expect(modeString(0o042755)).toBe('drwxr-sr-x')
    expect(modeString(0o041777)).toBe('drwxrwxrwt')
    expect(modeString(0o041776)).toBe('drwxrwxrwT')
  })
})

describe('humanSize', () => {
  it('rounds up to one decimal below ten (always shown, 1.0K), like GNU ls -h', () => {
    expect(humanSize(0)).toBe('0')
    expect(humanSize(1023)).toBe('1023')
    expect(humanSize(1024)).toBe('1.0K')
    expect(humanSize(1536)).toBe('1.5K')
    expect(humanSize(1025)).toBe('1.1K')
    expect(humanSize(10 * 1024)).toBe('10K')
    expect(humanSize(10 * 1024 + 1)).toBe('11K')
    expect(humanSize(5 * 1024 * 1024)).toBe('5.0M')
  })
})

describe('longDate', () => {
  const now = new Date(2026, 9, 3, 15, 0).getTime()
  it('shows the time for a recent file and the year for an old or future one', () => {
    expect(longDate(new Date(2026, 9, 3, 9, 5).getTime(), now)).toBe('Oct  3 09:05')
    expect(longDate(new Date(2026, 0, 15, 12, 0).getTime(), now)).toBe('Jan 15  2026')
    expect(longDate(new Date(2024, 11, 25, 12, 0).getTime(), now)).toBe('Dec 25  2024')
    expect(longDate(new Date(2027, 1, 1, 12, 0).getTime(), now)).toBe('Feb  1  2027')
  })
})

describe('indicator', () => {
  it('marks directories, links, executables, fifos and sockets with -F, only directories with -p', () => {
    const F = { classify: true, slash: false }
    expect(indicator({ mode: 0o040755 }, F)).toBe('/')
    expect(indicator({ mode: 0o120777 }, F)).toBe('@')
    expect(indicator({ mode: 0o100755 }, F)).toBe('*')
    expect(indicator({ mode: 0o100644 }, F)).toBe('')
    expect(indicator({ mode: 0o010644 }, F)).toBe('|')
    expect(indicator({ mode: 0o140644 }, F)).toBe('=')
    expect(indicator({ mode: 0o100755 }, { classify: false, slash: true })).toBe('')
    expect(indicator({ mode: 0o040755 }, { classify: false, slash: true })).toBe('/')
    expect(indicator({ mode: 0o040755 }, { classify: false, slash: false })).toBe('')
  })
})

describe('sortEntries', () => {
  const entries = [entry({ name: 'b', size: 5, mtimeMs: 1 }), entry({ name: 'A', size: 9, mtimeMs: 3 }), entry({ name: 'a', size: 5, mtimeMs: 2 })]
  const names = (sort: 'name' | 'time' | 'size' | 'none', reverse = false) => sortEntries(entries, { sort, reverse }).map(e => e.name)

  it('sorts by name ignoring case first, then by time and size', () => {
    expect(names('name')).toEqual(['A', 'a', 'b'])
    expect(names('time')).toEqual(['A', 'a', 'b'])
    expect(names('size')).toEqual(['A', 'a', 'b'])
  })

  it('reverses, and -U keeps the given order', () => {
    expect(names('name', true)).toEqual(['b', 'a', 'A'])
    expect(names('none')).toEqual(['b', 'A', 'a'])
  })
})

describe('parseNames', () => {
  it('maps ids to the first name and ignores bad lines', () => {
    const map = parseNames('root:x:0:0::/root:/bin/sh\nalice:x:1:1\n\njunk\nbob:x:1:1')
    expect(map.get(0)).toBe('root')
    expect(map.get(1)).toBe('alice')
    expect(map.size).toBe(2)
  })
})

describe('longLines', () => {
  const names = { users: new Map([[0, 'root']]), groups: new Map([[0, 'root']]) }
  const options = { human: false, inode: false, classify: false, slash: false }
  const now = new Date(2026, 9, 3, 15, 0).getTime()

  it('aligns columns, resolves names, falls back to ids, and shows link targets', () => {
    const lines = longLines([
      entry({ name: 'a.txt', size: 5, mtimeMs: new Date(2026, 9, 3, 9, 5).getTime(), blocks: 8 }),
      entry({ name: 'big', size: 123456, uid: 1000, gid: 1000, nlink: 12, mtimeMs: new Date(2026, 9, 3, 9, 5).getTime(), blocks: 248 }),
      entry({ name: 'ln', mode: 0o120777, size: 1, linkTarget: '/etc/passwd', mtimeMs: new Date(2026, 9, 3, 9, 5).getTime() })
    ], names, options, now, true)
    // whole 4 KiB blocks in KiB: 4 for the small file, 124 for the big one, none for the link
    expect(lines[0]).toBe('total 128')
    expect(lines[1]).toBe('-rw-r--r--  1 root root      5 Oct  3 09:05 a.txt')
    expect(lines[2]).toBe('-rw-r--r-- 12 1000 1000 123456 Oct  3 09:05 big')
    expect(lines[3]).toBe('lrwxrwxrwx  1 root root      1 Oct  3 09:05 ln -> /etc/passwd')
  })

  it('shows device numbers instead of a size, human sizes with -h, and inodes with -i', () => {
    const device = entry({ name: 'null', mode: 0o020666, rdev: (1 << 20) | 3, mtimeMs: new Date(2026, 9, 3, 9, 5).getTime() })
    expect(longLines([device], names, options, now, false)[0]).toBe('crw-rw-rw- 1 root root 1, 3 Oct  3 09:05 null')
    const big = entry({ name: 'big', size: 1536, ino: 42, mtimeMs: new Date(2026, 9, 3, 9, 5).getTime() })
    expect(longLines([big], names, { ...options, human: true, inode: true }, now, false)[0]).toBe('42 -rw-r--r-- 1 root root 1.5K Oct  3 09:05 big')
  })

  it('appends indicators with -F', () => {
    const dir = entry({ name: 'd', mode: 0o040755, mtimeMs: new Date(2026, 9, 3, 9, 5).getTime() })
    expect(longLines([dir], names, { ...options, classify: true }, now, false)[0]).toMatch(/ d\/$/)
  })
})

describe('columnLines', () => {
  it('fills down the columns and fits the width', () => {
    const labels = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    expect(columnLines(labels, 80)).toEqual(['a  b  c  d  e  f  g'])
    expect(columnLines(labels, 10)).toEqual(['a  c  e  g', 'b  d  f'])
  })

  it('uses one column for names too wide to share a line', () => {
    expect(columnLines(['abcdefghij', 'klmnopqrst'], 12)).toEqual(['abcdefghij', 'klmnopqrst'])
  })

  it('pads each column to its own widest name', () => {
    const lines = columnLines(['alpha', 'b', 'gamma', 'd'], 13)
    expect(lines).toEqual(['alpha  gamma', 'b      d'])
  })

  it('is empty for nothing', () => {
    expect(columnLines([], 80)).toEqual([])
  })
})

/** The expected strings are what GNU ls 9 printed for the same names. */
describe('quoteName: the shell and locale styles', () => {
  const table: Array<[string, string, string, string, string]> = [
    // name, shell, shell-always, shell-escape, locale
    ['plain', 'plain', "'plain'", 'plain', '\u2018plain\u2019'],
    ['a b', "'a b'", "'a b'", "'a b'", '\u2018a b\u2019'],
    ["a'b", '"a\'b"', '"a\'b"', '"a\'b"', "\u2018a'b\u2019"],
    ['a"b', "'a\"b'", "'a\"b'", "'a\"b'", '\u2018a"b\u2019'],
    ['a$b', "'a$b'", "'a$b'", "'a$b'", '\u2018a$b\u2019'],
    ["a'\"b", "'a'\\''\"b'", "'a'\\''\"b'", "'a'\\''\"b'", "\u2018a'\"b\u2019"],
    ['#ab', "'#ab'", "'#ab'", "'#ab'", '\u2018#ab\u2019'],
    ['a#b', 'a#b', "'a#b'", 'a#b', '\u2018a#b\u2019'],
    ['~ab', "'~ab'", "'~ab'", "'~ab'", '\u2018~ab\u2019'],
    ['a=b', "'a=b'", "'a=b'", "'a=b'", '\u2018a=b\u2019'],
    ['%ab', '%ab', "'%ab'", '%ab', '\u2018%ab\u2019'],
    ['-ab', '-ab', "'-ab'", '-ab', '\u2018-ab\u2019'],
    ['a*b', "'a*b'", "'a*b'", "'a*b'", '\u2018a*b\u2019'],
    ['a\\b', "'a\\b'", "'a\\b'", "'a\\b'", '\u2018a\\\\b\u2019'],
    ['\u00e9', '\u00e9', "'\u00e9'", '\u00e9', '\u2018\u00e9\u2019'],
    ['a\tb', "'a\tb'", "'a\tb'", "'a'$'\\t''b'", '\u2018a\\tb\u2019'],
    ['a\x01b', "'a\x01b'", "'a\x01b'", "'a'$'\\001''b'", '\u2018a\\001b\u2019']
  ]
  it.each(table)('%j', (name, shell, always, escape, locale) => {
    expect(quoteName(name, 'shell')).toBe(shell)
    expect(quoteName(name, 'shell-always')).toBe(always)
    expect(quoteName(name, 'shell-escape')).toBe(escape)
    expect(quoteName(name, 'locale')).toBe(locale)
  })
  it('--quoting-style takes the new words and names the valid ones for a wrong one', () => {
    expect(parseLsArguments(['--quoting-style=shell-escape']).options.quoting).toBe('shell-escape')
    expect(parseLsArguments(['--quoting-style=bogus']).error).toContain("invalid argument 'bogus' for '--quoting-style'")
  })
})
