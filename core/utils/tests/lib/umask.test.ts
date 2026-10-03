import { describe, expect, it } from 'vitest'

import { formatUmask, formatUmaskSymbolic, parseUmask } from '../../src/lib/shell-core/umask.ts'

describe('parseUmask', () => {
  it('reads octal of one to four digits', () => {
    expect(parseUmask('022', 0)).toBe(0o022)
    expect(parseUmask('0077', 0)).toBe(0o077)
    expect(parseUmask('7', 0)).toBe(0o007)
  })

  it('refuses what is not a mask', () => {
    for (const text of ['', '8', '0o22', 'x', 'u=q', 'u', '=rwx,', '02222']) expect(parseUmask(text, 0o022), text).toBeUndefined()
  })

  it('reads symbolic modes as what stays allowed', () => {
    expect(parseUmask('u=rwx,g=rx,o=rx', 0)).toBe(0o022)
    expect(parseUmask('u=rwx,g=rx,o=', 0)).toBe(0o027)
    expect(parseUmask('a=rwx', 0o077)).toBe(0)
    expect(parseUmask('a=', 0)).toBe(0o777)
  })

  it('adds and removes from the current mask, and treats no class as all', () => {
    expect(parseUmask('g-w', 0)).toBe(0o020)
    expect(parseUmask('o+r', 0o077)).toBe(0o073)
    expect(parseUmask('-w', 0)).toBe(0o222)
    expect(parseUmask('u+w,go-w', 0o200)).toBe(0o022)
  })
})

describe('formatUmask', () => {
  it('prints four octal digits', () => {
    expect(formatUmask(0o22)).toBe('0022')
    expect(formatUmask(0)).toBe('0000')
    expect(formatUmask(0o777)).toBe('0777')
  })

  it('prints the symbolic form of what is allowed', () => {
    expect(formatUmaskSymbolic(0o022)).toBe('u=rwx,g=rx,o=rx')
    expect(formatUmaskSymbolic(0o077)).toBe('u=rwx,g=,o=')
    expect(formatUmaskSymbolic(0)).toBe('u=rwx,g=rwx,o=rwx')
  })

  it('round-trips through the parser', () => {
    for (const mask of [0, 0o022, 0o027, 0o077, 0o002, 0o777]) expect(parseUmask(formatUmaskSymbolic(mask), 0)).toBe(mask)
  })
})
