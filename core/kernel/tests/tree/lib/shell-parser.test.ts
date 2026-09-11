import { describe, expect, it } from 'vitest'

import { parseScript, tokenize } from '#lib/shell-parser.ts'
import type { Command, Pipeline } from '#lib/shell-parser.ts'

describe('shell-parser', () => {
  describe('tokenize', () => {
    it('splits on whitespace', () => {
      expect(tokenize('echo hello world').map(t => t.value)).toEqual(['echo', 'hello', 'world'])
    })

    it('does not split quoted whitespace into separate words', () => {
      expect(tokenize('echo "hello world"').map(t => t.value)).toEqual(['echo', 'hello world'])
      expect(tokenize("echo 'hello world'").map(t => t.value)).toEqual(['echo', 'hello world'])
    })

    it('does not treat a quoted operator character as an operator', () => {
      const tokens = tokenize('echo "a | b"')
      expect(tokens.map(t => ({ kind: t.kind, value: t.value }))).toEqual([
        { kind: 'word', value: 'echo' },
        { kind: 'word', value: 'a | b' }
      ])
    })

    it('does not treat a single-quoted operator character as an operator', () => {
      const tokens = tokenize("echo 'a > b'")
      expect(tokens.map(t => ({ kind: t.kind, value: t.value }))).toEqual([
        { kind: 'word', value: 'echo' },
        { kind: 'word', value: 'a > b' }
      ])
    })

    it('recognizes && and || as distinct two-character operators', () => {
      expect(tokenize('a && b').map(t => t.value)).toEqual(['a', '&&', 'b'])
      expect(tokenize('a || b').map(t => t.value)).toEqual(['a', '||', 'b'])
    })

    it('does not split && into two & operators', () => {
      const tokens = tokenize('a && b')
      expect(tokens.filter(t => t.kind === 'operator')).toHaveLength(1)
    })

    it('recognizes ; and | and & as single-character operators', () => {
      expect(tokenize('a ; b').map(t => t.value)).toEqual(['a', ';', 'b'])
      expect(tokenize('a | b').map(t => t.value)).toEqual(['a', '|', 'b'])
      expect(tokenize('a & b').map(t => t.value)).toEqual(['a', '&', 'b'])
    })

    it('recognizes redirection operators, longest-match first', () => {
      expect(tokenize('cmd > file').map(t => t.value)).toEqual(['cmd', '>', 'file'])
      expect(tokenize('cmd >> file').map(t => t.value)).toEqual(['cmd', '>>', 'file'])
      expect(tokenize('cmd < file').map(t => t.value)).toEqual(['cmd', '<', 'file'])
      expect(tokenize('cmd 2>&1').map(t => t.value)).toEqual(['cmd', '>&', '1'])
    })

    it('captures the fd prefix on a redirection token', () => {
      const tokens = tokenize('cmd 2> file')
      const redirect = tokens.find(t => t.kind === 'redirect')
      expect(redirect?.fd).toBe(2)
    })

    it('unescapes a backslash-escaped character', () => {
      expect(tokenize('echo a\\ b').map(t => t.value)).toEqual(['echo', 'a b'])
    })

    it('throws on an unterminated quote', () => {
      expect(() => tokenize('echo "unterminated')).toThrow()
      expect(() => tokenize("echo 'unterminated")).toThrow()
    })
  })

  describe('parseScript — sequencing operators', () => {
    it('parses a single command with no operator', () => {
      const script = parseScript('echo hi')
      expect(script.stages).toHaveLength(1)
      expect(script.stages[0]?.operator).toBeNull()
      expect(commandWords(script.stages[0]?.pipeline)).toEqual(['echo', 'hi'])
    })

    it('parses ; as a sequencing operator between two commands', () => {
      const script = parseScript('echo a ; echo b')
      expect(script.stages).toHaveLength(2)
      expect(script.stages[0]?.operator).toBe(';')
      expect(commandWords(script.stages[0]?.pipeline)).toEqual(['echo', 'a'])
      expect(commandWords(script.stages[1]?.pipeline)).toEqual(['echo', 'b'])
    })

    it('parses && as a distinct operator from ;', () => {
      const script = parseScript('echo a && echo b')
      expect(script.stages[0]?.operator).toBe('&&')
    })

    it('parses || — the defect the old split-chain could not express at all', () => {
      const script = parseScript('false || echo recovered')
      expect(script.stages).toHaveLength(2)
      expect(script.stages[0]?.operator).toBe('||')
      expect(commandWords(script.stages[0]?.pipeline)).toEqual(['false'])
      expect(commandWords(script.stages[1]?.pipeline)).toEqual(['echo', 'recovered'])
    })

    it('parses a mix of ;, &&, and || in one script, left to right', () => {
      const script = parseScript('a ; b && c || d')
      expect(script.stages.map(s => s.operator)).toEqual([';', '&&', '||', null])
    })

    it('parses & as a (currently unimplemented) background operator, distinct from &&', () => {
      const script = parseScript('sleep 10 &')
      expect(script.stages).toHaveLength(1)
      expect(script.stages[0]?.operator).toBe('&')
    })
  })

  describe('parseScript — quote-aware splitting', () => {
    it('does not split a pipeline on a | inside double quotes', () => {
      const script = parseScript('echo "a | b"')
      expect(script.stages).toHaveLength(1)
      expect(script.stages[0]?.pipeline.commands).toHaveLength(1)
      expect(commandWords(script.stages[0]?.pipeline)).toEqual(['echo', 'a | b'])
    })

    it('does not split a sequence on a ; inside double quotes', () => {
      const script = parseScript('echo "a ; b"')
      expect(script.stages).toHaveLength(1)
      expect(commandWords(script.stages[0]?.pipeline)).toEqual(['echo', 'a ; b'])
    })

    it('does not treat && inside quotes as an operator', () => {
      const script = parseScript('echo "a && b"')
      expect(script.stages).toHaveLength(1)
      expect(commandWords(script.stages[0]?.pipeline)).toEqual(['echo', 'a && b'])
    })

    it('does still split a real pipeline of two commands', () => {
      const script = parseScript('echo hi | rev')
      const pipeline = script.stages[0]?.pipeline as Pipeline
      expect(pipeline.commands).toHaveLength(2)
      expect(pipeline.commands[0]?.words).toEqual(['echo', 'hi'])
      expect(pipeline.commands[1]?.words).toEqual(['rev'])
    })

    it('parses a three-stage pipeline', () => {
      const script = parseScript('echo hi | tr a-z A-Z | rev')
      const pipeline = script.stages[0]?.pipeline as Pipeline
      expect(pipeline.commands).toHaveLength(3)
    })
  })

  describe('parseScript — quote tracking for glob eligibility', () => {
    it('marks an unquoted word as not quoted, so it remains glob-eligible', () => {
      const command = firstCommand(parseScript('echo *.txt'))
      expect(command.wordsQuoted).toEqual([false, false])
    })

    it('marks a fully quoted word as quoted, so a literal * does not glob', () => {
      const command = firstCommand(parseScript('echo "*.txt"'))
      expect(command.wordsQuoted).toEqual([false, true])
    })

    it('marks a single-quoted word as quoted', () => {
      const command = firstCommand(parseScript("echo '*.txt'"))
      expect(command.wordsQuoted).toEqual([false, true])
    })

    it('marks a backslash-escaped character as making the word not fully quoted', () => {
      const command = firstCommand(parseScript('echo \\*.txt'))
      expect(command.wordsQuoted).toEqual([false, false])
    })
  })

  describe('parseScript — redirection as tokens, not regex over the whole line', () => {
    it('parses a redirection that would corrupt a naive regex-strip if the target looked like an operator', () => {
      const script = parseScript('echo "a > b"')
      const command = firstCommand(script)
      expect(command.redirections).toHaveLength(0)
      expect(command.words).toEqual(['echo', 'a > b'])
    })

    it('parses > with an implicit fd of 1', () => {
      const command = firstCommand(parseScript('cmd > out.txt'))
      expect(command.redirections).toEqual([{ type: '>', fd: 1, target: 'out.txt' }])
    })

    it('parses >> as append', () => {
      const command = firstCommand(parseScript('cmd >> out.txt'))
      expect(command.redirections).toEqual([{ type: '>>', fd: 1, target: 'out.txt' }])
    })

    it('parses < with an implicit fd of 0', () => {
      const command = firstCommand(parseScript('cmd < in.txt'))
      expect(command.redirections).toEqual([{ type: '<', fd: 0, target: 'in.txt' }])
    })

    it('parses an explicit fd prefix, e.g. 2>', () => {
      const command = firstCommand(parseScript('cmd 2> err.txt'))
      expect(command.redirections).toEqual([{ type: '>', fd: 2, target: 'err.txt' }])
    })

    it('parses 2>&1 as a fd-to-fd duplication, not a file target', () => {
      const command = firstCommand(parseScript('cmd 2>&1'))
      expect(command.redirections).toEqual([{ type: '>&', fd: 2, target: '1', targetIsFd: true }])
    })

    it('preserves 2>&1 vs 1>&2 ordering relative to other redirections', () => {
      const a = firstCommand(parseScript('cmd 2>&1 > out.txt'))
      expect(a.redirections).toEqual([
        { type: '>&', fd: 2, target: '1', targetIsFd: true },
        { type: '>', fd: 1, target: 'out.txt' }
      ])

      const b = firstCommand(parseScript('cmd > out.txt 2>&1'))
      expect(b.redirections).toEqual([
        { type: '>', fd: 1, target: 'out.txt' },
        { type: '>&', fd: 2, target: '1', targetIsFd: true }
      ])
    })

    it('parses multiple redirections on one command', () => {
      const command = firstCommand(parseScript('cmd < in.txt > out.txt 2> err.txt'))
      expect(command.redirections).toEqual([
        { type: '<', fd: 0, target: 'in.txt' },
        { type: '>', fd: 1, target: 'out.txt' },
        { type: '>', fd: 2, target: 'err.txt' }
      ])
    })

    it('parses a heredoc operator', () => {
      const command = firstCommand(parseScript('cmd << EOF'))
      expect(command.redirections).toEqual([{ type: '<<', fd: 0, target: 'EOF' }])
    })

    it('parses a here-string operator', () => {
      const command = firstCommand(parseScript('cmd <<< hello'))
      expect(command.redirections).toEqual([{ type: '<<<', fd: 0, target: 'hello' }])
    })
  })

  describe('parseScript — error handling', () => {
    it('throws when a command is empty', () => {
      expect(() => parseScript(';')).toThrow()
    })

    it('throws when a redirection has no target', () => {
      expect(() => parseScript('cmd >')).toThrow()
    })

    it('throws when a pipeline segment is empty', () => {
      expect(() => parseScript('cmd | | cmd2')).toThrow()
    })
  })
})

function firstCommand(script: ReturnType<typeof parseScript>): Command {
  const pipeline = script.stages[0]?.pipeline as Pipeline
  return pipeline.commands[0] as Command
}

function commandWords(pipeline: Pipeline | undefined): string[] {
  return pipeline?.commands[0]?.words ?? []
}
