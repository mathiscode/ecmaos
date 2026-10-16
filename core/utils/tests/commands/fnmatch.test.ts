import { describe, expect, it } from 'vitest'

// @ts-expect-error plain JS module
import { fnmatch } from '../../src/commands-execve/lib/fnmatch.mjs'

describe('fnmatch', () => {
  it('matches * and ? including across / and a leading dot', () => {
    expect(fnmatch('*.txt', 'a.txt')).toBe(true)
    expect(fnmatch('*.txt', '.hidden.txt')).toBe(true)
    expect(fnmatch('a*c', 'abbbc')).toBe(true)
    expect(fnmatch('a?c', 'abc')).toBe(true)
    expect(fnmatch('a?c', 'ac')).toBe(false)
    expect(fnmatch('./*', './a/b')).toBe(true)
    expect(fnmatch('*', '')).toBe(true)
  })
  it('does not treat regex metacharacters specially', () => {
    expect(fnmatch('a.b', 'axb')).toBe(false)
    expect(fnmatch('a+b', 'a+b')).toBe(true)
    expect(fnmatch('(x)', '(x)')).toBe(true)
  })
  it('handles brackets, ranges, negation and classes', () => {
    expect(fnmatch('[abc]x', 'bx')).toBe(true)
    expect(fnmatch('[a-c]x', 'dx')).toBe(false)
    expect(fnmatch('[!a-c]x', 'dx')).toBe(true)
    expect(fnmatch('[^a]x', 'ax')).toBe(false)
    expect(fnmatch('[[:digit:]]*', '9lives')).toBe(true)
    expect(fnmatch('[]]', ']')).toBe(true)
    expect(fnmatch('[', '[')).toBe(true)
  })
  it('quotes with a backslash', () => {
    expect(fnmatch('a\\*', 'a*')).toBe(true)
    expect(fnmatch('a\\*', 'ab')).toBe(false)
  })
  it('can ignore case', () => {
    expect(fnmatch('*.TXT', 'a.txt', { caseFold: true })).toBe(true)
    expect(fnmatch('[A-Z]x', 'bx', { caseFold: true })).toBe(true)
    expect(fnmatch('*.TXT', 'a.txt')).toBe(false)
  })
})
