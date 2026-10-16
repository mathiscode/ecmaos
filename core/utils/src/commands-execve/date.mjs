/**
 * Print the date and time, as GNU `date` does: the current time or `-d STRING` / `-r FILE`, in local time or `-u`,
 * through a `+FORMAT` (every strftime conversion, with flags and widths), `-I[FMT]`, `-R` or `--rfc-3339=FMT`.
 * Setting the clock is refused: a browser cannot change it. The zone is the host's, or UTC when `TZ` names it.
 */

import { getopt, tryHelp } from './lib/getopt.mjs'
import { parseDate, useUtc } from './lib/datespec.mjs'
import { readFileBytes } from './lib/bytes.mjs'
import { strftime } from './lib/strftime.mjs'
import { resolve } from './lib/path-utils.mjs'
import { reasonOf, quotef } from './lib/errno.mjs'

const sys = globalThis.ecmaosSyscalls
const { argv, exit, writeAll, getcwd, env } = sys

const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`date: ${text}\n`))
const hint = () => writeAll(2, encoder.encode(tryHelp('date') + '\n'))

const usage = `Usage: date [OPTION]... [+FORMAT]
  or:  date [-u|--utc|--universal] [MMDDhhmm[[CC]YY][.ss]]
Display date and time in the given FORMAT.

  -d, --date=STRING         display time described by STRING, not 'now'
  -I[FMT], --iso-8601[=FMT] output date/time in ISO 8601 format; FMT='date', 'hours', 'minutes', 'seconds' or 'ns'
  -r, --reference=FILE      display the last modification time of FILE
  -R, --rfc-email           output date and time in RFC 5322 format
      --rfc-3339=FMT        output date and time in RFC 3339 format; FMT='date', 'seconds' or 'ns'
  -s, --set=STRING          set time described by STRING (not possible here)
  -u, --utc, --universal    print Coordinated Universal Time (UTC)
      --help                display this help and exit`

const UTC_NAMES = /^(UTC|GMT|UCT|Z|Etc\/UTC|Etc\/GMT)(0|\+0|-0)?$/

function zoneName(ms, utc) {
  if (utc) return 'UTC'
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(new Date(ms)).find(p => p.type === 'timeZoneName')
    return part?.value ?? 'UTC'
  } catch { return 'UTC' }
}

const ISO = {
  date: '%Y-%m-%d', hours: '%Y-%m-%dT%H%:z', minutes: '%Y-%m-%dT%H:%M%:z', seconds: '%Y-%m-%dT%H:%M:%S%:z', ns: '%Y-%m-%dT%H:%M:%S,%N%:z'
}
const RFC3339 = { date: '%Y-%m-%d', seconds: '%Y-%m-%d %H:%M:%S%:z', ns: '%Y-%m-%d %H:%M:%S.%N%:z' }

async function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'd:f:r:s:uI::R',
    long: {
      date: { key: 'd', arg: 'required' }, file: { key: 'f', arg: 'required' }, reference: { key: 'r', arg: 'required' }, set: { key: 's', arg: 'required' },
      utc: 'u', universal: 'u', 'iso-8601': { key: 'I', arg: 'optional' }, 'rfc-email': 'R', 'rfc-2822': 'R', 'rfc-3339': { key: '3', arg: 'required' }, help: 'help', version: 'version'
    }
  })
  if (error) { err(error); hint(); return 1 }
  let utc = false, string, reference, iso, rfc, rfc3339, setting, listFile
  for (const [key, value] of options) {
    if (key === 'help') { out(usage + '\n'); return 0 }
    else if (key === 'u') utc = true
    else if (key === 'd') string = value
    else if (key === 'f') listFile = value
    else if (key === 'version') { out('date (ecmaOS coreutils) 1.0\n'); return 0 }
    else if (key === 'r') reference = value
    else if (key === 's') setting = value
    else if (key === 'I') iso = value === true ? 'date' : value
    else if (key === 'R') rfc = true
    else if (key === '3') rfc3339 = value
  }
  if (iso !== undefined && !(iso in ISO)) { err(`invalid argument '${iso}' for '--iso-8601'`); hint(); return 1 }
  if (rfc3339 !== undefined && !(rfc3339 in RFC3339)) { err(`invalid argument '${rfc3339}' for '--rfc-3339'`); hint(); return 1 }
  const formats = operands.filter(o => o.startsWith('+'))
  const others = operands.filter(o => !o.startsWith('+'))
  if (operands.length > 1 || (others.length > 0 && formats.length === 0 && string === undefined && others.length > 1)) {
    err(`extra operand '${operands[1] ?? others[0]}'`)
    hint()
    return 1
  }
  if (setting !== undefined || others.length > 0) {
    if (setting !== undefined && Number.isNaN(parseDate(setting))) { err(`invalid date '${setting}'`); return 1 }
    err('cannot set date: Operation not permitted')
    return 1
  }
  if ([string, reference, listFile].filter(v => v !== undefined).length > 1) { err('the options to specify dates for printing are mutually exclusive'); hint(); return 1 }
  if ([iso, rfc ? 1 : undefined, rfc3339, formats[0]].filter(v => v !== undefined).length > 1) {
    err('multiple output formats specified')
    hint()
    return 1
  }

  if (!utc && env?.TZ !== undefined && UTC_NAMES.test(env.TZ)) utc = true
  useUtc(utc)
  const now = Date.now()
  let ms = now
  if (string !== undefined) {
    ms = parseDate(string, now)
    if (Number.isNaN(ms)) { err(`invalid date '${string}'`); return 1 }
  } else if (reference !== undefined) {
    try {
      const { stat: fstat } = sys
      ms = fstat(resolve(getcwd(), reference)).mtimeMs
    } catch (error) {
      err(`${quotef(reference)}: ${reasonOf(error)}`)
      return 1
    }
  }

  let format
  if (formats.length > 0) format = formats[0].slice(1)
  else if (iso !== undefined) format = ISO[iso]
  else if (rfc) format = '%a, %d %b %Y %H:%M:%S %z'
  else if (rfc3339 !== undefined) format = RFC3339[rfc3339]
  else format = '%a %b %e %H:%M:%S %Z %Y'
  const show = at => out(strftime(format, { ms: at, utc, zone: zoneName(at, utc) }) + '\n')
  if (listFile !== undefined) {
    let text
    try { text = new TextDecoder().decode(readFileBytes(resolve(getcwd(), listFile))) } catch (error) { err(`${quotef(listFile)}: ${reasonOf(error)}`); return 1 }
    let status = 0
    for (const line of text.split('\n').filter((line, index, all) => index < all.length - 1 || line !== '')) {
      const at = parseDate(line, now)
      if (Number.isNaN(at)) { err(`invalid date '${line}'`); status = 1 } else show(at)
    }
    return status
  }
  show(ms)
  return 0
}

try {
  exit(await main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
