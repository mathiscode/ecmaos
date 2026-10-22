import { describe, expect, it } from 'vitest'

import { tokenize } from '../../src/lib/shell-parser.ts'
import { expandWordFields, expandWordString } from '../../src/lib/word-expansion.ts'
import { evaluateArithmeticExpression } from '../../src/lib/expand-variables.ts'
import type { ExpansionContext } from '../../src/lib/word-expansion.ts'

/** Every expectation here was checked against bash 5.3. */
const make = (vars: Record<string, string>, arrays: Record<string, string[]> = {}, positional: string[] = []) => {
  const ctx: ExpansionContext = {
    lookup: name => (name === '0' ? 'prog' : vars[name]),
    lookupArray: name => (arrays[name] ? new Map(arrays[name].map((value, index) => [index, value])) : undefined),
    positional: () => positional,
    assign: (name, value) => { vars[name] = value },
    substitute: async command => command,
    glob: async () => [],
    home: () => '/h',
    nounset: false,
  }
  const word = (text: string) => (tokenize(text)[0] as { parts: Parameters<typeof expandWordString>[0] }).parts
  return {
    string: (text: string) => expandWordString(word(text), ctx),
    fields: (text: string) => expandWordFields(word(text), ctx),
  }
}

describe('parameter operators', () => {
  const shell = () => make({ x: 'abcdef', b: 'banana', h: 'Hello', y: 'x' }, { a: ['p', 'q', 'r'] }, ['one', 'two', 'three'])

  it('slices a string', async () => {
    const s = shell()
    expect(await s.string('${x:1:3}')).toBe('bcd')
    expect(await s.string('${x:2}')).toBe('cdef')
    expect(await s.string('${x: -2}')).toBe('ef')
    expect(await s.string('${x:1:-1}')).toBe('bcde')
  })

  it('slices an array and the positional parameters (which count from $1)', async () => {
    const s = shell()
    expect(await s.string('${a[@]:1}')).toBe('q r')
    expect(await s.string('${a[@]:0:2}')).toBe('p q')
    expect(await s.string('${@:2}')).toBe('two three')
    expect(await s.string('${*:1:1}')).toBe('one')
    expect(await s.fields('"${@:2}"')).toEqual(['two', 'three'])
  })

  it('trims a prefix or suffix, shortest and longest', async () => {
    const s = shell()
    expect(await s.string('${x#abc}')).toBe('def')
    expect(await s.string('${x%def}')).toBe('abc')
    expect(await s.string('${x##*c}')).toBe('def')
    expect(await s.string('${x%%d*}')).toBe('abc')
    expect(await s.string('${x#zzz}')).toBe('abcdef')
    expect(await s.string('${a[1]#q}')).toBe('')
  })

  it('trims the shortest or the longest match when several fit, from either end', async () => {
    const s = make({ v: 'a.b.c' })
    expect(await s.string('${v#*.}')).toBe('b.c')
    expect(await s.string('${v##*.}')).toBe('c')
    expect(await s.string('${v%.*}')).toBe('a.b')
    expect(await s.string('${v%%.*}')).toBe('a')
  })

  it('replaces the first match, all matches, or an anchored one', async () => {
    const s = shell()
    expect(await s.string('${b/a/X}')).toBe('bXnana')
    expect(await s.string('${b//a/X}')).toBe('bXnXnX')
    expect(await s.string('${b/#b/B}')).toBe('Banana')
    expect(await s.string('${b/%a/A}')).toBe('bananA')
    expect(await s.string('${b//a}')).toBe('bnn')
    expect(await s.string('${b/n*a/-}')).toBe('ba-')
  })

  it('changes case', async () => {
    const s = shell()
    expect(await s.string('${h^^}')).toBe('HELLO')
    expect(await s.string('${h,,}')).toBe('hello')
    expect(await s.string('${h^}')).toBe('Hello')
    expect(await s.string('${h,}')).toBe('hello')
    expect(await s.string('${a[@]^^}')).toBe('P Q R')
  })

  it('gives the indices of an array, and follows an indirection', async () => {
    const s = shell()
    expect(await s.string('${!a[@]}')).toBe('0 1 2')
    expect(await s.string('${!y}')).toBe('abcdef')
  })

  it('still reads :-, :+, := and := as defaults, not as a slice', async () => {
    const s = shell()
    expect(await s.string('${zz:-d}')).toBe('d')
    expect(await s.string('${x:+alt}')).toBe('alt')
    expect(await s.string('${zz:=set}')).toBe('set')
  })
})

describe('"$*" and IFS', () => {
  it('joins with the first character of IFS, a space when unset, nothing when empty', async () => {
    expect(await make({ IFS: ',' }, {}, ['a', 'b']).string('"$*"')).toBe('a,b')
    expect(await make({}, {}, ['a', 'b']).string('"$*"')).toBe('a b')
    expect(await make({ IFS: '' }, {}, ['a', 'b']).string('"$*"')).toBe('ab')
    expect(await make({ IFS: ',' }, {}, ['a', 'b']).string('"$@"')).toBe('a b')
  })
})

describe('arithmetic', () => {
  const run = (expression: string, vars: Record<string, string> = {}) => {
    const value = evaluateArithmeticExpression(expression, name => vars[name], (name, v) => { vars[name] = v })
    return { value, vars }
  }

  it('does exponent, shifts, bitwise, ternary, unary ~ and hex/octal', () => {
    expect(run('2**3').value).toBe(8)
    expect(run('2**3**2').value).toBe(512)
    expect(run('-2**2').value).toBe(4)
    expect(run('1<<4').value).toBe(16)
    expect(run('256>>4').value).toBe(16)
    expect(run('7&3|8').value).toBe(11)
    expect(run('6^3').value).toBe(5)
    expect(run('~0').value).toBe(-1)
    expect(run('5>3?10:20').value).toBe(10)
    expect(run('0x10+010').value).toBe(24)
    expect(run('(1+2)*3').value).toBe(9)
  })

  it('assigns, and increments before or after', () => {
    expect(run('x++', { x: '5' })).toEqual({ value: 5, vars: { x: '6' } })
    expect(run('++x', { x: '5' })).toEqual({ value: 6, vars: { x: '6' } })
    expect(run('x--', { x: '5' })).toEqual({ value: 5, vars: { x: '4' } })
    expect(run('x+=4', { x: '5' })).toEqual({ value: 9, vars: { x: '9' } })
    expect(run('x=y=3', {})).toEqual({ value: 3, vars: { x: '3', y: '3' } })
    expect(run('x<<=2', { x: '3' })).toEqual({ value: 12, vars: { x: '12' } })
  })

  it('still reports division by zero and a dangling token', () => {
    expect(() => run('1/0')).toThrow(/division by 0 \(error token is "0"\)/)
    expect(() => run('1 2')).toThrow(/unexpected token/)
  })

  it('takes base#digits, and nothing that is not a number, a name or an operator', () => {
    expect(run('16#ff').value).toBe(255)
    expect(run('2#101 + 64#_').value).toBe(68)
    expect(() => run('2#2')).toThrow(/value too great for base/)
    // expanded already: a dollar sign, a quote or a # left in the expression is an error, not dropped
    expect(() => run('$((1+1))')).toThrow(/invalid arithmetic operator \(error token is "\$\(\(1\+1\)\)"\)/)
    expect(() => run('"1"')).toThrow(/invalid arithmetic operator/)
    expect(() => run('1 + #x')).toThrow(/error token is "#x"/)
  })
})

/** The word of `${name-word}` and of the patterns, quoted as POSIX shells quote it (checked against bash 5.3 and dash). */
describe('parameter words', () => {
  const shell = () => make({ A: 'a', AB: 'ab', FOO: 'bar baz', NULL: '' })

  it('reads an unquoted expansion\'s word as a word: quotes and backslashes are removed, a bare { is a character', async () => {
    const s = shell()
    for (const [word, want] of [['${X-\\\'}', "'"], ['${X-\\}}', '}'], ['${X-{}', '{'], ['${X-\\{}', '{'], ['${X-\\$A}', '$A'],
      ["${X-'}'}", '}'], ["${X-'}\"'}", '}"'], ["${X-'$'A}", '$A'], ['${X-"\'"}', "'"], ['${X-"$"A}', '$A'], ["${X-${Y-\\'}}", "'"]]) {
      expect(await s.fields(word as string)).toEqual([want])
    }
    // the } in "$"{A} closes the expansion
    expect(await s.fields('${X-"$"{A}B}')).toEqual(['${AB}'])
  })

  it('splits what was unquoted in the word and keeps what was quoted together', async () => {
    const s = shell()
    expect(await s.fields('${X-a b}')).toEqual(['a', 'b'])
    expect(await s.fields('${X-"a b"}')).toEqual(['a b'])
    expect(await s.fields('${X-"$"(echo x)}')).toEqual(['$(echo', 'x)'])
    expect(await s.fields('${X-x }#${Y-y}')).toEqual(['x', '#y'])
    expect(await s.fields('${X-""}')).toEqual([''])
  })

  it('in double quotes, escapes only $ ` " \\ and }, keeps a single quote, and quotes a "..." inside again', async () => {
    const s = shell()
    for (const [word, want] of [['"${X-\\\'}"', "\\'"], ['"${X-\\"}"', '"'], ['"${X-\\}}"', '}'], ['"${X-\\{}"', '\\{'], ['"${X-{}"', '{'],
      ['"${X-\\$A}"', '$A'], ['"${X-"\'"}"', "'"], ["\"${X-${Y-\\'}}\"", "\\'"], ['"${X-"$"(echo x)}"', '$(echo x)'],
      ["\"${X-'\"'}\"}\"\"'$(echo bad)'\"'\"\\'", "''}'echo bad'\"\\"]]) {
      expect(await s.fields(word as string)).toEqual([want])
    }
  })

  it('reads a pattern\'s word unquoted even inside double quotes', async () => {
    const s = shell()
    expect(await s.fields("\"${AB%${X-'b'}}\"")).toEqual(['a'])
    expect(await s.fields("\"${AB%${X-'$(echo b)'}}\"")).toEqual(['ab'])
    expect(await s.fields('${AB#$A*}')).toEqual(['b'])
    expect(await s.fields("${AB%'*'}")).toEqual(['ab'])
  })
})
