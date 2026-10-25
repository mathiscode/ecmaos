import { describe, expect, it } from 'vitest'

import { posixTimeZone } from '#lib/time-zone.ts'

const october = Date.UTC(2026, 9, 25)

describe('the browser time zone as a POSIX TZ string', () => {
  it('has no rules for a zone with no summer time', () => {
    expect(posixTimeZone('UTC', october)).toBe('UTC0')
    expect(posixTimeZone('Asia/Kolkata', october)).toBe('<+0530>-5:30')
    expect(posixTimeZone('America/Sao_Paulo', october)).toBe('<-03>3')
    expect(posixTimeZone('Asia/Tokyo', october)).toBe('<+09>-9')
  })

  it('gives the weekday rule of a zone with summer time, in the northern hemisphere', () => {
    expect(posixTimeZone('America/Chicago', october)).toBe('CST6CDT,M3.2.0/2,M11.1.0/2')
    expect(posixTimeZone('America/New_York', october)).toBe('EST5EDT,M3.2.0/2,M11.1.0/2')
    expect(posixTimeZone('Europe/Berlin', october)).toBe('<+01>-1<+02>,M3.5.0/2,M10.5.0/3')
  })

  it('gives the rule in the southern hemisphere, where summer time spans the new year', () => {
    expect(posixTimeZone('Australia/Sydney', october)).toBe('<+10>-10<+11>,M10.1.0/2,M4.1.0/3')
  })

  it('names the zone the same in winter and summer', () => {
    expect(posixTimeZone('America/Chicago', Date.UTC(2026, 0, 15))).toBe(posixTimeZone('America/Chicago', october))
  })
})
