/**
 * Date strings as GNU `date -d` and `touch -d` read them, for the forms people actually write: `@EPOCH`, `now`,
 * `today`, `midnight`, `yesterday`, `tomorrow` (the day words keep the time of day), `YYYY-MM-DD[ T]HH:MM[:SS[.fff]][Z|+HH[:]MM]`, `YYYY/MM/DD`, a bare `HH:MM[:SS]`,
 * RFC 2822 and `Jan 2 2024` style dates (through `Date.parse`), and relative offsets (`3 days ago`, `+2 weeks`,
 * `1 month`) alone or after a date, `next month`, `last year`, `next friday`, and a clock time (`5pm`, `12:30`) before or after a date. A string without a zone is local time. Returns milliseconds, or `NaN`.
 */

const UNITS = {
  second: 1000, sec: 1000, minute: 60000, min: 60000, hour: 3600000, day: 86400000, week: 604800000, fortnight: 1209600000
}
const CALENDAR_UNITS = { month: 'month', year: 'year' }

const RELATIVE = /([+-]?\s*\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|days?|weeks?|fortnights?|months?|years?)(\s+ago)?\b/gi

/** `Date` for local `y-m-d h:mi:s`, with the calendar fields allowed to overflow as `Date` does */
let forcedUtc = false
/** Reads dates as UTC from now on (`date -u`), whatever the zone */
export const useUtc = flag => { forcedUtc = Boolean(flag) }
const utcZone = () => forcedUtc || /^(UTC|GMT|UCT)(0)?$/.test(globalThis.ecmaosSyscalls?.env?.TZ ?? '')
/** Moves a date by whole calendar days or months in the zone being read */
const addDays = (d, n) => { if (utcZone()) d.setUTCDate(d.getUTCDate() + n); else d.setDate(d.getDate() + n); return d }
const addMonths = (d, n) => { if (utcZone()) d.setUTCMonth(d.getUTCMonth() + n); else d.setMonth(d.getMonth() + n); return d }
const local = (y, m, d, h = 0, mi = 0, s = 0, ms = 0) => (utcZone() ? new Date(Date.UTC(y, m, d, h, mi, s, ms)) : new Date(y, m, d, h, mi, s, ms))
const yearOf = d => (utcZone() ? d.getUTCFullYear() : d.getFullYear())
const monthOf = d => (utcZone() ? d.getUTCMonth() : d.getMonth())
const dayOf = d => (utcZone() ? d.getUTCDate() : d.getDate())

function parseBase(text, now) {
  const trimmed = text.trim()
  if (trimmed === '' || /^now$/i.test(trimmed)) return now
  if (/^today$/i.test(trimmed)) return now
  if (/^midnight$/i.test(trimmed)) { const d = new Date(now); return local(yearOf(d), monthOf(d), dayOf(d)).getTime() }
  // The day words move the calendar day and keep the time of day, as GNU does
  if (/^yesterday$/i.test(trimmed)) return addDays(new Date(now), -1).getTime()
  if (/^tomorrow$/i.test(trimmed)) return addDays(new Date(now), 1).getTime()

  const epoch = /^@(-?\d+)(?:\.(\d+))?$/.exec(trimmed)
  if (epoch) return Number(epoch[1]) * 1000 + (epoch[2] ? Math.floor(Number(`0.${epoch[2]}`) * 1000) : 0)

  const clock = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/.exec(trimmed)
  if (clock) {
    const d = new Date(now)
    return local(yearOf(d), monthOf(d), dayOf(d), Number(clock[1]), Number(clock[2]), Number(clock[3] ?? 0)).getTime()
  }

  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?\s*(Z|UTC|GMT|[+-]\d{2}(?::?\d{2})?)?$/i.exec(trimmed)
  if (iso) {
    const [, y, mo, d, h = '0', mi = '0', s = '0', frac, zone] = iso
    if (Number(mo) > 12 || Number(mo) < 1 || Number(d) > 31 || Number(d) < 1 || Number(h) > 24 || Number(mi) > 59 || Number(s) > 60) return NaN
    const ms = frac ? Math.floor(Number(`0.${frac}`) * 1000) : 0
    if (!zone) {
      const date = local(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms)
      // 31 February and the like are invalid, not March
      return monthOf(date) === Number(mo) - 1 ? date.getTime() : NaN
    }
    let offset = 0
    if (!/^(Z|UTC|GMT)$/i.test(zone)) {
      const sign = zone[0] === '-' ? -1 : 1
      const digits = zone.slice(1).replace(':', '')
      offset = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || 0))
    }
    return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms) - offset * 60000
  }

  // MM/DD/YYYY, the American order, with an optional time
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(trimmed)
  if (us) {
    const [, mo, d, y, h = '0', mi = '0', sec = '0'] = us
    if (Number(mo) > 12 || Number(mo) < 1 || Number(d) > 31 || Number(d) < 1 || Number(h) > 24 || Number(mi) > 59 || Number(sec) > 60) return NaN
    const date = local(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec))
    return monthOf(date) === Number(mo) - 1 ? date.getTime() : NaN
  }

  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(trimmed)
  if (compact) return local(Number(compact[1]), Number(compact[2]) - 1, Number(compact[3])).getTime()

  // "Jan 2 2024", "Jan 2, 2024", "2 Jan 2024" (a time may follow): read in the zone being used
  const named = /^(?:([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})|(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?,?\s+(\d{4}))(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/i.exec(trimmed)
  if (named) {
    const month = monthIndex(named[1] ?? named[5])
    if (month < 0) return NaN
    const date = local(Number(named[3] ?? named[6]), month, Number(named[2] ?? named[4]), Number(named[7] ?? 0), Number(named[8] ?? 0), Number(named[9] ?? 0))
    return monthOf(date) === month ? date.getTime() : NaN
  }
  // RFC 2822 and anything else with a zone in it
  if (/[a-z]/i.test(trimmed) && /(?:\bGMT\b|\bUTC\b|\bZ\b|[+-]\d{4}\b)/i.test(trimmed)) return Date.parse(trimmed)
  return NaN
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const monthIndex = word => { const w = word.toLowerCase().slice(0, 3); return /^[a-z]+$/i.test(word) && (word.length === 3 || FULL_MONTHS.includes(word.toLowerCase()) || (w === 'sep' && word.toLowerCase() === 'sept')) ? MONTHS.indexOf(w) : -1 }
const FULL_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const WEEKDAY_NAMES = 'sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat'
const WEEKDAY_WORDS = new RegExp(`\\b(${WEEKDAY_NAMES})\\b\\.?`, 'i')
const ORDINALS = { next: 1, last: -1, this: 0, first: 1, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12 }
const ORDINAL_UNIT = new RegExp(`\\b(${Object.keys(ORDINALS).join('|')})\\s+(seconds?|minutes?|mins?|hours?|days?|weeks?|fortnights?|months?|years?|${WEEKDAY_NAMES})\\b`, 'i')
const CLOCK = /\b(\d{1,2})(?::(\d{2})(?::(\d{2}))?)?\s*(am|pm|a\.m\.|p\.m\.)\b|\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/i
const dayOfWeek = d => (utcZone() ? d.getUTCDay() : d.getDay())

/** Moves `time` by `amount` of a unit (calendar months and years in the zone being read) */
function shift(time, amount, unit) {
  if (unit === 'month' || unit === 'year') { const d = new Date(time); addMonths(d, unit === 'year' ? amount * 12 : amount); return d.getTime() }
  if (unit === 'day') { const d = new Date(time); addDays(d, amount); return d.getTime() }
  if (unit === 'week') { const d = new Date(time); addDays(d, amount * 7); return d.getTime() }
  if (unit === 'fortnight') { const d = new Date(time); addDays(d, amount * 14); return d.getTime() }
  if (unit in UNITS) return time + amount * UNITS[unit]
  return NaN
}
const singular = word => { const w = word.toLowerCase(); return w === 'mins' || w === 'min' ? 'minute' : w === 'secs' || w === 'sec' ? 'second' : w.replace(/s$/, '') }

/** @param {string} text @param {number} [now] */
export function parseDate(text, now = Date.now()) {
  let rest = String(text)
  const offsets = []
  rest = rest.replace(RELATIVE, (_, amount, unit, ago) => {
    offsets.push([Number(amount.replace(/\s+/g, '')) * (ago ? -1 : 1), singular(unit)])
    return ' '
  })
  // "next month", "last year", "next friday"
  let weekday
  let weekdayOrdinal = 0
  const ordinal = ORDINAL_UNIT.exec(rest)
  if (ordinal) {
    rest = rest.replace(ORDINAL_UNIT, ' ')
    const n = ORDINALS[ordinal[1].toLowerCase()]
    const unit = ordinal[2].toLowerCase()
    if (new RegExp(`^(${WEEKDAY_NAMES})$`).test(unit)) { weekday = WEEKDAYS.indexOf(unit.slice(0, 3)); weekdayOrdinal = n }
    else offsets.push([n, singular(unit)])
  }
  const named = WEEKDAY_WORDS.exec(rest)
  if (named && weekday === undefined) { weekday = WEEKDAYS.indexOf(named[1].toLowerCase().slice(0, 3)); rest = rest.replace(WEEKDAY_WORDS, ' ') }
  // the day words move the calendar day and keep the time of day
  let days = 0
  rest = rest.replace(/\b(yesterday|tomorrow|today|now)\b/gi, word => { const w = word.toLowerCase(); days += w === 'yesterday' ? -1 : w === 'tomorrow' ? 1 : 0; return ' ' })
  let stripped = rest.replace(/\s+/g, ' ').trim()

  // what is left is a date, a clock time, or both, in either order
  let base
  let datePart = stripped
  let clock
  if (stripped === '') base = undefined
  else {
    base = parseBase(stripped, now)
    if (Number.isNaN(base)) {
      const match = CLOCK.exec(stripped)
      if (!match) return NaN
      let hour, minute, second
      if (match[4] !== undefined) {
        hour = Number(match[1]); minute = Number(match[2] ?? 0); second = Number(match[3] ?? 0)
        if (hour < 1 || hour > 12) return NaN
        const pm = /^p/i.test(match[4])
        hour = hour % 12 + (pm ? 12 : 0)
      } else { hour = Number(match[5]); minute = Number(match[6]); second = Number(match[7] ?? 0) }
      if (hour > 24 || minute > 59 || second > 60) return NaN
      clock = [hour, minute, second]
      datePart = stripped.replace(CLOCK, ' ').replace(/\s+/g, ' ').trim()
      base = datePart === '' ? undefined : parseBase(datePart, now)
      if (base !== undefined && Number.isNaN(base)) return NaN
    }
  }
  const explicitDate = base !== undefined && !/^\d{1,2}:\d{2}/.test(datePart)
  const today = new Date(now)
  let time
  if (base === undefined) {
    // no date: today, at the clock time given, at midnight for a weekday, or at the time of day it is now
    time = clock ? local(yearOf(today), monthOf(today), dayOf(today), ...clock).getTime() : weekday !== undefined ? local(yearOf(today), monthOf(today), dayOf(today)).getTime() : now
  } else if (clock) {
    const d = new Date(base)
    time = local(yearOf(d), monthOf(d), dayOf(d), ...clock).getTime()
  } else time = base
  if (days) time = shift(time, days, 'day')
  // a weekday is the next one (today counts) unless it came with an explicit date, which wins
  if (weekday !== undefined && !explicitDate) {
    const here = dayOfWeek(new Date(time))
    let ahead = (weekday - here + 7) % 7
    if (weekdayOrdinal > 0 && ahead === 0) ahead = 7
    if (weekdayOrdinal < 0) ahead = ahead === 0 ? -7 : ahead - 7
    time = shift(time, ahead, 'day')
  }
  for (const [amount, unit] of offsets) {
    time = shift(time, amount, unit)
    if (Number.isNaN(time)) return NaN
  }
  void stripped
  return time
}

/**
 * `touch -t [[CC]YY]MMDDhhmm[.ss]` in local time; returns milliseconds or `NaN`.
 * @param {string} text
 */
export function parseTouchStamp(text, now = Date.now()) {
  const match = /^(?:(\d\d)?(\d\d))?(\d\d)(\d\d)(\d\d)(\d\d)(?:\.(\d\d))?$/.exec(text)
  if (!match) return NaN
  const [, century, year2, month, day, hour, minute, second = '0'] = match
  let year
  if (year2 === undefined) year = yearOf(new Date(now))
  else if (century !== undefined) year = Number(century) * 100 + Number(year2)
  // POSIX: two digits 69-99 are 19xx, 00-68 are 20xx
  else year = Number(year2) >= 69 ? 1900 + Number(year2) : 2000 + Number(year2)
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31 || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 61) return NaN
  const date = local(year, Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))
  return monthOf(date) === Number(month) - 1 ? date.getTime() : NaN
}
