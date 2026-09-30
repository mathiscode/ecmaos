import { describe, expect, it } from 'vitest'

import { needsMoreInput } from '../../src/lib/control-flow-parser.ts'

/**
 * `needsMoreInput` is what the interactive prompt asks before deciding whether Enter runs a line or
 * asks for another one (`> `). Before it existed, `Terminal`'s Enter handler knew exactly one
 * continuation rule -- a trailing backslash -- so typing `cat <<EOF` or `for i in 1 2 3; do` at the
 * prompt ran that fragment immediately and then executed the following lines as separate commands
 * ("Command not found: for"). `pendingHeredocDelimiter` had been written for this and never called.
 *
 * The distinction these cover is prefix-vs-error: an unterminated construct is incomplete (more
 * input helps), while a genuine syntax error is not (no amount of typing fixes `fi` with no `if`,
 * so the prompt must report it rather than trapping the user in a continuation).
 */
describe('needsMoreInput', () => {
  describe('complete input runs immediately', () => {
    it.each([
      ['a plain command', 'echo hello'],
      ['a pipeline', 'cat /etc/passwd | wc -l'],
      ['a semicolon list', 'echo a; echo b'],
      ['a single-line for loop', 'for i in 1 2 3; do echo $i; done'],
      ['a single-line if', 'if [ -f /etc/passwd ]; then echo yes; fi'],
      ['a closed multi-line for loop', 'for i in 1 2 3\ndo\necho $i\ndone'],
      ['a closed multi-line if', 'if true\nthen\necho yes\nfi'],
      ['a closed heredoc', 'cat <<EOF\nbody\nEOF'],
      ['a here-string, which needs no terminator', 'tr a-z A-Z <<< hello'],
      // A whole function definition on one line is complete, so the prompt must run it rather than
      // ask for another line. Before it parsed, it read as a plain command and was also "complete" --
      // for the wrong reason, then failed as a command named `greet()`.
      ['a one-line function definition', 'greet() { echo hi; }'],
      ['a one-line function in the keyword form', 'function greet { echo hi; }'],
      ['a one-line function with a nested block', 'check() { if true; then echo yes; fi; }'],
      ['a one-line function with several commands', 'both() { echo one; echo two; }']
    ])('%s', (_label, input) => {
      expect(needsMoreInput(input)).toBe(false)
    })
  })

  describe('an unterminated construct asks for more', () => {
    it.each([
      ['an open heredoc', 'cat <<EOF'],
      ['an open heredoc with a partial body', 'cat <<EOF\nbody so far'],
      ['a tab-stripping heredoc', 'cat <<-EOF\n\tbody'],
      ['a for loop opened inline', 'for i in 1 2 3; do'],
      ['a for loop with do on its own line', 'for i in 1 2 3\ndo'],
      ['a for loop with a body but no done', 'for i in 1 2 3; do\necho $i'],
      ['an if opened inline', 'if true; then'],
      ['an if with a body but no fi', 'if true; then\necho yes'],
      ['an if in its else branch', 'if true; then\necho yes\nelse'],
      ['a while loop', 'while true; do\necho spin'],
      ['a function body', 'greet() {\necho hi'],
      // An opening brace with a body but no closing one is still a prefix, one-line form or not.
      ['a one-line function with no closing brace', 'greet() { echo hi'],
      ['a one-line function whose nested block is open', 'check() { if true; then']
    ])('%s', (_label, input) => {
      expect(needsMoreInput(input)).toBe(true)
    })
  })

  describe('a genuine syntax error is not a prefix', () => {
    it.each([
      ['a closing keyword with nothing open', 'fi'],
      ['a stray done', 'done'],
      ['a malformed for header', 'for ; do\necho x\ndone']
    ])('%s', (_label, input) => {
      expect(needsMoreInput(input)).toBe(false)
    })
  })

  it('treats empty and whitespace-only input as complete', () => {
    expect(needsMoreInput('')).toBe(false)
    expect(needsMoreInput('   \n  ')).toBe(false)
  })

  it('does not mistake a << inside a quoted string for a heredoc', () => {
    expect(needsMoreInput('echo "a << b"')).toBe(false)
  })
})

describe('needsMoreInput: brace groups', () => {
  it('asks for more while a group is open, and not once it closes', () => {
    expect(needsMoreInput('{ echo a')).toBe(true)
    expect(needsMoreInput('{ echo a; }')).toBe(false)
  })
})
