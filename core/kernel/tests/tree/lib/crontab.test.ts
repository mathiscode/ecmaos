import { describe, expect, it } from 'vitest'

// This is the worker-hosted `crond.mjs`/`cron.mjs` shared crontab parser now -- `#lib/crontab.ts`
// (the old main-thread-only copy `kernel.loadCrontab()` used) was retired along with that method
// once `crond` (a real daemon `Process`) replaced `kernel.intervals`'s whole cron half. Ported
// verbatim, so this file's own coverage (real parsing-ambiguity bug fixes included) carries over
// unchanged -- see `src/bin/commands/crond.mjs`'s doc comment for why this exists as a real daemon.
import { parseCrontabFile, parseCrontabLine } from '../../../src/bin/commands/lib/crontab.mjs'

describe('parseCrontabLine', () => {
  it('parses a standard 5-field expression with a simple command', () => {
    expect(parseCrontabLine('* * * * * echo hi')).toEqual({ expression: '* * * * *', command: 'echo hi' })
  })

  it('parses a 5-field expression whose command is a single non-numeric word', () => {
    // Real bug: '* * * * * echo hi' has 7 space-separated parts, the same count a genuine 6-field
    // (with seconds) expression plus a one-word command would have. The old code decided 6-field
    // vs 5-field from the *first* field's shape alone, which can't tell these apart -- both start
    // with a field that "looks like seconds". The fix only commits to the 6-field interpretation
    // once parseCronExpression actually accepts the 6-field slice, so 'echo' (not a valid 6th
    // field) correctly falls back to 5-field instead of being folded into a bogus expression.
    expect(parseCrontabLine('* * * * * echo hi')).toEqual({ expression: '* * * * *', command: 'echo hi' })
  })

  it('prefers a real 6-field interpretation when the command word happens to also be valid there', () => {
    // '0 0 * * * 5' is a genuinely ambiguous 6-field-with-seconds vs 5-field-plus-numeric-argument
    // case (5 is a valid weekday value too) -- nothing can disambiguate this from the text alone,
    // so the fix's rule (prefer 6-field whenever parseCronExpression accepts it) is the documented,
    // deterministic choice, not an attempt to guess intent.
    expect(parseCrontabLine('0 0 * * * 5 echo hi')).toEqual({ expression: '0 0 * * * 5', command: 'echo hi' })
  })

  it('parses a real 6-field expression with seconds', () => {
    expect(parseCrontabLine('*/5 * * * * * echo hi')).toEqual({ expression: '*/5 * * * * *', command: 'echo hi' })
  })

  it('returns null for a comment', () => {
    expect(parseCrontabLine('# a comment')).toBeNull()
  })

  it('returns null for a blank line', () => {
    expect(parseCrontabLine('   ')).toBeNull()
  })

  it('returns null for an invalid cron expression', () => {
    expect(parseCrontabLine('not a cron expression at all')).toBeNull()
  })
})

describe('parseCrontabFile', () => {
  it('parses multiple entries and records their 1-indexed line numbers', () => {
    const entries = parseCrontabFile([
      '# system crontab',
      '* * * * * echo one',
      '',
      '0 0 * * * echo two'
    ].join('\n'))

    expect(entries).toEqual([
      { expression: '* * * * *', command: 'echo one', lineNumber: 2 },
      { expression: '0 0 * * *', command: 'echo two', lineNumber: 4 }
    ])
  })

  it('skips comments and blank lines without affecting valid entries', () => {
    const entries = parseCrontabFile('\n# comment\n* * * * * echo hi\n')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.command).toBe('echo hi')
  })
})
