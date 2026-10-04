import { describe, expect, it } from 'vitest'

import { parseStatements } from '../../src/lib/control-flow-parser.ts'
import { formatPrintf, quoteWord } from '../../src/lib/printf-format.ts'
import { decodeAnsiC, tokenize } from '../../src/lib/shell-parser.ts'
import { rewriteArithmeticCommands } from '../../src/lib/shell-core/interpreter.ts'
import { ShellState } from '../../src/lib/shell-core/state.ts'

const make = () => new ShellState({ pid: () => 1, ppid: () => 0 })

describe('(( )) as a command', () => {
  it('becomes let at a command position, and only there', () => {
    expect(rewriteArithmeticCommands('(( x = 3 + 4 ))')).toBe("let ' x = 3 + 4 '")
    expect(rewriteArithmeticCommands('true && (( x > 5 )) || echo no')).toBe("true && let ' x > 5 ' || echo no")
    expect(rewriteArithmeticCommands('echo $(( 1 + 2 )) "((x))" a=((1))')).toBe('echo $(( 1 + 2 )) "((x))" a=((1))')
    expect(rewriteArithmeticCommands('echo hi; ((i++))')).toBe("echo hi; let 'i++'")
  })

  it('leaves a subshell in a subshell alone', () => {
    expect(rewriteArithmeticCommands('( (echo a) )')).toBe('( (echo a) )')
    expect(rewriteArithmeticCommands('((echo a); echo b)')).toBe('((echo a); echo b)')
  })

  it('quotes an expression with a single quote in it', () => {
    expect(rewriteArithmeticCommands("(( a == 'x' ))")).toBe("let ' a == '\\''x'\\'' '")
  })
})

describe('$\'...\' quoting', () => {
  it('decodes the usual escapes', () => {
    expect(decodeAnsiC('a\\tb\\n')).toBe('a\tb\n')
    expect(decodeAnsiC('\\x41\\101\\u00e9\\e')).toBe('AAé\x1b')
    expect(decodeAnsiC("it\\'s \\\\ \\q")).toBe("it's \\ \\q")
  })

  it('is one single-quoted word', () => {
    const [token] = tokenize("$'a\\tb'")
    expect(token).toMatchObject({ kind: 'word', parts: [{ text: 'a\tb', quoting: 'single' }] })
  })
})

describe('printf formatting', () => {
  it('quotes a word so a shell reads it back', () => {
    expect(quoteWord('')).toBe("''")
    expect(quoteWord('plain-word_1.txt')).toBe('plain-word_1.txt')
    expect(quoteWord('a b')).toBe('a\\ b')
    expect(quoteWord("it's")).toBe("it\\'s")
    expect(quoteWord('a\tb')).toBe("$'a\\tb'")
  })

  it('applies %q like any other conversion, and reuses the format', () => {
    expect(formatPrintf('%q|%s\n', ['a b', 'x', 'c d', 'y'])).toBe('a\\ b|x\nc\\ d|y\n')
    expect(formatPrintf('%05d-%s', ['42', 'ab'])).toBe('00042-ab')
    expect(formatPrintf('[%3d]', ['7'])).toBe('[  7]')
  })

  it('turns \\0 into a NUL, with or without digits after it', () => {
    expect(formatPrintf('a\\0b', [])).toBe('a\0b')
    expect(formatPrintf('a\\0101b', [])).toBe('aAb')
    expect(formatPrintf('x\\0', [])).toBe('x\0')
  })
})

describe('case terminators', () => {
  const clauses = (script: string) => (parseStatements(script)[0] as { clauses: Array<{ patterns: string[], terminator?: string }> }).clauses

  it('reads ;; ;& and ;;& on their own lines and inline', () => {
    const found = clauses('case x in\n a) echo 1 ;;\n b) echo 2 ;&\n c) echo 3 ;;&\n d) echo 4\n ;;\nesac')
    expect(found.map(clause => clause.terminator)).toEqual([undefined, ';&', ';;&', undefined])
  })

  it('reads them in a one-line case too', () => {
    const found = clauses('case x in a) echo 1;& b) echo 2;;& *) echo 3;; esac')
    expect(found.map(clause => clause.terminator)).toEqual([';&', ';;&', undefined])
  })

  it('keeps an extended pattern whole', () => {
    const found = clauses('case x in\n a|@(b|c)) echo hi ;;\nesac')
    expect(found[0]?.patterns).toEqual(['a', '@(b|c)'])
  })
})

describe('variable scope in functions', () => {
  it('assigns the shell\'s own variable unless a frame declared the name', () => {
    const state = make()
    state.pushLocalScope()
    state.declareLocal('mine')
    state.set('mine', '1')
    state.set('shared', '2')
    expect(state.lookup('mine')).toBe('1')
    state.popLocalScope()
    expect(state.lookup('mine')).toBeUndefined()
    expect(state.lookup('shared')).toBe('2')
  })

  it('assigns through the nearest declaring frame in a nested call', () => {
    const state = make()
    state.set('x', 'global')
    state.pushLocalScope()
    state.declareLocal('x', 'outer')
    state.pushLocalScope()
    state.set('x', 'changed')
    state.popLocalScope()
    expect(state.lookup('x')).toBe('changed')
    state.popLocalScope()
    expect(state.lookup('x')).toBe('global')
  })
})

describe('namerefs', () => {
  it('reads and writes the variable a reference names', () => {
    const state = make()
    state.set('target', '1')
    state.declareNameref('ref', 'target')
    expect(state.lookup('ref')).toBe('1')
    state.set('ref', '2')
    expect(state.lookup('target')).toBe('2')
  })

  it('follows a chain, and works for arrays', () => {
    const state = make()
    state.setArray('arr', ['a', 'b'])
    state.declareNameref('one', 'arr')
    state.declareNameref('two', 'one')
    expect(state.lookupArray('two')?.get(1)).toBe('b')
    state.setArrayElement('two', 2, 'c')
    expect([...(state.lookupArray('arr') ?? [])].map(([, value]) => value)).toEqual(['a', 'b', 'c'])
  })

  it('re-points when declared again, and unsetReference leaves the target', () => {
    const state = make()
    state.set('a', 'A')
    state.set('b', 'B')
    state.declareNameref('ref', 'a')
    state.declareNameref('ref', 'b')
    expect(state.lookup('ref')).toBe('B')
    state.unsetReference('ref')
    expect(state.lookup('ref')).toBeUndefined()
    expect(state.lookup('b')).toBe('B')
  })
})
