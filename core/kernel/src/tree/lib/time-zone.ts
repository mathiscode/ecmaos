/**
 * The browser's time zone as a POSIX `TZ` string (`CST6CDT,M3.2.0/2,M11.1.0/2`), for programs built on musl: it reads `TZ`
 * (there is no zoneinfo database to look a name up in) and with none prints UTC, where the JavaScript commands print the
 * browser's zone. The rules are the ones the zone has in the current year, taken from `Intl`; a zone that changes its
 * offset more than twice a year, or one whose rule is not "the nth weekday of a month", is given as its current offset.
 */

const Minute = 60000
const Day = 86400000

type Parts = Record<string, number>

function partsOf(format: Intl.DateTimeFormat, ms: number): Parts {
  const parts: Parts = {}
  for (const part of format.formatToParts(new Date(ms))) if (part.type !== 'literal' && part.type !== 'timeZoneName') parts[part.type] = Number(part.value)
  if (parts['hour'] === 24) parts['hour'] = 0
  return parts
}

/** Minutes east of UTC and the wall clock, at an instant */
function zoneAt(format: Intl.DateTimeFormat, ms: number): { offset: number, wall: Parts } {
  const wall = partsOf(format, ms)
  const asUtc = Date.UTC(wall['year']!, wall['month']! - 1, wall['day'], wall['hour'], wall['minute'], 0)
  return { offset: Math.round((asUtc - Math.floor(ms / Minute) * Minute) / Minute), wall }
}

function abbreviation(timeZone: string | undefined, ms: number, offset: number): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' }).formatToParts(new Date(ms)).find(p => p.type === 'timeZoneName')
    if (part && /^[A-Za-z]{3,}$/.test(part.value)) return part.value
  } catch { /* a name the engine does not know */ }
  const sign = offset < 0 ? '-' : '+'
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')
  const minutes = Math.abs(offset) % 60
  return `<${sign}${hours}${minutes ? String(minutes).padStart(2, '0') : ''}>`
}

/** POSIX writes the offset as time west of UTC: `CST6`, `<+0530>-5:30` */
function westOf(offset: number): string {
  const west = -offset
  const sign = west < 0 ? '-' : ''
  const hours = Math.floor(Math.abs(west) / 60)
  const minutes = Math.abs(west) % 60
  return sign + String(hours) + (minutes ? ':' + String(minutes).padStart(2, '0') : '')
}

/** The first minute at which the offset is no longer `before`, searched within `[low, high]`, where it differs at `high` */
function transitionBetween(format: Intl.DateTimeFormat, low: number, high: number, before: number): number {
  let lo = Math.floor(low / Minute), hi = Math.floor(high / Minute)
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    if (zoneAt(format, mid * Minute).offset === before) lo = mid
    else hi = mid
  }
  return hi * Minute
}

/** `Mm.w.d/time`: the nth (the last, for 5) weekday of a month, at the wall clock time the zone had before the change */
function ruleOf(format: Intl.DateTimeFormat, instant: number): string {
  const wall = zoneAt(format, instant - Minute).wall
  const local = new Date(Date.UTC(wall['year']!, wall['month']! - 1, wall['day']))
  const month = wall['month']!
  const day = wall['day']!
  const weekday = local.getUTCDay()
  const days = new Date(Date.UTC(wall['year']!, month, 0)).getUTCDate()
  const week = day + 7 > days ? 5 : Math.ceil(day / 7)
  // the change happens at the moment the clock reads this, one minute after the minute before it
  const seconds = (wall['hour']! * 60 + wall['minute']! + 1) * 60
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60, rest = seconds % 60
  const time = `${hours}${minutes || rest ? ':' + String(minutes).padStart(2, '0') : ''}${rest ? ':' + String(rest).padStart(2, '0') : ''}`
  return `M${month}.${week}.${weekday}/${time}`
}

/** The `TZ` string for an IANA zone (the browser's, when none is given), as it is in the year of `now` */
export function posixTimeZone(timeZone?: string, now = Date.now()): string {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric'
  })
  const year = partsOf(format, now)['year']!
  const start = Date.UTC(year, 0, 1)
  // every change of offset in the year, found a day at a time and then to the minute
  const changes: { at: number, from: number, to: number }[] = []
  let previous = zoneAt(format, start).offset
  for (let ms = start + Day; ms <= Date.UTC(year + 1, 0, 1); ms += Day) {
    const offset = zoneAt(format, ms).offset
    if (offset !== previous) {
      changes.push({ at: transitionBetween(format, ms - Day, ms, previous), from: previous, to: offset })
      previous = offset
    }
  }
  const current = zoneAt(format, now).offset
  const name = (offset: number, at: number) => abbreviation(timeZone, at, offset)
  const fixed = () => `${name(current, now)}${westOf(current)}`
  if (changes.length !== 2) return fixed()
  const [first, second] = changes as [typeof changes[0], typeof changes[0]]
  // the zone is on summer time between the changes when the offset there is the larger one
  const southern = first.to < first.from
  const standard = Math.min(first.from, first.to)
  const summer = Math.max(first.from, first.to)
  const begin = southern ? second : first
  const end = southern ? first : second
  // an instant at which the zone had each offset, for its abbreviation
  const during = (offset: number) => [start, (first.at + second.at) / 2].find(at => zoneAt(format, at).offset === offset) ?? now
  // POSIX takes summer time as an hour ahead of standard time unless it says otherwise
  const summerOffset = summer === standard + 60 ? '' : westOf(summer)
  return `${name(standard, during(standard))}${westOf(standard)}${name(summer, during(summer))}${summerOffset},${ruleOf(format, begin.at)},${ruleOf(format, end.at)}`
}

/** The browser's zone as `TZ`, or UTC where the engine cannot say */
export function localTimeZone(): string {
  try { return posixTimeZone() } catch { return 'UTC0' }
}
