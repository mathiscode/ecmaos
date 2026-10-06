import { describe, expect, it } from 'vitest'

import { InputParser } from '../src/input.ts'
import type { InputToken } from '../src/input.ts'

const keys = (tokens: InputToken[]) => tokens.map(token => token.type === 'paste'
  ? `paste:${token.text}`
  : [token.input.domEvent.ctrlKey && 'C', token.input.domEvent.altKey && 'A', token.input.domEvent.shiftKey && 'S', token.input.domEvent.key].filter(Boolean).join('-'))
const parse = (text: string) => keys(new InputParser().feed(text))

describe('InputParser', () => {
  it('reads printable text, Enter, Tab and Backspace', () => {
    expect(parse('ab\r\t\x7f')).toEqual(['a', 'b', 'Enter', 'Tab', 'Backspace'])
  })

  it('reads control characters as Ctrl chords', () => {
    expect(parse('\x03\x04\x01')).toEqual(['C-c', 'C-d', 'C-a'])
  })

  it('reads arrows, Home, End and Delete in CSI and SS3 forms', () => {
    expect(parse('\x1b[A\x1b[B\x1b[C\x1b[D')).toEqual(['ArrowUp', 'ArrowDown', 'ArrowRight', 'ArrowLeft'])
    expect(parse('\x1bOA\x1bOH\x1bOF')).toEqual(['ArrowUp', 'Home', 'End'])
    expect(parse('\x1b[H\x1b[F\x1b[1~\x1b[4~\x1b[7~\x1b[8~\x1b[3~')).toEqual(['Home', 'End', 'Home', 'End', 'Home', 'End', 'Delete'])
  })

  it('reads modifier parameters', () => {
    expect(parse('\x1b[1;3D\x1b[1;5C\x1b[3;3~')).toEqual(['A-ArrowLeft', 'C-ArrowRight', 'A-Delete'])
    expect(parse('\x1b[Z')).toEqual(['S-Tab'])
  })

  it('reads ESC then a key as Alt', () => {
    expect(parse('\x1bb\x1bf\x1bd\x1b\x7f')).toEqual(['A-b', 'A-f', 'A-d', 'A-Backspace'])
  })

  it('reads astral characters as one key', () => {
    expect(parse('a\u{1f600}')).toEqual(['a', '\u{1f600}'])
  })

  it('drops sequences it does not use, whole', () => {
    expect(parse('\x1b[99~x\x1b[1;2Qy')).toEqual(['x', 'y'])
  })

  it('holds a split sequence until the rest arrives', () => {
    const parser = new InputParser()
    expect(keys(parser.feed('\x1b'))).toEqual([])
    expect(parser.pending).toBe(true)
    expect(keys(parser.feed('['))).toEqual([])
    expect(keys(parser.feed('A'))).toEqual(['ArrowUp'])
    expect(parser.pending).toBe(false)
  })

  it('reports a lone ESC as Escape on flush', () => {
    const parser = new InputParser()
    parser.feed('\x1b')
    expect(keys(parser.flush())).toEqual(['Escape'])
    expect(parser.pending).toBe(false)
  })

  it('collects a bracketed paste as one token, however it is split', () => {
    expect(parse('\x1b[200~echo "hi"\nnext\x1b[201~')).toEqual(['paste:echo "hi"\nnext'])
    const parser = new InputParser()
    const tokens = [...parser.feed('\x1b[20'), ...parser.feed('0~one '), ...parser.feed('two\x1b[20'), ...parser.feed('1~z')]
    expect(keys(tokens)).toEqual(['paste:one two', 'z'])
  })

  it('does not treat pasted escape sequences as keys', () => {
    expect(parse('\x1b[200~\x1b[A\x1b[201~')).toEqual(['paste:\x1b[A'])
  })
})
