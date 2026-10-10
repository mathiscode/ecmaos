import { describe, expect, it } from 'vitest'

import { colorFor, paint, parseLsColors } from '../../src/lib/ls-colors'
import { columnLines, longLines, parseLsArguments, type LsEntry } from '../../src/lib/ls-format'

const entry = (over: Partial<LsEntry>): LsEntry => ({ name: 'f', mode: 0o100644, size: 0, mtimeMs: 0, uid: 0, gid: 0, nlink: 1, ino: 1, rdev: 0, blocks: 0, ...over })
const defaults = parseLsColors(undefined)

describe('--color parsing', () => {
  it('means always when given alone, and takes the other spellings', () => {
    expect(parseLsArguments(['--color']).options.color).toBe('always')
    expect(parseLsArguments(['--color=auto']).options.color).toBe('auto')
    expect(parseLsArguments(['--color=never']).options.color).toBe('never')
    expect(parseLsArguments(['--colour=yes']).options.color).toBe('always')
    expect(parseLsArguments([]).options.color).toBe('never')
    expect(parseLsArguments(['--color=sometimes']).error).toContain("invalid argument 'sometimes' for '--color'")
  })
})

describe('colorFor', () => {
  it('colors by type, permission bits and extension, and leaves a plain file alone', () => {
    expect(colorFor(entry({ name: 'd', mode: 0o040755 }), defaults)).toBe('01;34')
    expect(colorFor(entry({ name: 'l', mode: 0o120777 }), defaults)).toBe('01;36')
    expect(colorFor(entry({ name: 'x', mode: 0o100755 }), defaults)).toBe('01;32')
    expect(colorFor(entry({ name: 'a.tar', mode: 0o100644 }), defaults)).toBe('01;31')
    expect(colorFor(entry({ name: 'A.PNG', mode: 0o100644 }), defaults)).toBe('01;35')
    expect(colorFor(entry({ name: 'notes.txt' }), defaults)).toBeUndefined()
    expect(colorFor(entry({ name: 'tmp', mode: 0o041777 }), defaults)).toBe('30;42')
    expect(colorFor(entry({ name: 'su', mode: 0o104755 }), defaults)).toBe('37;41')
  })

  it('reads $LS_COLORS in place of the defaults', () => {
    const custom = parseLsColors('di=01;33:*.txt=04:bogus:ex=')
    expect(colorFor(entry({ name: 'd', mode: 0o040755 }), custom)).toBe('01;33')
    expect(colorFor(entry({ name: 'n.txt' }), custom)).toBe('04')
    expect(colorFor(entry({ name: 'x', mode: 0o100755 }), custom)).toBe('')
  })
})

describe('painted output', () => {
  it('pads columns by the plain width, not the escape codes', () => {
    const labels = ['aa', 'b', 'cc', 'd']
    const plain = columnLines(labels, 80)
    const painted = columnLines(labels, 80, label => paint(label, '01;34'))
    expect(painted.map(line => line.replace(/\x1b\[[0-9;]*m/g, ''))).toEqual(plain)
    expect(painted[0]).toContain('\x1b[01;34maa\x1b[0m')
  })

  it('colors only the name in a long listing, so the columns still line up', () => {
    const lines = longLines([entry({ name: 'a', mode: 0o040755 })], { users: new Map(), groups: new Map() },
      { human: false, inode: false, classify: false, slash: false, paint: (e, text) => paint(text, colorFor(e, defaults)) }, 0, false)
    expect(lines[0]).toMatch(/ \x1b\[01;34ma\x1b\[0m$/)
  })
})
