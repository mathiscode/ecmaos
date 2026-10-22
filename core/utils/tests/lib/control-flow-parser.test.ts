import { describe, expect, it } from 'vitest'

import { parseRunnable, parseStatements } from '../../src/lib/control-flow-parser.ts'
import type { CaseStatement, ForStatement, FunctionDef, IfStatement, SimpleStatement, Statement, WhileStatement } from '../../src/lib/control-flow-parser.ts'

describe('parseStatements: C-style for', () => {
  it('parses the three arithmetic parts, inline and multi-line', () => {
    for (const text of ['for ((i=0; i<3; i++)); do echo $i; done', 'for (( i=0; i<3; i++ ))\ndo\n  echo $i\ndone']) {
      const [statement] = parseStatements(text)
      expect(statement).toMatchObject({ type: 'cfor', init: 'i=0', cond: 'i<3', step: 'i++' })
    }
  })

  it('allows empty parts and rejects a header without three', () => {
    expect(parseStatements('for ((;;)); do break; done')[0]).toMatchObject({ type: 'cfor', init: '', cond: '', step: '' })
    expect(() => parseStatements('for ((i=0; i<3)); do :; done')).toThrow(/Malformed for-loop header/)
  })
})

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

  it('splits a `;`-joined one-line body into one statement per command', () => {
    const stmt = parseStatements('greet() { echo one; echo two; }')[0] as FunctionDef
    expect(stmt.body).toEqual([
      expect.objectContaining({ type: 'simple', line: 'echo one' }),
      expect.objectContaining({ type: 'simple', line: 'echo two' }),
    ])
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

  describe('a closing keyword followed by more on the same line', () => {
    it('recognizes `done; more` as a closed loop', () => {
      // `fi`/`done`/`esac` used to be treated like `if`/`while`: start a new line and keep
      // accumulating. That left `done; shift 1` as one line whose first word was `done;`, so the
      // block was never seen as closed. A one-line function body makes this routine.
      const statements = parseStatements('while false; do echo x; done; echo after')
      expect(statements.map(s => s.type)).toEqual(['while', 'simple'])
      expect((statements[1] as SimpleStatement).line).toBe('echo after')
    })

    it('recognizes `fi; more`', () => {
      const statements = parseStatements('if true; then echo y; fi; echo after')
      expect(statements.map(s => s.type)).toEqual(['if', 'simple'])
    })

    it('keeps a redirection attached to the closing keyword', () => {
      const stmt = parseStatements('while read -r l; do echo $l; done < in.txt; echo after')[0] as WhileStatement
      expect(stmt.redirect).toBe('< in.txt')
    })

    it('parses a one-line function whose body closes a loop and continues', () => {
      const stmt = parseStatements('p() { while false; do echo x; done; echo tail; }')[0] as FunctionDef
      expect(stmt.type).toBe('function')
      expect(stmt.body.map(s => s.type)).toEqual(['while', 'simple'])
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

  describe('then/do followed by a command on its own line', () => {
    // Found by the browser pass for the line editor: typing `for i in 1 2`, then `do echo $i`, then
    // `done` ran nothing and reported nothing. The parser consumed the whole `do echo $i` line as if
    // it were a bare `do`, so the loop's first command vanished; `if`/`while` refused it outright.
    it('keeps the command after `do` in a for loop', () => {
      const [loop] = parseStatements('for i in 1 2\ndo echo n$i\ndone\n') as Array<{ body: Array<{ line: string }> }>
      expect(loop?.body.map(s => s.line)).toEqual(['echo n$i'])
    })

    it('keeps it in a while loop', () => {
      const [loop] = parseStatements('while true\ndo echo x\ndone\n') as Array<{ body: Array<{ line: string }> }>
      expect(loop?.body.map(s => s.line)).toEqual(['echo x'])
    })

    it('keeps the command after `then` in an if', () => {
      const [branch] = parseStatements('if true\nthen echo yes\nfi\n') as Array<{ branches: Array<{ body: Array<{ line: string }> }> }>
      expect(branch?.branches[0]?.body.map(s => s.line)).toEqual(['echo yes'])
    })

    it('still accepts do alone on its line', () => {
      const [loop] = parseStatements('for i in 1 2\ndo\necho n$i\ndone\n') as Array<{ body: Array<{ line: string }> }>
      expect(loop?.body.map(s => s.line)).toEqual(['echo n$i'])
    })

    it('keeps the following body lines too', () => {
      const [loop] = parseStatements('for i in 1\ndo echo a\necho b\ndone\n') as Array<{ body: Array<{ line: string }> }>
      expect(loop?.body.map(s => s.line)).toEqual(['echo a', 'echo b'])
    })
  })

  it('throws on a malformed for-loop header', () => {
    expect(() => parseStatements('for x; do\necho hi\ndone')).toThrow()
  })
})

describe('brace groups', () => {
  it('parses a one-line group with its redirection', () => {
    const [group] = parseStatements('{ echo a; echo b; } > out')
    expect(group).toMatchObject({ type: 'group', redirect: '> out' })
    expect((group as { body: Array<{ line: string }> }).body.map(s => s.line)).toEqual(['echo a', 'echo b'])
  })

  it('parses a multi-line group and keeps a nested block whole', () => {
    const [group] = parseStatements('{\n  if true; then echo a; fi\n  echo b\n} 2> err')
    expect(group).toMatchObject({ type: 'group', redirect: '2> err' })
    expect((group as { body: Array<{ type: string }> }).body.map(s => s.type)).toEqual(['if', 'simple'])
  })

  it('does not mistake a brace expansion for a group', () => {
    expect(parseStatements('echo {a,b}')).toEqual([{ type: 'simple', line: 'echo {a,b}', lineNumber: 1 }])
  })
})

describe('subshells', () => {
  it('parses an inline subshell with a redirection', () => {
    const [statement] = parseStatements('(echo a; echo b) > out')
    expect(statement).toMatchObject({ type: 'subshell', redirect: '> out' })
    expect((statement as { body: Array<{ line: string }> }).body.map(s => s.line)).toEqual(['echo a', 'echo b'])
  })

  it('parses a multi-line subshell closed by a line of its own', () => {
    const [statement] = parseStatements('(\n  echo a\n  echo b\n) >> log')
    expect(statement).toMatchObject({ type: 'subshell', redirect: '>> log' })
    expect((statement as { body: unknown[] }).body).toHaveLength(2)
  })

  it('nests, and keeps $( ) and quoted parentheses inside', () => {
    const [statement] = parseStatements('(echo "a)" $(echo b); (echo c))')
    const body = (statement as { body: Array<{ type: string, line?: string }> }).body
    expect(body).toHaveLength(2)
    expect(body[0]?.line).toBe('echo "a)" $(echo b)')
    expect(body[1]?.type).toBe('subshell')
  })

  it('takes a statement after a closing parenthesis and a semicolon', () => {
    expect(parseStatements('(echo a); echo b').map(statement => statement.type)).toEqual(['subshell', 'simple'])
    expect(parseStatements('echo a; (echo b)').map(statement => statement.type)).toEqual(['simple', 'subshell'])
  })

  it('leaves (( )) arithmetic alone', () => {
    expect(parseStatements('((x = 1))')[0]?.type).toBe('simple')
  })

  it('a subshell followed by an operator starts a list', () => {
    expect(parseStatements('(echo a) && echo b')[0]?.type).toBe('andor')
  })
})

describe('one-line forms followed by more commands', () => {
  const types = (text: string) => parseStatements(text).map(statement => statement.type)

  it('a function definition then commands', () => {
    expect(types('f() { echo a; }; x=0; f; echo $x')).toEqual(['function', 'simple', 'simple', 'simple'])
    expect(types('function g { echo in-g $1; }; g x')).toEqual(['function', 'simple'])
    expect(types('X=1; h() { echo a; }; h')).toEqual(['simple', 'function', 'simple'])
  })

  it('control flow inside a one-line function body', () => {
    const [fn] = parseStatements('f() { if [ $1 -le 1 ]; then echo 1; else echo 2; fi; }; f 1') as [FunctionDef]
    expect(fn.body.map(statement => statement.type)).toEqual(['if'])
    const [loop] = parseStatements('f() { for a in "$@"; do echo "<$a>"; done; for a in "$*"; do echo "[$a]"; done; }; f x') as [FunctionDef]
    expect(loop.body.map(statement => statement.type)).toEqual(['for', 'for'])
    const [loopWhile] = parseStatements('f() { while getopts "ab:" o; do echo "$o"; done; echo "i=$OPTIND"; }; f -a') as [FunctionDef]
    expect(loopWhile.body.map(statement => statement.type)).toEqual(['while', 'simple'])
  })

  it('a one-line case', () => {
    const [statement] = parseStatements('case $1 in a|b) echo ab;; c*) echo c;; *) echo other;; esac') as [CaseStatement]
    expect(statement.type).toBe('case')
    expect(statement.clauses.map(clause => clause.patterns)).toEqual([['a', 'b'], ['c*'], ['*']])
    expect(parseStatements('f() { case $1 in a) echo a;; esac; }; f a').map(s => s.type)).toEqual(['function', 'simple'])
  })

  it('a group or subshell with a redirection, then more commands', () => {
    expect(types('{ echo a; echo b; } > out; cat out')).toEqual(['group', 'simple'])
    expect(types('{ echo out; echo err >&2; } 2> e; cat e')).toEqual(['group', 'simple'])
  })

  it('a ; inside a comment, a quote, or $( ) does not split', () => {
    expect(types('echo a # one; two')).toEqual(['simple'])
    expect(types('echo "a; b" \'c; d\'')).toEqual(['simple'])
    expect(types('x=$(echo a; echo b); echo $x')).toEqual(['simple', 'simple'])
  })
})

describe('a stray semicolon after a block opener', () => {
  it('runs `do;`, `then;` and `else;` as if the semicolon were not there', () => {
    const [loop] = parseStatements('for i in 1 2; do; echo n$i; done') as [ForStatement]
    expect(loop.body.map(statement => statement.type)).toEqual(['simple'])
    expect((loop.body[0] as SimpleStatement).line).toBe('echo n$i')
    const [branch] = parseStatements('if true; then; echo a; else; echo b; fi') as [IfStatement]
    expect((branch.branches[0]?.body[0] as SimpleStatement).line).toBe('echo a')
    expect((branch.elseBody?.[0] as SimpleStatement).line).toBe('echo b')
  })
})

describe('parseStatements: pipelines with compound stages', () => {
  const kinds = (script: string) => {
    const [statement] = parseStatements(script)
    return statement?.type === 'pipeline' ? statement.stages.map(stage => stage.type) : [statement?.type]
  }

  it('reads a compound after a pipe, in one line and across lines', () => {
    expect(kinds("printf 'a\\n' | while read x; do echo $x; done")).toEqual(['simple', 'while'])
    expect(kinds('seq 3 |\nwhile read x\ndo\n  echo $x\ndone')).toEqual(['simple', 'while'])
    expect(kinds('echo hi | { cat; echo end; }')).toEqual(['simple', 'group'])
    expect(kinds('echo hi | (cat)')).toEqual(['simple', 'subshell'])
  })

  it('reads a compound before a pipe, and chains of them', () => {
    expect(kinds('for i in 1 2; do echo $i; done | sort -r')).toEqual(['for', 'simple'])
    expect(kinds('{ echo a; } | cat | wc -l')).toEqual(['group', 'simple'])
    expect(kinds('{ echo a; } | { cat; }')).toEqual(['group', 'group'])
    expect(kinds('(echo a) | while read x; do echo $x; done | tr a b')).toEqual(['subshell', 'while', 'simple'])
  })

  it('keeps a redirection that comes before the pipe on the compound', () => {
    const [statement] = parseStatements('while read l; do echo $l; done < f | cat')
    expect(statement).toMatchObject({ type: 'pipeline', stages: [{ type: 'while', redirect: '< f' }, { type: 'simple', line: 'cat' }] })
  })

  it('marks a trailing & as a background pipeline, and reads what follows it', () => {
    expect(parseStatements('(sleep 1; echo x) &')[0]).toMatchObject({ type: 'pipeline', background: true })
    const followed = parseStatements('(sleep 1) & wait')
    expect(followed.map(statement => statement.type)).toEqual(['pipeline', 'simple'])
  })

  it('leaves a plain pipeline and a compound with a redirect alone', () => {
    expect(kinds('a | b | c')).toEqual(['simple'])
    expect(kinds('while read l; do echo $l; done < f')).toEqual(['while'])
    expect(kinds('echo a || echo b')).toEqual(['simple'])
  })

  it('an && inside a compound stage\'s body is the body\'s own, not a list operator', () => {
    expect(kinds('echo a | while read l; do true && if true; then echo $l; fi; done')).toEqual(['simple', 'while'])
  })

  it('a list after the last compound stage takes the whole pipeline as its first operand', () => {
    const [statement] = parseStatements('echo a | while read l; do echo $l; done && echo after')
    expect(statement?.type).toBe('andor')
    if (statement?.type !== 'andor') return
    expect(statement.first.type === 'pipeline' && statement.first.stages.map(stage => stage.type)).toEqual(['simple', 'while'])
    expect(statement.rest).toEqual([{ op: '&&', statement: { type: 'simple', line: 'echo after' } }])
  })
})

describe('parseStatements: lists with a pipeline operand that has a compound stage', () => {
  /** Each operand of the list as its type, and a pipeline's as its stages' types */
  const operands = (text: string) => {
    const [statement] = parseStatements(text)
    expect(statement?.type).toBe('andor')
    if (statement?.type !== 'andor') return []
    const describe = (s: Statement) => s.type === 'pipeline' ? s.stages.map(stage => stage.type).join('|') : s.type === 'simple' ? s.line : s.type
    return [describe(statement.first), ...statement.rest.map(r => `${r.op} ${describe(r.statement)}`)]
  }

  it('the pipeline after && or || is that operator\'s operand', () => {
    expect(operands('cd /tmp && printf a | while read l; do echo $l; done')).toEqual(['cd /tmp', '&& simple|while'])
    expect(operands('false || echo a | while read l; do echo $l; done')).toEqual(['false', '|| simple|while'])
    expect(operands('x && echo a | { cat; }')).toEqual(['x', '&& simple|group'])
  })

  it('the operators before it are the list\'s, and keep their left-to-right meaning', () => {
    expect(operands('a && b || c | while read l; do echo $l; done')).toEqual(['a && b', '|| simple|while'])
  })

  it('what follows the closing keyword continues the list', () => {
    expect(operands('x && echo a | while read l; do echo $l; done && echo after')).toEqual(['x', '&& simple|while', '&& echo after'])
  })

  it('an && inside the loop body stays in the body', () => {
    expect(operands('x && echo a | while read l; do true && echo $l; done')).toEqual(['x', '&& simple|while'])
  })

  it('works when the loop spans lines', () => {
    expect(operands('x && echo a | while read l\ndo\n  echo $l\ndone')).toEqual(['x', '&& simple|while'])
  })
})

describe('parseStatements: lists with a compound operand', () => {
  const shape = (text: string) => JSON.stringify(parseStatements(text), (key, value) => key === 'lineNumber' ? undefined : value)

  it('a compound command after && is its own operand', () => {
    const [statement] = parseStatements('true && for i in 1 2; do echo $i; done')
    expect(statement?.type).toBe('andor')
    if (statement?.type !== 'andor') return
    expect(statement.first).toEqual({ type: 'simple', line: 'true' })
    expect(statement.rest.map(r => [r.op, r.statement.type])).toEqual([['&&', 'for']])
  })

  it('a list after a closing keyword continues from it', () => {
    const [statement] = parseStatements('if true; then echo a; fi && echo b || echo c')
    expect(statement?.type).toBe('andor')
    if (statement?.type !== 'andor') return
    expect(statement.first.type).toBe('if')
    expect(statement.rest.map(r => r.op)).toEqual(['&&', '||'])
  })

  it('a pipeline before && is the list\'s first operand, not part of the next stage', () => {
    const [statement] = parseStatements('for i in 3 1 2; do echo $i; done | sort && echo ok')
    expect(statement?.type).toBe('andor')
    if (statement?.type !== 'andor') return
    expect(statement.first.type).toBe('pipeline')
    if (statement.first.type !== 'pipeline') return
    expect(statement.first.stages.map(stage => stage.type)).toEqual(['for', 'simple'])
    expect(statement.rest).toEqual([{ op: '&&', statement: { type: 'simple', line: 'echo ok' } }])
  })

  it('a chain through a compound operand stays flat, so it keeps its left-to-right meaning', () => {
    const [statement] = parseStatements('false && { echo no; } || echo fallback')
    expect(statement?.type).toBe('andor')
    if (statement?.type !== 'andor') return
    expect(statement.rest.map(r => [r.op, r.statement.type])).toEqual([['&&', 'group'], ['||', 'simple']])
  })

  it('works across lines', () => {
    expect(shape('if true\nthen\n  echo y\nfi && echo z')).toContain('"type":"andor"')
  })

  it('a plain list is still one simple line', () => {
    expect(parseStatements('a && b || c')).toEqual([{ type: 'simple', line: 'a && b || c', lineNumber: 1 }])
  })
})

describe('parseStatements: quoted strings over several lines', () => {
  it('keeps a multi-line string in one line, newlines intact', () => {
    expect(parseStatements("echo 'a\nb'")).toEqual([{ type: 'simple', line: "echo 'a\nb'", lineNumber: 1 }])
    expect(parseStatements('echo "a\n# b\nc"; echo d')).toEqual([
      { type: 'simple', line: 'echo "a\n# b\nc"', lineNumber: 1 },
      { type: 'simple', line: 'echo d', lineNumber: 1 }
    ])
  })
  it('reads a string inside a function, a loop and a brace group', () => {
    const [fn] = parseStatements('f() { echo "p\nq"; }') as FunctionDef[]
    expect(fn).toMatchObject({ type: 'function', name: 'f' })
    const [loop] = parseStatements('for i in 1; do echo "x\ny"; done') as ForStatement[]
    expect((loop.body[0] as SimpleStatement).line).toBe('echo "x\ny"')
  })
  it('does not open a string for a quote inside a comment', () => {
    expect(parseStatements("echo one # it's\necho two").map(s => (s as SimpleStatement).line)).toEqual(["echo one # it's", 'echo two'])
  })
})

describe('parseStatements: syntax errors bash reports', () => {
  it('refuses a reserved word where a command starts', () => {
    for (const word of ['fi', 'done', 'then', 'else', 'elif', 'do', 'esac', '}']) {
      expect(() => parseStatements(word)).toThrow(`syntax error near unexpected token \`${word}'`)
    }
    expect(() => parseStatements('echo a; fi')).toThrow("syntax error near unexpected token `fi'")
    expect(() => parseStatements('if true; then echo; done; fi')).toThrow("syntax error near unexpected token `done'")
  })
  it('keeps a reserved word that is an argument, or follows an assignment', () => {
    expect(parseStatements('echo done fi }').map(s => s.type)).toEqual(['simple'])
    expect(parseStatements('x=1 fi').map(s => s.type)).toEqual(['simple'])
  })
  it('refuses a word after a compound command closes', () => {
    expect(() => parseStatements('(echo a) b')).toThrow("syntax error near unexpected token `b'")
    expect(() => parseStatements('{ echo a; } b')).toThrow("syntax error near unexpected token `b'")
    expect(() => parseStatements('while false; do :; done extra')).toThrow("syntax error near unexpected token `extra'")
    expect(() => parseStatements('if true; then :; fi fi')).toThrow("syntax error near unexpected token `fi'")
  })
  it('lets a closing word follow a subshell or group without a separator', () => {
    const [ifStatement] = parseStatements('if true; then (echo a) fi') as IfStatement[]
    expect(ifStatement?.branches[0]?.body.map(s => s.type)).toEqual(['subshell'])
    const [forStatement] = parseStatements('for i in 1; do (echo a) done') as ForStatement[]
    expect(forStatement?.body.map(s => s.type)).toEqual(['subshell'])
    expect(parseStatements('{ (echo a) }').map(s => s.type)).toEqual(['group'])
    expect(parseStatements('if true; then { echo a; } fi').map(s => s.type)).toEqual(['if'])
  })
  it('keeps redirections and operators after a closing keyword', () => {
    expect(parseStatements('(echo a) > /tmp/x; echo b').map(s => s.type)).toEqual(['subshell', 'simple'])
    expect(parseStatements('while read l; do echo $l; done < f | sort && echo ok').map(s => s.type)).toEqual(['andor'])
    expect(parseStatements('{ echo a; } 2>&1 | cat').map(s => s.type)).toEqual(['pipeline'])
  })
})

describe('parseStatements: a redirection on a function definition', () => {
  it('wraps the body in a group that carries it, so every call makes it', () => {
    for (const text of ['f() { echo a; } > /tmp/x', 'function f { echo a; } > /tmp/x', 'f() {\n  echo a\n} > /tmp/x']) {
      const [fn] = parseStatements(text) as FunctionDef[]
      expect(fn).toMatchObject({ type: 'function', name: 'f', body: [{ type: 'group', redirect: '> /tmp/x', body: [{ type: 'simple', line: 'echo a' }] }] })
    }
  })
  it('keeps a body with no redirection as it is, and refuses a word after the brace', () => {
    expect(parseStatements('f() { echo a; }')).toMatchObject([{ type: 'function', body: [{ type: 'simple', line: 'echo a' }] }])
    expect(() => parseStatements('f() { echo a; } b')).toThrow("syntax error near unexpected token `b'")
  })
})

describe('parseRunnable: what bash has run when it finds a syntax error', () => {
  it('gives the statements on lines before the failing one', () => {
    const { statements, failure } = parseRunnable('echo one\necho two\nfi\necho three')
    expect(statements.map(s => (s as SimpleStatement).line)).toEqual(['echo one', 'echo two'])
    expect(failure?.message).toBe("syntax error near unexpected token `fi'")
  })
  it('gives none from the failing line itself, and keeps a block that closed before it', () => {
    expect(parseRunnable('echo one; fi').statements).toEqual([])
    expect(parseRunnable('if true; then\n  echo a\nfi\ndone').statements.map(s => s.type)).toEqual(['if'])
  })
  it('stops before a block the script ends inside', () => {
    const { statements, failure } = parseRunnable('echo one\nif true; then\necho two')
    expect(statements.map(s => s.type)).toEqual(['simple'])
    expect(failure?.incomplete).toBe(true)
  })
})

describe('parseStatements: line continuations', () => {
  it('joins a line ending in an unquoted backslash to the next, with neither left', () => {
    expect(parseStatements('echo a \\\nb')).toMatchObject([{ type: 'simple', line: 'echo a b' }])
    expect(parseStatements('echo x \\\n\\\n#);')).toMatchObject([{ type: 'simple', line: 'echo x #);' }])
    expect(parseStatements('if true; then echo a \\\n  b; fi')).toMatchObject([{ type: 'if', branches: [{ body: [{ line: 'echo a   b' }] }] }])
  })

  it('leaves a backslash in quotes, in a comment and an escaped one as they are', () => {
    expect(parseStatements("echo 'a\\\nb'")).toMatchObject([{ line: "echo 'a\\\nb'" }])
    expect(parseStatements('echo a # c \\\necho b').map(s => (s as SimpleStatement).line)).toEqual(['echo a # c \\', 'echo b'])
    expect(parseStatements('echo a\\\\\necho b').map(s => (s as SimpleStatement).line)).toEqual(['echo a\\\\', 'echo b'])
  })

  it('reads a "..." whose ${...} has quotes of its own as one string', () => {
    expect(parseStatements('echo "${X-"a;b"}"; echo c').map(s => (s as SimpleStatement).line)).toEqual(['echo "${X-"a;b"}"', 'echo c'])
  })
})
