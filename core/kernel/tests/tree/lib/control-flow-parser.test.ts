import { describe, expect, it } from 'vitest'

import { parseStatements } from '#lib/control-flow-parser.ts'
import type { CaseStatement, ForStatement, FunctionDef, IfStatement, WhileStatement } from '#lib/control-flow-parser.ts'

describe('parseStatements', () => {
  it('parses plain lines as simple statements, skipping blanks and comments', () => {
    const statements = parseStatements('echo one\n\n# a comment\necho two')
    expect(statements).toEqual([
      { type: 'simple', line: 'echo one' },
      { type: 'simple', line: 'echo two' }
    ])
  })

  it('parses an if/then/fi with the condition on the if line', () => {
    const statements = parseStatements('if true; then\n  echo yes\nfi')
    expect(statements).toHaveLength(1)
    const stmt = statements[0] as IfStatement
    expect(stmt.type).toBe('if')
    expect(stmt.branches).toHaveLength(1)
    expect(stmt.branches[0]?.condition).toBe('true')
    expect(stmt.branches[0]?.body).toEqual([{ type: 'simple', line: 'echo yes' }])
    expect(stmt.elseBody).toBeNull()
  })

  it('parses if/elif/else/fi with then on its own line', () => {
    const script = [
      'if false',
      'then',
      '  echo a',
      'elif true; then',
      '  echo b',
      'else',
      '  echo c',
      'fi'
    ].join('\n')

    const stmt = parseStatements(script)[0] as IfStatement
    expect(stmt.branches).toHaveLength(2)
    expect(stmt.branches[0]?.condition).toBe('false')
    expect(stmt.branches[1]?.condition).toBe('true')
    expect(stmt.branches[1]?.body).toEqual([{ type: 'simple', line: 'echo b' }])
    expect(stmt.elseBody).toEqual([{ type: 'simple', line: 'echo c' }])
  })

  it('parses while/do/done', () => {
    const stmt = parseStatements('while test $i -lt 3; do\n  echo $i\ndone')[0] as WhileStatement
    expect(stmt.type).toBe('while')
    expect(stmt.condition).toBe('test $i -lt 3')
    expect(stmt.body).toEqual([{ type: 'simple', line: 'echo $i' }])
  })

  it('parses for/in/do/done with quoted and unquoted words', () => {
    const stmt = parseStatements('for f in a "b c" d; do\n  echo $f\ndone')[0] as ForStatement
    expect(stmt.type).toBe('for')
    expect(stmt.variable).toBe('f')
    expect(stmt.words).toEqual(['a', 'b c', 'd'])
    expect(stmt.body).toEqual([{ type: 'simple', line: 'echo $f' }])
  })

  it('parses for/in/do on the same line as the header', () => {
    const stmt = parseStatements('for i in 1 2 3; do\necho $i\ndone')[0] as ForStatement
    expect(stmt.words).toEqual(['1', '2', '3'])
  })

  it('parses case/esac with multiple patterns per clause', () => {
    const script = [
      'case $x in',
      '  a|b)',
      '    echo ab',
      '    ;;',
      '  *)',
      '    echo other',
      '    ;;',
      'esac'
    ].join('\n')

    const stmt = parseStatements(script)[0] as CaseStatement
    expect(stmt.type).toBe('case')
    expect(stmt.word).toBe('$x')
    expect(stmt.clauses).toHaveLength(2)
    expect(stmt.clauses[0]?.patterns).toEqual(['a', 'b'])
    expect(stmt.clauses[0]?.body).toEqual([{ type: 'simple', line: 'echo ab' }])
    expect(stmt.clauses[1]?.patterns).toEqual(['*'])
  })

  it('parses case clauses with an inline ;; on the body line', () => {
    const script = ['case $x in', '  a) echo hi ;;', 'esac'].join('\n')
    const stmt = parseStatements(script)[0] as CaseStatement
    expect(stmt.clauses[0]?.body).toEqual([{ type: 'simple', line: 'echo hi' }])
  })

  it('parses a function defined with name() { }', () => {
    const stmt = parseStatements('greet() {\n  echo hi\n}')[0] as FunctionDef
    expect(stmt.type).toBe('function')
    expect(stmt.name).toBe('greet')
    expect(stmt.body).toEqual([{ type: 'simple', line: 'echo hi' }])
  })

  it('parses a function defined with the function keyword', () => {
    const stmt = parseStatements('function greet {\n  echo hi\n}')[0] as FunctionDef
    expect(stmt.type).toBe('function')
    expect(stmt.name).toBe('greet')
  })

  it('parses nested control flow', () => {
    const script = [
      'for i in 1 2; do',
      '  if test $i -eq 1; then',
      '    echo one',
      '  fi',
      'done'
    ].join('\n')

    const stmt = parseStatements(script)[0] as ForStatement
    expect(stmt.body).toHaveLength(1)
    expect((stmt.body[0] as IfStatement).type).toBe('if')
  })

  it('throws on an unterminated if block', () => {
    expect(() => parseStatements('if true; then\n  echo hi')).toThrow()
  })

  it('throws on a malformed for-loop header', () => {
    expect(() => parseStatements('for x; do\necho hi\ndone')).toThrow()
  })
})
