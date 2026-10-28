import { describe, expect, it } from 'vitest'

// @ts-expect-error plain JS module
import { parseAtTime, parseTouchTime } from '../../src/commands-execve/lib/at-time.mjs'

/** Tuesday 27 October 2026, 14:30 local */
const now = new Date(2026, 9, 27, 14, 30).getTime()
const at = (spec: string) => {
  const ms = parseAtTime(spec, now)
  if (Number.isNaN(ms)) return 'NaN'
  const d = new Date(ms)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}

describe('at times', () => {
  it('takes now and increments', () => {
    expect(at('now')).toBe('2026-10-27 14:30')
    expect(at('now + 5 minutes')).toBe('2026-10-27 14:35')
    expect(at('now +2 hours')).toBe('2026-10-27 16:30')
    expect(at('now + 1 week')).toBe('2026-11-3 14:30')
  })

  it('takes times of day, the next one when today\'s has passed', () => {
    expect(at('15:00')).toBe('2026-10-27 15:00')
    expect(at('1500')).toBe('2026-10-27 15:00')
    expect(at('3pm')).toBe('2026-10-27 15:00')
    expect(at('3 pm')).toBe('2026-10-27 15:00')
    expect(at('10am')).toBe('2026-10-28 10:00')
    expect(at('noon')).toBe('2026-10-28 12:00')
    expect(at('midnight')).toBe('2026-10-28 0:00')
    expect(at('teatime')).toBe('2026-10-27 16:00')
  })

  it('takes dates after the time', () => {
    expect(at('teatime tomorrow')).toBe('2026-10-28 16:00')
    expect(at('noon friday')).toBe('2026-10-30 12:00')
    expect(at('9:00 oct 30')).toBe('2026-10-30 9:00')
    expect(at('9:00 jan 2 2027')).toBe('2027-1-2 9:00')
    expect(at('9:00 10/31/26')).toBe('2026-10-31 9:00')
    expect(at('9:00 31.10.2026')).toBe('2026-10-31 9:00')
    expect(at('9:00 2026-11-01')).toBe('2026-11-1 9:00')
    expect(at('4pm + 3 days')).toBe('2026-10-30 16:00')
  })

  it('refuses what is not a time', () => {
    for (const spec of ['', 'garbage', '25:00', '13pm', 'noon someday', 'now +']) expect(at(spec), spec).toBe('NaN')
  })

  it('takes -t stamps as touch does', () => {
    expect(new Date(parseTouchTime('202611011200', now)).getHours()).toBe(12)
    expect(new Date(parseTouchTime('11011200.30', now)).getSeconds()).toBe(30)
    expect(parseTouchTime('13011200', now)).toBeNaN()
  })
})
