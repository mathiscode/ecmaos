import { describe, expect, it } from 'vitest'

import { parseStatements } from '#lib/control-flow-parser.ts'
import type { CaseStatement, ForStatement, FunctionDef, IfStatement, WhileStatement } from '#lib/control-flow-parser.ts'

describe('parseStatements', () => {
  it('parses plain lines as simple statements, skipping blanks and comments', () => {
    const statements = parseStatements('echo one\n\n# a comment\necho two')
    expect(statements).toEqual([
      expect.objectContaining({ type: 'simple', line: 'echo one' }),
      expect.objectContaining({ type: 'simple', line: 'echo two' })
    ])
  })

  it('parses an if/then/fi with the condition on the if line', () => {
    const statements = parseStatements('if true; then\n  echo yes\nfi')
    expect(statements).toHaveLength(1)
    const stmt = statements[0] as IfStatement
    expect(stmt.type).toBe('if')
    expect(stmt.branches).toHaveLength(1)
    expect(stmt.branches[0]?.condition).toBe('true')
    expect(stmt.branches[0]?.body).toEqual([expect.objectContaining({ type: 'simple', line: 'echo yes' })])
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
    expect(stmt.branches[1]?.body).toEqual([expect.objectContaining({ type: 'simple', line: 'echo b' })])
    expect(stmt.elseBody).toEqual([expect.objectContaining({ type: 'simple', line: 'echo c' })])
  })

  it('parses while/do/done', () => {
    const stmt = parseStatements('while test $i -lt 3; do\n  echo $i\ndone')[0] as WhileStatement
    expect(stmt.type).toBe('while')
    expect(stmt.condition).toBe('test $i -lt 3')
    expect(stmt.body).toEqual([expect.objectContaining({ type: 'simple', line: 'echo $i' })])
  })

  it('parses for/in/do/done with quoted and unquoted words', () => {
    const stmt = parseStatements('for f in a "b c" d; do\n  echo $f\ndone')[0] as ForStatement
    expect(stmt.type).toBe('for')
    expect(stmt.variable).toBe('f')
    // Kept verbatim: quoting is the expander's to interpret, not the statement parser's.
    expect(stmt.wordsText).toBe('a "b c" d')
    expect(stmt.body).toEqual([expect.objectContaining({ type: 'simple', line: 'echo $f' })])
  })

  it('parses for/in/do on the same line as the header', () => {
    const stmt = parseStatements('for i in 1 2 3; do\necho $i\ndone')[0] as ForStatement
    expect(stmt.wordsText).toBe('1 2 3')
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
    expect(stmt.clauses[0]?.body).toEqual([expect.objectContaining({ type: 'simple', line: 'echo ab' })])
    expect(stmt.clauses[1]?.patterns).toEqual(['*'])
  })

  it('parses case clauses with an inline ;; on the body line', () => {
    const script = ['case $x in', '  a) echo hi ;;', 'esac'].join('\n')
    const stmt = parseStatements(script)[0] as CaseStatement
    expect(stmt.clauses[0]?.body).toEqual([expect.objectContaining({ type: 'simple', line: 'echo hi' })])
  })

  it('parses a function defined with name() { }', () => {
    const stmt = parseStatements('greet() {\n  echo hi\n}')[0] as FunctionDef
    expect(stmt.type).toBe('function')
    expect(stmt.name).toBe('greet')
    expect(stmt.body).toEqual([expect.objectContaining({ type: 'simple', line: 'echo hi' })])
  })

  it('parses a function defined with the function keyword', () => {
    const stmt = parseStatements('function greet {\n  echo hi\n}')[0] as FunctionDef
    expect(stmt.type).toBe('function')
    expect(stmt.name).toBe('greet')
  })

  it('parses a whole function definition on one line', () => {
    // The form every rc file uses. It matched nothing before, fell through as a `simple` statement,
    // and the shell went looking for a command literally named `greet()`.
    const stmt = parseStatements('greet() { echo hi; }')[0] as FunctionDef
    expect(stmt.type).toBe('function')
    expect(stmt.name).toBe('greet')
    expect(stmt.body).toEqual([expect.objectContaining({ type: 'simple', line: 'echo hi' })])
  })

  it('keeps a `;`-joined one-line body as one simple statement', () => {
    // This parser only splits `;` where a control-flow keyword follows it; a plain `;` list is one
    // statement, which `Shell.executeSimple` then walks stage by stage. So the body stays whole here
    // and both commands still run -- see the runtime coverage in shell-control-flow-builtins.
    const stmt = parseStatements('greet() { echo one; echo two; }')[0] as FunctionDef
    expect(stmt.body).toEqual([expect.objectContaining({ type: 'simple', line: 'echo one; echo two' })])
  })

  it('keeps a nested block inside a one-line body', () => {
    // The body group is greedy, so the `}` it matches is the last one on the line, not the `fi`'s
    // neighbour.
    const stmt = parseStatements('check() { if test -d /tmp; then echo yes; fi; }')[0] as FunctionDef
    expect(stmt.type).toBe('function')
    expect(stmt.body).toHaveLength(1)
    expect(stmt.body[0]?.type).toBe('if')
  })

  it('parses a one-line definition in the function-keyword form', () => {
    const stmt = parseStatements('function greet { echo hi; }')[0] as FunctionDef
    expect(stmt.type).toBe('function')
    expect(stmt.name).toBe('greet')
    expect(stmt.body).toEqual([expect.objectContaining({ type: 'simple', line: 'echo hi' })])
  })

  it('parses a function whose body starts on the header line and closes later', () => {
    // `greet() { echo hi` matched nothing before, so at a prompt it read as a complete plain command
    // and ran immediately rather than asking for the closing brace.
    const stmt = parseStatements('greet() { echo hi\n}')[0] as FunctionDef
    expect(stmt.type).toBe('function')
    expect(stmt.name).toBe('greet')
    expect(stmt.body).toEqual([expect.objectContaining({ type: 'simple', line: 'echo hi' })])
  })

  it('parses a nested block opened on the header line', () => {
    const stmt = parseStatements('check() { if true; then\necho yes\nfi\n}')[0] as FunctionDef
    expect(stmt.type).toBe('function')
    expect(stmt.body).toHaveLength(1)
    expect(stmt.body[0]?.type).toBe('if')
  })

  describe('statement line numbers, for $LINENO', () => {
    it('counts blank lines and comments, so numbers match an editor', () => {
      const statements = parseStatements(['echo one', '', '# a comment', 'echo two'].join('\n'))
      expect(statements.map(s => s.lineNumber)).toEqual([1, 4])
    })

    it('gives every statement of a compact line the line it was written on', () => {
      // `if x; then y; fi` normalizes into several parser lines; all of them are line 2.
      const statements = parseStatements(['echo first', 'if true; then echo yes; fi'].join('\n'))
      expect(statements.map(s => s.lineNumber)).toEqual([1, 2])
      expect((statements[1] as IfStatement).branches[0]?.body[0]?.lineNumber).toBe(2)
    })

    it('numbers a multi-line body by its own lines', () => {
      const stmt = parseStatements(['for i in 1 2; do', '  echo $i', '  echo done', 'done'].join('\n'))[0] as ForStatement
      expect(stmt.lineNumber).toBe(1)
      expect(stmt.body.map(s => s.lineNumber)).toEqual([2, 3])
    })

    it('is not shifted by a heredoc body', () => {
      // `foldHeredocs` collapses the body into its command's line, then pads the gap back so the
      // statement after it still reports where it actually is.
      const statements = parseStatements(['cat <<EOF', 'body line', 'more body', 'EOF', 'echo after'].join('\n'))
      expect(statements.map(s => s.lineNumber)).toEqual([1, 5])
    })

    it('gives a one-line function body the definition\u2019s line', () => {
      const stmt = parseStatements(['echo x', 'greet() { echo hi; }'].join('\n'))[1] as FunctionDef
      expect(stmt.lineNumber).toBe(2)
      expect(stmt.body[0]?.lineNumber).toBe(2)
    })
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
