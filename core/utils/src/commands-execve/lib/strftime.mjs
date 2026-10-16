/**
 * `strftime` as GNU `date` has it, for the C locale: every conversion (`%a %A %b %B %c %C %d %D %e %F %g %G %h %H %I %j %k
 * %l %m %M %n %N %p %P %r %R %s %S %t %T %u %U %V %w %W %x %X %y %Y %z %Z %%`), the flags `-` `_` `0` `^` `#`, a field
 * width, `%:z` / `%::z`, and the `E` and `O` modifiers (ignored). An unknown conversion is printed as written.
 *
 * `fields` is `{ ms, utc, zone }`: the instant, whether to read it in UTC, and the zone's abbreviation.
 */

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export function breakdown(ms, utc) {
  const d = new Date(ms)
  if (utc) return { Y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), H: d.getUTCHours(), M: d.getUTCMinutes(), S: d.getUTCSeconds(), w: d.getUTCDay(), offset: 0 }
  return { Y: d.getFullYear(), m: d.getMonth(), d: d.getDate(), H: d.getHours(), M: d.getMinutes(), S: d.getSeconds(), w: d.getDay(), offset: -d.getTimezoneOffset() }
}

const dayOfYear = t => Math.round((Date.UTC(t.Y, t.m, t.d) - Date.UTC(t.Y, 0, 1)) / 86400000) + 1

/** ISO 8601 week-based year and week */
function isoWeek(t) {
  const wday = (t.w + 6) % 7
  const thursday = new Date(Date.UTC(t.Y, t.m, t.d - wday + 3))
  const year = thursday.getUTCFullYear()
  const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / 86400000 / 7) + 1
  return { year, week }
}

export function strftime(format, { ms, utc = false, zone = 'UTC' }) {
  const t = breakdown(ms, utc)
  const frac = ((ms % 1000) + 1000) % 1000
  const yday = dayOfYear(t)
  let out = ''
  for (let i = 0; i < format.length; i++) {
    if (format[i] !== '%') { out += format[i]; continue }
    const start = i
    let flag = ''
    let j = i + 1
    while ('-_0^#'.includes(format[j]) && format[j] !== undefined) flag += format[j++]
    let width = ''
    while (/\d/.test(format[j] ?? '')) width += format[j++]
    let colons = 0
    while (format[j] === ':') { colons++; j++ }
    while (format[j] === 'E' || format[j] === 'O') j++
    const key = format[j]
    if (key === undefined) { out += format.slice(start); break }
    // [text, default pad char, default width] for numbers; plain strings for text
    let text, numeric = false, pad = '0', defWidth = 0
    const num = (v, w, p = '0') => { text = String(Math.abs(v)); numeric = true; pad = p; defWidth = w; if (v < 0) text = '-' + text }
    switch (key) {
      case '%': text = '%'; break
      case 'n': text = '\n'; break
      case 't': text = '\t'; break
      case 'a': text = DAYS[t.w].slice(0, 3); break
      case 'A': text = DAYS[t.w]; break
      case 'b': case 'h': text = MONTHS[t.m].slice(0, 3); break
      case 'B': text = MONTHS[t.m]; break
      case 'p': text = t.H < 12 ? 'AM' : 'PM'; break
      case 'P': text = t.H < 12 ? 'am' : 'pm'; break
      case 'Z': text = zone; break
      case 'C': num(Math.floor(t.Y / 100), 2); break
      case 'd': num(t.d, 2); break
      case 'e': num(t.d, 2, ' '); break
      case 'H': num(t.H, 2); break
      case 'I': num(t.H % 12 || 12, 2); break
      case 'j': num(yday, 3); break
      case 'k': num(t.H, 2, ' '); break
      case 'l': num(t.H % 12 || 12, 2, ' '); break
      case 'm': num(t.m + 1, 2); break
      case 'M': num(t.M, 2); break
      case 'N': { const digits = String(frac).padStart(3, '0') + '000000'; text = width ? digits.slice(0, Number(width)).padEnd(Number(width), '0') : digits; width = ''; break }
      case 's': num(Math.floor(ms / 1000), 1); break
      case 'S': num(t.S, 2); break
      case 'u': num(t.w || 7, 1); break
      case 'w': num(t.w, 1); break
      case 'U': num(Math.floor((yday + 6 - t.w) / 7), 2); break
      case 'W': num(Math.floor((yday + 6 - ((t.w + 6) % 7)) / 7), 2); break
      case 'V': num(isoWeek(t).week, 2); break
      case 'G': num(isoWeek(t).year, 1); break
      case 'g': num(isoWeek(t).year % 100, 2); break
      case 'y': num(t.Y % 100, 2); break
      case 'Y': num(t.Y, 1); break
      case 'z': {
        const o = t.offset
        const sign = o < 0 ? '-' : '+'
        const a = Math.abs(o)
        const hh = String(Math.floor(a / 60)).padStart(2, '0')
        const mm = String(a % 60).padStart(2, '0')
        text = colons === 0 ? `${sign}${hh}${mm}` : colons === 1 ? `${sign}${hh}:${mm}` : `${sign}${hh}:${mm}:00`
        break
      }
      case 'D': text = strftime('%m/%d/%y', { ms, utc, zone }); break
      case 'F': text = strftime('%Y-%m-%d', { ms, utc, zone }); break
      case 'T': text = strftime('%H:%M:%S', { ms, utc, zone }); break
      case 'R': text = strftime('%H:%M', { ms, utc, zone }); break
      case 'r': text = strftime('%I:%M:%S %p', { ms, utc, zone }); break
      case 'x': text = strftime('%m/%d/%y', { ms, utc, zone }); break
      case 'X': text = strftime('%H:%M:%S', { ms, utc, zone }); break
      case 'c': text = strftime('%a %b %e %H:%M:%S %Y', { ms, utc, zone }); break
      default: out += format.slice(start, j + 1); i = j; continue
    }
    if (flag.includes('^')) text = text.toUpperCase()
    if (flag.includes('#')) text = /[a-z]/.test(text) ? text.toUpperCase() : text.toLowerCase()
    let w = width ? Number(width) : 0
    if (numeric) {
      const last = [...flag].filter(f => '-_0'.includes(f)).pop()
      let p = pad
      let min = Math.max(w, defWidth)
      if (last === '-') min = 0
      else if (last === '_') p = ' '
      else if (last === '0') p = '0'
      if (key === 'Y' && w === 0 && last === undefined) min = 0
      const negative = text.startsWith('-')
      const digits = negative ? text.slice(1) : text
      text = (negative ? '-' : '') + (p === '0' ? digits.padStart(min - (negative ? 1 : 0), '0') : (negative ? '-' : '') + digits).padStart(p === '0' ? 0 : min, ' ')
      if (p === '0') text = text
    } else if (w) {
      const zero = flag.includes('0')
      text = text.padStart(w, zero ? '0' : ' ')
    }
    out += text
    i = j
  }
  return out
}
