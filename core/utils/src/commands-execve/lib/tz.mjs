/**
 * The zone `TZ` names, as the C library reads it: a POSIX rule (`CST6CDT,M3.2.0/2,M11.1.0/2`, which is what the kernel
 * gives every program from `/etc/timezone`), or an IANA name (`Asia/Tokyo`, `:Europe/Paris`), which `Intl` knows. With
 * neither, the commands use the browser's zone. {@link zoneAt} says what the offset and abbreviation are at an instant.
 */

const MINUTE = 60_000
const DAY = 86_400_000

/** `hh[:mm[:ss]]` with an optional sign, as minutes; POSIX counts west of Greenwich as positive */
function offsetMinutes(text) {
  const match = /^([+-])?(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?$/.exec(text)
  if (!match) return undefined
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0) + Number(match[4] ?? 0) / 60
  return match[1] === '-' ? -minutes : minutes
}

/** `Mm.w.d`, `Jn` or `n`, with an optional `/time`, as a function of the year giving that local moment as UTC-free ms */
function ruleOf(text) {
  const [date, time = '2'] = text.split('/')
  const at = offsetMinutes(time)
  if (at === undefined) return undefined
  let match = /^M(\d{1,2})\.(\d)\.(\d)$/.exec(date)
  if (match) {
    const [month, week, weekday] = [Number(match[1]), Number(match[2]), Number(match[3])]
    return year => {
      const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
      let day = 1 + ((weekday - first + 7) % 7) + (week - 1) * 7
      const days = new Date(Date.UTC(year, month, 0)).getUTCDate()
      if (week === 5) while (day > days) day -= 7
      return Date.UTC(year, month - 1, day) + at * MINUTE
    }
  }
  match = /^J(\d{1,3})$/.exec(date)
  if (match) {
    // Jn counts 1 to 365 and never February 29
    const n = Number(match[1])
    return year => {
      const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
      return Date.UTC(year, 0, 1) + (n - 1 + (leap && n >= 60 ? 1 : 0)) * DAY + at * MINUTE
    }
  }
  match = /^(\d{1,3})$/.exec(date)
  if (match) return year => Date.UTC(year, 0, 1) + Number(match[1]) * DAY + at * MINUTE
  return undefined
}

/** A name: three or more letters, or `<...>` */
function takeName(text) {
  const match = /^(<[^>]+>|[A-Za-z]{3,})/.exec(text)
  return match ? { name: match[1].replace(/^<|>$/g, ''), rest: text.slice(match[1].length) } : undefined
}

function takeOffset(text) {
  const match = /^([+-]?\d{1,2}(?::\d{2}){0,2})/.exec(text)
  return match ? { offset: offsetMinutes(match[1]), rest: text.slice(match[1].length) } : undefined
}

/** A POSIX `TZ` rule, or undefined when the text is not one */
export function parsePosixTz(text) {
  const std = takeName(text)
  if (!std) return undefined
  const stdOffset = takeOffset(std.rest)
  if (!stdOffset) return /^(UTC|GMT|UCT)$/.test(text) ? { std: text, stdOffset: 0 } : undefined
  let rest = stdOffset.rest
  if (!rest) return { std: std.name, stdOffset: stdOffset.offset }
  const dst = takeName(rest)
  if (!dst) return undefined
  rest = dst.rest
  let dstOffset = stdOffset.offset - 60
  const explicit = takeOffset(rest)
  if (explicit && explicit.rest !== rest) { dstOffset = explicit.offset; rest = explicit.rest }
  // with no rule, the United States' (as glibc assumes)
  const [startText, endText] = rest.startsWith(',') ? rest.slice(1).split(',') : ['M3.2.0', 'M11.1.0']
  const start = ruleOf(startText ?? '')
  const end = ruleOf(endText ?? '')
  if (!start || !end) return undefined
  return { std: std.name, stdOffset: stdOffset.offset, dst: dst.name, dstOffset, start, end }
}

let cached

/** The zone of `tz`: a function from an instant to `{ offset, abbr }` (offset in minutes east), or undefined */
function compile(tz) {
  if (!tz) return undefined
  const name = tz.startsWith(':') ? tz.slice(1) : tz
  if (name.includes('/') || name === 'UTC') {
    try {
      const format = new Intl.DateTimeFormat('en-US', { timeZone: name, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', timeZoneName: 'short' })
      return ms => {
        const parts = {}
        for (const part of format.formatToParts(new Date(ms))) parts[part.type] = part.value
        const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second))
        const offset = Math.round((wall - Math.floor(ms / 1000) * 1000) / MINUTE)
        return { offset, abbr: /^[A-Za-z]{3,}$/.test(parts.timeZoneName ?? '') ? parts.timeZoneName : offset === 0 ? 'UTC' : `${offset < 0 ? '-' : '+'}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}${Math.abs(offset) % 60 ? String(Math.abs(offset) % 60).padStart(2, '0') : ''}` }
      }
    } catch { /* not a zone this engine knows: try it as a rule */ }
  }
  const rule = parsePosixTz(name)
  if (!rule) return undefined
  return ms => {
    if (!rule.dst) return { offset: -rule.stdOffset || 0, abbr: rule.std }
    const year = new Date(ms - rule.stdOffset * MINUTE).getUTCFullYear()
    // the changes in UTC: summer time begins at a standard-time moment and ends at a summer-time one
    const begins = rule.start(year) + rule.stdOffset * MINUTE
    const ends = rule.end(year) + rule.dstOffset * MINUTE
    const summer = begins < ends ? ms >= begins && ms < ends : !(ms >= ends && ms < begins)
    return summer ? { offset: -rule.dstOffset || 0, abbr: rule.dst } : { offset: -rule.stdOffset || 0, abbr: rule.std }
  }
}

/** The offset (minutes east of UTC) and abbreviation `tz` gives at `ms`, or undefined to use the browser's zone */
export function zoneAt(ms, tz = globalThis.ecmaosSyscalls?.env?.TZ) {
  if (!cached || cached.tz !== tz) cached = { tz, zone: compile(tz) }
  return cached.zone?.(ms)
}
