/**
 * The calendars `cal` prints, as util-linux's cal prints them: one month, three, `-n` months, a year or twelve months, weeks
 * starting on Sunday or Monday, day-of-year numbers, week numbers, and the vertical layout. The calendar is Julian before the
 * reform of September 1752 (the days 3 to 13 are missing) and Gregorian after it.
 */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
const WEEKDAYS_JULIAN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** The reform: the last Julian day, and the Gregorian date that follows it */
const REFORM = { year: 1752, month: 9, lastJulian: 2, firstGregorian: 14 }

const isJulianDate = (day, month, year, reform) => year < reform.year || (year === reform.year && (month < reform.month || (month === reform.month && day <= reform.lastJulian)))

function leap(year, julian) { return julian ? year % 4 === 0 : (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 }

function daysInMonth(month, year, reform) {
  if (year === reform.year && month === reform.month) return 30 - (reform.firstGregorian - reform.lastJulian - 1)
  const days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
  if (month === 2 && leap(year, year < reform.year || (year === reform.year && month <= reform.month))) return 29
  return days
}

/** The day of the week (0 Sunday) of a date */
function weekday(day, month, year, reform) {
  const julian = isJulianDate(day, month, year, reform)
  const a = Math.floor((14 - month) / 12)
  const y = year + 4800 - a
  const m = month + 12 * a - 3
  const jdn = julian
    ? day + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - 32083
    : day + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045
  return (jdn + 1) % 7
}

/** The ordinal of a day in its year as cal's `-j` numbers it: the days skipped by the reform still count */
function dayOfYear(day, month, year, reform) {
  const julian = year < reform.year || (year === reform.year && month <= reform.month)
  let n = day
  for (let m = 1; m < month; m++) n += [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] + (m === 2 && leap(year, year < reform.year || (year === reform.year && m <= reform.month)) ? 1 : 0)
  void julian
  return n
}

/** The days really elapsed in the year before this one (the reform removes some), which is what week numbers go by */
function actualDayOfYear(day, month, year, reform) {
  let n = dayOfYear(day, month, year, reform)
  if (year === reform.year && (month > reform.month || (month === reform.month && day >= reform.firstGregorian))) n -= reform.firstGregorian - reform.lastJulian - 1
  return n
}

/** ISO 8601 week number of a date */
function isoWeek(day, month, year, reform) {
  const d = weekday(day, month, year, reform)
  const ordinal = actualDayOfYear(day, month, year, reform)
  const wd = d === 0 ? 7 : d
  let week = Math.floor((ordinal - wd + 10) / 7)
  const weeksIn = y => {
    const p = yy => (yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400)) % 7
    return p(y) === 4 || p(y - 1) === 3 ? 53 : 52
  }
  if (week < 1) return weeksIn(year - 1)
  if (week > weeksIn(year)) return 1
  return week
}

/** US week number: weeks start on Sunday, week 1 is the one with January 1 */
function usWeek(day, month, year, reform) {
  const ordinal = actualDayOfYear(day, month, year, reform)
  const jan1 = weekday(1, 1, year, reform)
  return Math.floor((ordinal + jan1 - 1) / 7) + 1
}

const center = (text, width) => {
  const left = Math.max(0, Math.floor((width - text.length + 1) / 2))
  return ' '.repeat(left) + text
}

/**
 * The block of one month: an array of lines, all `width` wide. `o`: `{ monday, julian, weeks, reform }`. The first line is the title
 * (month and year, or just the month in a year view).
 */
function monthBlock(month, year, o, withYear) {
  const reform = o.reform
  const dayWidth = o.julian ? 4 : 3
  const weekWidth = 7 * dayWidth - 1
  const labelWidth = o.weeks ? 3 : 0
  const width = weekWidth + labelWidth
  const title = withYear ? `${MONTHS[month - 1]} ${String(year).padStart(year < 1000 ? 4 : 1, '0')}` : MONTHS[month - 1]
  const lines = [center(title, width).padEnd(width)]
  const names = (o.julian ? WEEKDAYS_JULIAN : WEEKDAYS)
  const order = o.monday ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6]
  lines.push(' '.repeat(labelWidth) + order.map(d => names[d]).join(' ').padEnd(weekWidth))
  // the cells of the month, week by week
  const total = daysInMonth(month, year, reform)
  const days = []
  for (let n = 1; n <= total; n++) {
    let day = n
    if (year === reform.year && month === reform.month && n > reform.lastJulian) day = n + (reform.firstGregorian - reform.lastJulian - 1)
    days.push(day)
  }
  const first = weekday(days[0], month, year, reform)
  const offset = o.monday ? (first + 6) % 7 : first
  const rows = []
  let row = new Array(offset).fill(undefined)
  for (const day of days) {
    row.push(day)
    if (row.length === 7) { rows.push(row); row = [] }
  }
  if (row.length) { while (row.length < 7) row.push(undefined); rows.push(row) }
  while (rows.length < 6) rows.push(new Array(7).fill(undefined))
  for (const week of rows) {
    const cells = week.map(day => {
      if (day === undefined) return ' '.repeat(dayWidth - 1)
      const shown = o.julian ? dayOfYear(day, month, year, reform) : day
      const text = String(shown).padStart(dayWidth - 1)
      return o.today && o.today.day === day && o.today.month === month && o.today.year === year ? `\x1b[7m${text}\x1b[27m` : text
    })
    let label = ''
    if (o.weeks) {
      const anchor = week.find(day => day !== undefined)
      if (anchor === undefined) label = '   '
      else {
        // the week number of the Monday (or Sunday) that starts the row, as the row stands in the year
        const index = week.indexOf(anchor)
        const monday = o.monday ? week[0] : week[1]
        const reference = monday ?? anchor
        const refIndex = week.indexOf(reference)
        void index; void refIndex
        const number = !o.monday ? usWeek(week.find(d => d !== undefined), month, year, reform) : isoWeek(reference, month, year, reform)
        label = String(number).padStart(2) + ' '
      }
    }
    lines.push(label + cells.join(' ') + (cells.join(' ').replace(/\x1b\[\d+m/g, '').length < weekWidth ? ' '.repeat(weekWidth - cells.join(' ').replace(/\x1b\[\d+m/g, '').length) : ''))
  }
  return { lines, width }
}

function verticalBlock(month, year, o, withYear) {
  const reform = o.reform
  const title = withYear ? `${MONTHS[month - 1]} ${String(year).padStart(year < 1000 ? 4 : 1, '0')}` : MONTHS[month - 1]
  const names = o.monday ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6]
  const total = daysInMonth(month, year, reform)
  const days = []
  for (let n = 1; n <= total; n++) {
    let day = n
    if (year === reform.year && month === reform.month && n > reform.lastJulian) day = n + (reform.firstGregorian - reform.lastJulian - 1)
    days.push(day)
  }
  const first = weekday(days[0], month, year, reform)
  const offset = o.monday ? (first + 6) % 7 : first
  const columns = []
  for (let c = 0; c < 6; c++) columns.push(new Array(7).fill(undefined))
  days.forEach((day, index) => { const slot = offset + index; columns[Math.floor(slot / 7)][slot % 7] = day })
  const cell = day => (day === undefined ? '   ' : ' ' + String(o.julian ? dayOfYear(day, month, year, reform) : day).padStart(2))
  return { title, rows: names.map((d, r) => columns.map(col => cell(col[r])).join('')) , names: names.map(d => WEEKDAYS[d]) }
}

/** Parses a month name or number (`feb`, `February`, `2`) */
function parseMonth(text) {
  if (/^\d+$/.test(text)) return Number(text)
  const lower = text.toLowerCase()
  const found = MONTHS.findIndex(name => name.toLowerCase() === lower || (lower.length >= 3 && name.toLowerCase().startsWith(lower)))
  return found < 0 ? undefined : found + 1
}

const USAGE = `
Usage:
 cal [options] [[[day] month] year]
 cal [options] <timestamp|monthname>

Display a calendar, or some part of it.
Without any arguments, display the current month.

Options:
 -1, --one             show only a single month (default)
 -3, --three           show three months spanning the date
 -n, --months <num>    show num months starting with date's month
 -S, --span            span the date when displaying multiple months
 -s, --sunday          Sunday as first day of week
 -m, --monday          Monday as first day of week
 -j, --julian          use day-of-year for all calendars
     --reform <val>    Gregorian reform date (1752|gregorian|iso|julian)
     --iso             alias for --reform=iso
 -y, --year            show the whole year
 -Y, --twelve          show the next twelve months
 -w, --week[=<num>]    show US or ISO-8601 week numbers
 -v, --vertical        show day vertically instead of line
 -c, --columns <width> amount of columns to use
     --color[=<when>]  colorize messages (auto, always or never)
                         colors are enabled by default

 -h, --help            display this help
 -V, --version         display version

For more details see cal(1).
`

/** `{ out, err, status }` for the command line `args` on the date `now` (a `Date`), the screen `columns` wide */
export function renderCalendar(args, now, columns = 80, color = false) {
  const o = { monday: false, julian: false, weeks: false, usWeeks: false, vertical: false, reform: REFORM, span: false, count: 1, year: false, twelve: false }
  const operands = []
  if (color) o.today = { day: now.getDate(), month: now.getMonth() + 1, year: now.getFullYear() }
  const fail = text => ({ out: '', err: text, status: 1 })
  let months
  const invalid = letter => fail(`cal: invalid option -- '${letter}'\nTry 'cal --help' for more information.\n`)
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { operands.push(...args.slice(i + 1)); break }
    if (arg.startsWith('--')) {
      const [name, value] = arg.slice(2).split(/=(.*)/s)
      const LONG = ['one', 'three', 'months', 'span', 'sunday', 'monday', 'julian', 'reform', 'iso', 'year', 'twelve', 'week', 'vertical', 'columns', 'color', 'help', 'version']
      const matches = LONG.filter(l => l === name || l.startsWith(name))
      const exact = LONG.includes(name) ? [name] : matches
      if (exact.length !== 1) return fail(`cal: unrecognized option '--${name}'\nTry 'cal --help' for more information.\n`)
      const long = exact[0]
      if (long === 'one') { o.count = 1; o.countGiven = true }
      else if (long === 'three') { o.count = 3; o.countGiven = true }
      else if (long === 'months') { o.countGiven = true; months = Number(value ?? args[++i]); if (!Number.isInteger(months) || months < 1) return fail(`cal: invalid months argument\n`) }
      else if (long === 'span') o.span = true
      else if (long === 'sunday') o.monday = false
      else if (long === 'monday') o.monday = true
      else if (long === 'julian') o.julian = true
      else if (long === 'reform') { const v = value ?? args[++i]; if (v === 'iso' || v === 'gregorian') o.reform = { year: 1, month: 1, lastJulian: 0, firstGregorian: 1 }; else if (v === 'julian') o.reform = { year: 9999, month: 12, lastJulian: 31, firstGregorian: 32 } }
      else if (long === 'iso') o.reform = { year: 1, month: 1, lastJulian: 0, firstGregorian: 1 }
      else if (long === 'year') o.year = true
      else if (long === 'twelve') o.twelve = true
      else if (long === 'week') { o.weeks = true; if (value === 'us') o.usWeeks = true }
      else if (long === 'vertical') o.vertical = true
      else if (long === 'columns') { columns = Number(value ?? args[++i]) || columns }
      else if (long === 'help') return { out: USAGE, err: '', status: 0 }
      else if (long === 'version') return { out: 'cal from util-linux 2.42.3\n', err: '', status: 0 }
      continue
    }
    if (arg.startsWith('-') && arg.length > 1) {
      for (let k = 1; k < arg.length; k++) {
        const letter = arg[k]
        if (letter === '1') { o.count = 1; o.countGiven = true }
        else if (letter === '3') { o.count = 3; o.countGiven = true }
        else if (letter === 'S') o.span = true
        else if (letter === 's') o.monday = false
        else if (letter === 'm') o.monday = true
        else if (letter === 'j') o.julian = true
        else if (letter === 'y') o.year = true
        else if (letter === 'Y') o.twelve = true
        else if (letter === 'w') { o.weeks = true; const rest = arg.slice(k + 1); if (rest) { if (rest === 'us') o.usWeeks = true; k = arg.length } }
        else if (letter === 'v') o.vertical = true
        else if (letter === 'n' || letter === 'c') {
          const value = arg.slice(k + 1) || args[++i]
          if (letter === 'n') { o.countGiven = true; months = Number(value); if (!Number.isInteger(months) || months < 1) return fail(`cal: invalid months argument\n`) }
          else columns = Number(value) || columns
          break
        } else if (letter === 'h') return { out: USAGE, err: '', status: 0 }
        else if (letter === 'V') return { out: 'cal from util-linux 2.42.3\n', err: '', status: 0 }
        else return invalid(letter)
      }
      continue
    }
    operands.push(arg)
  }
  // the date shown
  let day = now.getDate()
  let month = now.getMonth() + 1
  let year = now.getFullYear()
  const parseYear = text => {
    if (!/^-?\d+$/.test(text)) return NaN
    return Number(text)
  }
  if (operands.length === 1) {
    const text = operands[0]
    if (/^\d+$/.test(text)) {
      year = Number(text)
      if (year < 1 || year > 9999) return fail('cal: illegal year value: use 1-9999\n')
      if (!o.countGiven) { o.year = true; o.twelve = false }
    } else {
      const m = parseMonth(text)
      if (m === undefined) return fail(`cal: failed to parse timestamp or unknown month name: ${text}\n`)
      month = m
    }
  } else if (operands.length === 2) {
    const m = parseMonth(operands[0])
    if (m === undefined) return fail(`cal: failed to parse timestamp or unknown month name: ${operands[0]}\n`)
    if (m < 1 || m > 12) return fail('cal: illegal month value: use 1-12\n')
    month = m
    year = parseYear(operands[1])
    if (Number.isNaN(year)) return fail(`cal: illegal year value: use 1-9999\n`)
    if (year < 0) year = ((year % 10000) + 10000) % 10000
    if (year < 1 || year > 9999) return fail('cal: illegal year value: use 1-9999\n')
  } else if (operands.length === 3) {
    day = Number(operands[0])
    const m = parseMonth(operands[1])
    if (m === undefined) return fail(`cal: failed to parse timestamp or unknown month name: ${operands[1]}\n`)
    if (m < 1 || m > 12) return fail('cal: illegal month value: use 1-12\n')
    month = m
    year = parseYear(operands[2])
    if (Number.isNaN(year) || year < 1 || year > 9999) return fail('cal: illegal year value: use 1-9999\n')
    if (!(day >= 1 && day <= 31)) return fail('cal: illegal day value: use 1-31\n')
  } else if (operands.length > 3) return fail("cal: too many arguments\nTry 'cal --help' for more information.\n")

  // which months, how many to a row
  let first = { month, year }
  let count = months ?? o.count
  let withYearInTitle = true
  let gutter = 2
  let perRow = 3
  if (o.twelve) { count = 12; gutter = 3 }
  else if (o.year) {
    count = 12
    first = { month: 1, year }
    withYearInTitle = false
    gutter = 3
  } else if (o.count === 3 && months === undefined) first = shift(first, -1)
  else if (o.span && count > 1) first = shift(first, -Math.floor(count / 2))
  if (o.julian) perRow = 3
  const title = o.year && !o.twelve ? String(year).padStart(4, '0') : undefined

  const blocks = []
  for (let n = 0; n < count; n++) {
    const at = shift(first, n)
    if (at.year < 0 || at.year > 10000) continue
    blocks.push(o.vertical ? verticalBlock(at.month, at.year, o, withYearInTitle) : monthBlock(at.month, at.year, o, withYearInTitle))
  }
  let text = ''
  if (blocks.length === 1 && !o.year && !o.twelve) {
    const single = blocks[0]
    if (o.vertical) text += verticalLines([single], 1, 0, o, false)
    else text += single.lines.join('\n') + '\n'
    return { out: text, err: '', status: 0 }
  }
  if (!o.vertical) {
    const width = blocks[0].width
    const rowWidth = perRow * width + (perRow - 1) * gutter
    if (title !== undefined) text += center(title, rowWidth).padEnd(rowWidth) + '\n\n'
    for (let start = 0; start < blocks.length; start += perRow) {
      const group = blocks.slice(start, start + perRow)
      const lineCount = group[0].lines.length
      for (let l = 0; l < lineCount; l++) {
        let line = group.map(b => b.lines[l]).join(' '.repeat(gutter))
        text += line + '\n'
      }
    }
    return { out: text, err: '', status: 0 }
  }
  const verticals = blocks
  if (title !== undefined) text += center(title, 62).padEnd(62) + '\n\n'
  for (let start = 0; start < verticals.length; start += perRow) text += verticalLines(verticals.slice(start, start + perRow), perRow, gutter, o, true) + (title !== undefined && start + perRow < verticals.length ? '\n' : '')
  return { out: text, err: '', status: 0 }
}

function shift({ month, year }, by) {
  const index = year * 12 + (month - 1) + by
  return { month: (((index % 12) + 12) % 12) + 1, year: Math.floor(index / 12) }
}

/** The lines of vertical months laid side by side: titles at column 4, a weekday label, then six week columns of three characters */
function verticalLines(group, perRow, gutter, o, multi) {
  const names = group[0].names
  let text = '    ' + group.map(b => b.title.padEnd(19)).join('') + '\n'
  for (let r = 0; r < 7; r++) text += names[r] + group.map(b => b.rows[r]).join(' ') + '\n'
  return text
}
