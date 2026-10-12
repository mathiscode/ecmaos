import { describe, expect, it } from 'vitest'

// The crontab parser shared by `crond.mjs` and `cron.mjs`.
import { parseCrontabFile, parseCrontabLine } from '../../../src/bin/commands/lib/crontab.mjs'

describe('parseCrontabLine', () => {
  it('parses a standard 5-field expression with a simple command', () => {
    expect(parseCrontabLine('* * * * * echo hi')).toEqual({ expression: '* * * * *', command: 'echo hi' })
  })

  it('parses a 5-field expression whose command is a single non-numeric word', () => {
    // `* * * * * echo hi` has 7 parts, the same as a 6-field (with seconds) expression plus a one-word command. The
    // 6-field reading is used only if `parseCronExpression` accepts that slice, so `echo` falls back to 5-field.
    expect(parseCrontabLine('* * * * * echo hi')).toEqual({ expression: '* * * * *', command: 'echo hi' })
  })

  it('prefers a real 6-field interpretation when the command word happens to also be valid there', () => {
    // '0 0 * * * 5' is an ambiguous 6-field-with-seconds vs 5-field-plus-numeric-argument
    // case (5 is a valid weekday value too) - nothing can disambiguate this from the text alone,
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
