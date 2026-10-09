import { describe, expect, it } from 'vitest'
import { SIGNAL_NUMBERS, UNCATCHABLE_SIGNALS, normalizeSignal, signalNameList, signalNameOf } from '../../../src/lib/shell-core/signal-table.js'

describe('signal table', () => {
  it('numbers the signals as Linux does', () => {
    expect(SIGNAL_NUMBERS.HUP).toBe(1)
    expect(SIGNAL_NUMBERS.USR1).toBe(10)
    expect(SIGNAL_NUMBERS.CHLD).toBe(17)
    expect(SIGNAL_NUMBERS.WINCH).toBe(28)
    expect(SIGNAL_NUMBERS.SYS).toBe(31)
    expect(signalNameList()).toHaveLength(31)
  })

  it('names a number and normalizes every spelling of a name', () => {
    expect(signalNameOf(28)).toBe('WINCH')
    expect(signalNameOf(0)).toBeUndefined()
    expect(signalNameOf(99)).toBeUndefined()
    expect(normalizeSignal('INT')).toBe('INT')
    expect(normalizeSignal('SIGINT')).toBe('INT')
    expect(normalizeSignal('sigwinch')).toBe('WINCH')
    expect(normalizeSignal('28')).toBe('WINCH')
    expect(normalizeSignal('FOO')).toBeUndefined()
    expect(normalizeSignal('999')).toBeUndefined()
  })

  it('knows which signals cannot be caught', () => {
    expect([...UNCATCHABLE_SIGNALS].sort()).toEqual(['KILL', 'STOP'])
  })
})
