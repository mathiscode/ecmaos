import { describe, expect, it } from 'vitest'

// @ts-expect-error plain JS module
import { parseDate, parseTouchStamp, useUtc } from '../../src/commands-execve/lib/datespec.mjs'

const now = new Date(2024, 0, 15, 12, 30, 0).getTime()

describe('parseDate', () => {
  it('reads epoch seconds', () => {
    expect(parseDate('@0', now)).toBe(0)
    expect(parseDate('@1700000000.5', now)).toBe(1700000000500)
  })
  it('reads ISO dates as local time, with or without a clock', () => {
    expect(parseDate('2024-03-05', now)).toBe(new Date(2024, 2, 5).getTime())
    expect(parseDate('2024-03-05 10:11:12', now)).toBe(new Date(2024, 2, 5, 10, 11, 12).getTime())
    expect(parseDate('2024-03-05T10:11', now)).toBe(new Date(2024, 2, 5, 10, 11).getTime())
  })
  it('honours an explicit zone', () => {
    expect(parseDate('2024-03-05T10:11:12Z', now)).toBe(Date.UTC(2024, 2, 5, 10, 11, 12))
    expect(parseDate('2024-03-05 10:00 +0200', now)).toBe(Date.UTC(2024, 2, 5, 8, 0, 0))
  })
  it('knows now, today, yesterday and tomorrow', () => {
    expect(parseDate('now', now)).toBe(now)
    expect(parseDate('yesterday', now)).toBe(new Date(2024, 0, 14, 12, 30).getTime())
    expect(parseDate('tomorrow', now)).toBe(new Date(2024, 0, 16, 12, 30).getTime())
    expect(parseDate('midnight', now)).toBe(new Date(2024, 0, 15).getTime())
  })
  it('applies relative offsets alone or after a date', () => {
    expect(parseDate('3 days ago', now)).toBe(now - 3 * 86400000)
    expect(parseDate('+2 weeks', now)).toBe(now + 14 * 86400000)
    expect(parseDate('2024-01-01 +1 day', now)).toBe(new Date(2024, 0, 2).getTime())
    expect(parseDate('1 month', now)).toBe(new Date(2024, 1, 15, 12, 30).getTime())
  })
  it('reads month names', () => {
    expect(parseDate('Jan 2 2024', now)).toBe(new Date(2024, 0, 2).getTime())
  })
  it('rejects nonsense and impossible dates', () => {
    expect(parseDate('banana', now)).toBeNaN()
    expect(parseDate('2024-02-31', now)).toBeNaN()
    expect(parseDate('2024-13-01', now)).toBeNaN()
  })
})

describe('parseTouchStamp', () => {
  it('reads [[CC]YY]MMDDhhmm[.ss]', () => {
    expect(parseTouchStamp('202403051011', now)).toBe(new Date(2024, 2, 5, 10, 11).getTime())
    expect(parseTouchStamp('2403051011.30', now)).toBe(new Date(2024, 2, 5, 10, 11, 30).getTime())
    expect(parseTouchStamp('03051011', now)).toBe(new Date(2024, 2, 5, 10, 11).getTime())
    expect(parseTouchStamp('6903051011', now)).toBe(new Date(1969, 2, 5, 10, 11).getTime())
  })
  it('rejects a bad stamp', () => {
    expect(parseTouchStamp('abc', now)).toBeNaN()
    expect(parseTouchStamp('202413051011', now)).toBeNaN()
  })
})

/** The expected values are what GNU date -u printed for the same strings (a Friday on 2026-10-16 for the weekday ones). */
describe('parseDate: the item forms of GNU date', () => {
  const utc = (y: number, m: number, d: number, h = 0, mi = 0, sec = 0) => Date.UTC(y, m - 1, d, h, mi, sec)
  const at = utc(2026, 10, 16, 1, 29, 24)
  const cases: Array<[string, number]> = [
    ['1970-01-01 12:30 tomorrow', utc(1970, 1, 2, 12, 30)],
    ['yesterday 1970-01-01', utc(1969, 12, 31)],
    ['tomorrow 1970-01-01', utc(1970, 1, 2)],
    ['1970-01-01 next month', utc(1970, 2, 1)],
    ['1970-01-01 last year', utc(1969, 1, 1)],
    ['1970-01-01 next week', utc(1970, 1, 8)],
    ['1970-01-01 5pm', utc(1970, 1, 1, 17)],
    ['2024-01-03 12pm', utc(2024, 1, 3, 12)],
    ['2024-01-03 12am', utc(2024, 1, 3)],
    ['2024-01-03 12:30pm', utc(2024, 1, 3, 12, 30)],
    ['2024-01-03 next day', utc(2024, 1, 4)],
    ['2024-01-05 first day', utc(2024, 1, 6)],
    ['2024-01-03 friday', utc(2024, 1, 3)],
    ['2024-01-05 next sat', utc(2024, 1, 5)],
    ['monday 1970-01-01', utc(1970, 1, 1)],
    ['Jan 5 2024', utc(2024, 1, 5)],
    ['5 Jan 2024', utc(2024, 1, 5)],
    ['January 5, 2024 10:30', utc(2024, 1, 5, 10, 30)],
    ['1970-01-01 10 minutes ago', utc(1969, 12, 31, 23, 50)],
    ['1970-01-01 +2 weeks ago', utc(1969, 12, 18)],
    ['2024-01-31 + 1 month', utc(2024, 3, 2)],
    ['next friday', utc(2026, 10, 23)],
    ['last friday', utc(2026, 10, 9)],
    ['friday', utc(2026, 10, 16)],
    ['this friday', utc(2026, 10, 16)],
    ['thursday', utc(2026, 10, 22)],
    ['next thursday', utc(2026, 10, 22)],
    ['last thursday', utc(2026, 10, 15)],
    ['next month', utc(2026, 11, 16, 1, 29, 24)],
    ['next year', utc(2027, 10, 16, 1, 29, 24)],
    ['last day', utc(2026, 10, 15, 1, 29, 24)]
  ]
  it.each(cases)('%s', (text, want) => {
    useUtc(true)
    try { expect(parseDate(text, at)).toBe(want) } finally { useUtc(false) }
  })
  it.each(['1970-01-01 noon', '1970-01-01 midnight', '2024-01-03 Jan', '2024-01-03 1 day ago ago'])('%s is not a date, as in GNU', text => {
    useUtc(true)
    try { expect(parseDate(text, at)).toBeNaN() } finally { useUtc(false) }
  })
})
