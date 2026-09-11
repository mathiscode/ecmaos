import { describe, expect, it } from 'vitest'

import { evaluateArithmeticExpression, expandArithmetic, expandVariables, expandWord } from '#lib/expand-variables.ts'

describe('expandVariables', () => {
  const lookup = (name: string) => ({ FOO: 'bar', EMPTY: '', COUNT: '3', '?': '0', '1': 'first' }[name])

  it('expands $VAR', () => {
    expect(expandVariables('hello $FOO', lookup)).toBe('hello bar')
  })

  it('expands ${VAR}', () => {
    expect(expandVariables('hello ${FOO}!', lookup)).toBe('hello bar!')
  })

  it('substitutes empty string for an undefined variable', () => {
    expect(expandVariables('[$UNSET]', lookup)).toBe('[]')
  })

  it('expands ${VAR:-default} to the default when unset or empty', () => {
    expect(expandVariables('${UNSET:-fallback}', lookup)).toBe('fallback')
    expect(expandVariables('${EMPTY:-fallback}', lookup)).toBe('fallback')
    expect(expandVariables('${FOO:-fallback}', lookup)).toBe('bar')
  })

  it('expands ${VAR:+alt} to alt only when set and non-empty', () => {
    expect(expandVariables('${FOO:+yes}', lookup)).toBe('yes')
    expect(expandVariables('${EMPTY:+yes}', lookup)).toBe('')
    expect(expandVariables('${UNSET:+yes}', lookup)).toBe('')
  })

  it('expands special single-character parameters like $? and positional $1', () => {
    expect(expandVariables('exit code $?', lookup)).toBe('exit code 0')
    expect(expandVariables('arg: $1', lookup)).toBe('arg: first')
  })

  it('expands a single-digit positional parameter and leaves a trailing bare $ untouched', () => {
    // $5 is a real positional-parameter reference (like $1), so it expands even mid-word; a
    // bare trailing $ with nothing after it has no identifier to expand and passes through.
    expect(expandVariables('price: $5.00 $', lookup)).toBe('price: .00 $')
  })
})

describe('evaluateArithmeticExpression', () => {
  const lookup = (name: string) => ({ x: '5', y: '2' }[name])

  it('evaluates basic arithmetic', () => {
    expect(evaluateArithmeticExpression('1 + 2 * 3', lookup)).toBe(7)
    expect(evaluateArithmeticExpression('(1 + 2) * 3', lookup)).toBe(9)
    expect(evaluateArithmeticExpression('10 % 3', lookup)).toBe(1)
    expect(evaluateArithmeticExpression('7 / 2', lookup)).toBe(3)
  })

  it('resolves variables from the lookup', () => {
    expect(evaluateArithmeticExpression('x + y', lookup)).toBe(7)
    expect(evaluateArithmeticExpression('x * y - 1', lookup)).toBe(9)
  })

  it('treats an unset variable as 0', () => {
    expect(evaluateArithmeticExpression('z + 1', lookup)).toBe(1)
  })

  it('evaluates comparisons and boolean operators to 0/1', () => {
    expect(evaluateArithmeticExpression('x > y', lookup)).toBe(1)
    expect(evaluateArithmeticExpression('x < y', lookup)).toBe(0)
    expect(evaluateArithmeticExpression('x == 5 && y == 2', lookup)).toBe(1)
    expect(evaluateArithmeticExpression('x == 1 || y == 2', lookup)).toBe(1)
  })

  it('throws on division by zero', () => {
    expect(() => evaluateArithmeticExpression('1 / 0', lookup)).toThrow()
  })
})

describe('expandArithmetic', () => {
  const lookup = (name: string) => ({ x: '5' }[name])

  it('replaces $((expr)) with its evaluated result', () => {
    expect(expandArithmetic('total=$((x + 1))', lookup)).toBe('total=6')
  })

  it('leaves unrelated $( ) command substitution untouched', () => {
    expect(expandArithmetic('$(echo hi)', lookup)).toBe('$(echo hi)')
  })

  it('yields an empty replacement for an invalid expression rather than throwing', () => {
    expect(expandArithmetic('$((1 / 0))', lookup)).toBe('')
  })
})

describe('expandWord', () => {
  it('runs arithmetic before variable expansion', () => {
    const lookup = (name: string) => ({ x: '2' }[name])
    expect(expandWord('$((x * 3))', lookup)).toBe('6')
  })

  it('composes both kinds of expansion in one word', () => {
    const lookup = (name: string) => ({ x: '2', LABEL: 'count' }[name])
    expect(expandWord('$LABEL=$((x + 1))', lookup)).toBe('count=3')
  })
})
