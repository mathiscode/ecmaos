/**
 * The times `at` takes, as POSIX and the at(1) of Linux write them: a time of day (`HH:MM`, `HHMM`, `H am`, `noon`,
 * `midnight`, `teatime`) or `now`, then an optional date (`today`, `tomorrow`, a weekday, `MONTH DAY [YEAR]`,
 * `MM/DD/[CC]YY`, `DD.MM.[CC]YY`, `[CC]YY-MM-DD`), then an optional `+ N unit` (minutes, hours, days, weeks, months,
 * years). A time of day that has passed today, with no date, is tomorrow's. `-t [[CC]YY]MMDDhhmm[.ss]` is
 * {@link parseTouchTime}. The result is milliseconds since the epoch, in the local zone, or `NaN` for what is not one.
 */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const UNITS = { minute: 'minute', min: 'minute', hour: 'hour', day: 'day', week: 'week', month: 'month', year: 'year' }

const unitOf = word => UNITS[word.replace(/s$/, '')] ?? (word.startsWith('min') ? 'minute' : undefined)
const fullYear = year => year < 100 ? 2000 + year : year

function add(date, amount, unit) {
  if (unit === 'minute') date.setMinutes(date.getMinutes() + amount)
  else if (unit === 'hour') date.setHours(date.getHours() + amount)
  else if (unit === 'day') date.setDate(date.getDate() + amount)
  else if (unit === 'week') date.setDate(date.getDate() + amount * 7)
  else if (unit === 'month') date.setMonth(date.getMonth() + amount)
  else if (unit === 'year') date.setFullYear(date.getFullYear() + amount)
}

/** `HH:MM`, `HHMM`, `HMM` or `HH`, each with an optional `am`/`pm` (attached or as the next word), and the named times */
function timeOfDay(words) {
  const word = words[0] ?? ''
  if (word === 'noon') return { hours: 12, minutes: 0, used: 1 }
  if (word === 'midnight') return { hours: 0, minutes: 0, used: 1 }
  if (word === 'teatime') return { hours: 16, minutes: 0, used: 1 }
  const match = /^(?:(\d{1,2}):(\d{2})|(\d{3,4})|(\d{1,2}))(am|pm)?$/.exec(word)
  if (!match) return undefined
  let hours, minutes
  if (match[1] !== undefined) { hours = Number(match[1]); minutes = Number(match[2]) }
  else if (match[3] !== undefined) { hours = Number(match[3].slice(0, -2)); minutes = Number(match[3].slice(-2)) }
  else { hours = Number(match[4]); minutes = 0 }
  let used = 1
  let meridian = match[5]
  if (!meridian && (words[1] === 'am' || words[1] === 'pm')) { meridian = words[1]; used = 2 }
  if (meridian) {
    if (hours < 1 || hours > 12) return undefined
    hours = hours % 12 + (meridian === 'pm' ? 12 : 0)
  }
  return hours < 24 && minutes < 60 ? { hours, minutes, used } : undefined
}

/** The date words at `words`, applied to `date`; how many were used, or undefined for a malformed date */
function applyDate(words, date, now) {
  const word = words[0]
  if (word === undefined || word === '+') return 0
  if (word === 'today') return 1
  if (word === 'tomorrow') { date.setDate(date.getDate() + 1); return 1 }
  const day = DAYS.findIndex(name => word.startsWith(name))
  if (day !== -1 && /^[a-z]+$/.test(word)) {
    const ahead = (day - date.getDay() + 7) % 7
    date.setDate(date.getDate() + ahead)
    return 1
  }
  const month = MONTHS.findIndex(name => word.startsWith(name))
  if (month !== -1 && /^[a-z]+$/.test(word) && /^\d{1,2},?$/.test(words[1] ?? '')) {
    const dayOfMonth = Number(words[1].replace(',', ''))
    let used = 2
    let year = date.getFullYear()
    if (/^\d{2,4}$/.test(words[2] ?? '')) { year = fullYear(Number(words[2])); used = 3 }
    date.setFullYear(year, month, dayOfMonth)
    if (used === 2 && date.getTime() < now) date.setFullYear(year + 1)
    return used
  }
  let match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(word)
  if (match) { date.setFullYear(fullYear(Number(match[3])), Number(match[1]) - 1, Number(match[2])); return 1 }
  match = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/.exec(word)
  if (match) { date.setFullYear(fullYear(Number(match[3])), Number(match[2]) - 1, Number(match[1])); return 1 }
  match = /^(\d{2}|\d{4})-(\d{1,2})-(\d{1,2})$/.exec(word)
  if (match) { date.setFullYear(fullYear(Number(match[1])), Number(match[2]) - 1, Number(match[3])); return 1 }
  return undefined
}

/** The time a spec names, from `now` (ms), or NaN */
export function parseAtTime(text, now = Date.now()) {
  const words = text.toLowerCase().replace(/\+/g, ' + ').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return NaN
  const date = new Date(now)
  date.setSeconds(0, 0)
  let at = 0
  let explicitDate = false
  if (words[0] === 'now') at = 1
  else {
    const time = timeOfDay(words)
    if (!time) return NaN
    date.setHours(time.hours, time.minutes, 0, 0)
    at = time.used
    const used = applyDate(words.slice(at), date, now)
    if (used === undefined) return NaN
    explicitDate = used > 0
    at += used
    if (!explicitDate && date.getTime() < now - 60_000) date.setDate(date.getDate() + 1)
  }
  if (words[at] === '+') {
    const amount = Number(words[at + 1])
    const unit = unitOf(words[at + 2] ?? '')
    if (!Number.isInteger(amount) || amount < 0 || !unit) return NaN
    add(date, amount, unit)
    at += 3
  } else if (words[0] === 'now' && words[at] !== undefined) {
    // `now tomorrow`, `now friday`: this time of day on that date
    const used = applyDate(words.slice(at), date, now)
    if (used === undefined || used === 0) return NaN
    at += used
  }
  return at === words.length ? date.getTime() : NaN
}

/** `-t [[CC]YY]MMDDhhmm[.ss]`, as touch(1) takes it; NaN when malformed */
export function parseTouchTime(text, now = Date.now()) {
  const match = /^(\d{2}|\d{4})?(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{2}))?$/.exec(text)
  if (!match) return NaN
  const year = match[1] === undefined ? new Date(now).getFullYear() : fullYear(Number(match[1]))
  const date = new Date(year, Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6] ?? 0))
  return date.getMonth() === Number(match[2]) - 1 ? date.getTime() : NaN
}
