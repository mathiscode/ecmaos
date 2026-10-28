import { describe, expect, it } from 'vitest'

// @ts-expect-error plain JS module
import { parsePosixTz, zoneAt } from '../../src/commands-execve/lib/tz.mjs'

const summer = Date.UTC(2026, 6, 1, 12)
const winter = Date.UTC(2026, 0, 15, 12)

describe('TZ', () => {
  it('reads POSIX rules, northern and southern, with and without summer time', () => {
    expect(zoneAt(summer, 'CST6CDT,M3.2.0/2,M11.1.0/2')).toEqual({ offset: -300, abbr: 'CDT' })
    expect(zoneAt(winter, 'CST6CDT,M3.2.0/2,M11.1.0/2')).toEqual({ offset: -360, abbr: 'CST' })
    expect(zoneAt(summer, '<+10>-10<+11>,M10.1.0/2,M4.1.0/3')).toEqual({ offset: 600, abbr: '+10' })
    expect(zoneAt(winter, '<+10>-10<+11>,M10.1.0/2,M4.1.0/3')).toEqual({ offset: 660, abbr: '+11' })
    expect(zoneAt(summer, 'JST-9')).toEqual({ offset: 540, abbr: 'JST' })
    expect(zoneAt(summer, '<+0530>-5:30')).toEqual({ offset: 330, abbr: '+0530' })
    expect(zoneAt(summer, 'UTC0')).toEqual({ offset: 0, abbr: 'UTC' })
    expect(zoneAt(summer, 'EST5EDT')).toEqual({ offset: -240, abbr: 'EDT' })
  })

  it('changes at the moment the rule says', () => {
    const tz = 'CST6CDT,M3.2.0/2,M11.1.0/2'
    // 8 March 2026, 02:00 CST is 08:00 UTC
    expect(zoneAt(Date.UTC(2026, 2, 8, 7, 59), tz).abbr).toBe('CST')
    expect(zoneAt(Date.UTC(2026, 2, 8, 8, 0), tz).abbr).toBe('CDT')
    // 1 November 2026, 02:00 CDT is 07:00 UTC
    expect(zoneAt(Date.UTC(2026, 10, 1, 6, 59), tz).abbr).toBe('CDT')
    expect(zoneAt(Date.UTC(2026, 10, 1, 7, 0), tz).abbr).toBe('CST')
  })

  it('reads IANA names, with or without a colon, and gives up on what is neither', () => {
    expect(zoneAt(summer, 'Asia/Tokyo')?.offset).toBe(540)
    expect(zoneAt(summer, ':America/Chicago')?.offset).toBe(-300)
    expect(zoneAt(summer, 'Not/A_Zone')).toBeUndefined()
    expect(zoneAt(summer, '')).toBeUndefined()
    expect(parsePosixTz('nonsense here')).toBeUndefined()
  })
})
