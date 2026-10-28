import { describe, expect, it } from 'vitest'

// @ts-expect-error plain JS module
import { diff3, formatDefault, formatMerge } from '../../src/commands-execve/lib/diff3-core.mjs'
import corpus from './diff3-corpus.json'

const split = (text: string) => ({ lines: text === '' ? [] : text.replace(/\n$/, '').split('\n'), noNewline: false })

// each expected output was produced by GNU diff3 (3.12) on the same three files, named m, o and y
describe('diff3 against GNU', () => {
  corpus.forEach((c, i) => {
    const files = [split(c.mine), split(c.older), split(c.yours)]
    const blocks = diff3(files)
    const mergeBlocks = diff3(files, 1)
    const labels = ['m', 'o', 'y']

    it(`case ${i}: the default output`, () => expect(formatDefault(files, blocks)).toBe(c.default))
    it(`case ${i}: -m`, () => {
      const merged = formatMerge(files, mergeBlocks, { labels, showAll: true })
      expect(merged.text).toBe(c.merge)
      expect(merged.conflicts > 0 ? 1 : 0).toBe(c.mergeStatus)
    })
    it(`case ${i}: -m -E`, () => expect(formatMerge(files, mergeBlocks, { labels, showAll: false }).text).toBe(c.overlap))
  })

  it('marks a last line with no newline', () => {
    const files = [{ lines: ['a', 'b'], noNewline: true }, split('a\nc\n'), split('a\nd\n')]
    expect(formatDefault(files, diff3(files))).toBe('====\n1:2c\n  b\n\\ No newline at end of file\n2:2c\n  c\n3:2c\n  d\n')
  })
})
