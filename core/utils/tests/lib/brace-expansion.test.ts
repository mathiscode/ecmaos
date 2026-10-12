import { describe, expect, it } from 'vitest'

import { expandBraces } from '../../src/lib/brace-expansion.ts'
import { tokenize } from '../../src/lib/shell-parser.ts'
import type { WordPart } from '../../src/lib/shell-parser.ts'

/**
 * Brace expansion, the shell's first expansion and the only purely textual one: `{a,b}` becomes two
 * words whether or not anything by those names exists, which is what separates it from globbing.
 *
 * Unit-level here because the interesting cases are all about what is *not* expanded - quoting,
 * `${...}`, and the several forms that are literal text in every real shell.
 */
describe('expandBraces', () => {
  /** Expands the first word of `line` and returns the resulting words as plain text. */
  const expand = (line: string): string[] => {
    const token = tokenize(line).find(t => t.kind === 'word')
    const parts = (token?.parts ?? []) as WordPart[]
    return expandBraces(parts).map(word => word.map(part => part.text).join(''))
  }

  describe('comma lists', () => {
    it('expands a simple list', () => {
      expect(expand('{a,b,c}')).toEqual(['a', 'b', 'c'])
    })

    it('keeps the prefix and suffix on every result', () => {
      expect(expand('pre{a,b}post')).toEqual(['preapost', 'prebpost'])
    })

    it('expands the everyday mkdir case', () => {
      expect(expand('src/{lib,bin}')).toEqual(['src/lib', 'src/bin'])
    })

    it('expands the everyday cp case', () => {
      expect(expand('notes.{txt,bak}')).toEqual(['notes.txt', 'notes.bak'])
    })

    it('keeps an empty alternative, which is how {,.bak} works', () => {
      expect(expand('f{,.bak}')).toEqual(['f', 'f.bak'])
    })

    it('multiplies two braces in one word', () => {
      expect(expand('{a,b}{1,2}')).toEqual(['a1', 'a2', 'b1', 'b2'])
    })

    it('expands nested braces', () => {
      expect(expand('{a,{b,c}}')).toEqual(['a', 'b', 'c'])
    })

    it('expands a nested brace inside a prefix', () => {
      expect(expand('{x{1,2},y}')).toEqual(['x1', 'x2', 'y'])
    })
  })

  describe('sequences', () => {
    it('counts up', () => {
      expect(expand('{1..5}')).toEqual(['1', '2', '3', '4', '5'])
    })

    it('counts down', () => {
      expect(expand('{3..1}')).toEqual(['3', '2', '1'])
    })

    it('honors a step', () => {
      expect(expand('{1..9..3}')).toEqual(['1', '4', '7'])
    })

    it('handles negative endpoints', () => {
      expect(expand('{-2..2}')).toEqual(['-2', '-1', '0', '1', '2'])
    })

    it('preserves zero padding, which is the reason to write it that way', () => {
      expect(expand('{08..11}')).toEqual(['08', '09', '10', '11'])
    })

    it('expands a character range', () => {
      expect(expand('{a..e}')).toEqual(['a', 'b', 'c', 'd', 'e'])
    })

    it('expands a descending character range', () => {
      expect(expand('{c..a}')).toEqual(['c', 'b', 'a'])
    })

    it('keeps a prefix and suffix around a sequence', () => {
      expect(expand('file{1..3}.txt')).toEqual(['file1.txt', 'file2.txt', 'file3.txt'])
    })
  })

  describe('what is deliberately left alone', () => {
    it('leaves a single-quoted brace as literal text', () => {
      expect(expand("'{a,b}'")).toEqual(['{a,b}'])
    })

    it('leaves a double-quoted brace as literal text', () => {
      expect(expand('"{a,b}"')).toEqual(['{a,b}'])
    })

    it('leaves a brace with no comma alone', () => {
      expect(expand('{foo}')).toEqual(['{foo}'])
    })

    it('leaves an empty brace alone', () => {
      expect(expand('{}')).toEqual(['{}'])
    })

    it('leaves an unmatched brace alone', () => {
      expect(expand('{a,b')).toEqual(['{a,b'])
    })

    it('never treats a parameter expansion as a brace', () => {
      // `${x:-a,b}` is one parameter expansion with a comma in its default, not two words.
      expect(expand('${x:-a,b}')).toEqual(['${x:-a,b}'])
    })

    it('expands around a parameter expansion without touching it', () => {
      expect(expand('${HOME}/{a,b}')).toEqual(['${HOME}/a', '${HOME}/b'])
    })

    it('leaves a malformed sequence alone', () => {
      expect(expand('{1..x}')).toEqual(['{1..x}'])
    })

    it('leaves a word with no brace untouched', () => {
      expect(expand('plain')).toEqual(['plain'])
    })

    it('refuses an unbounded sequence rather than generating it', () => {
      expect(expand('{1..999999}')).toEqual(['{1..999999}'])
    })
  })
})
