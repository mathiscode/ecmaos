/**
 * `journalctl`: query the system log. The entries are `/var/log/messages` and the kernel log (see `lib/journal.mjs`):
 * there is no binary journal, so matching is on what those lines keep, the tag (`-t`, and `-u` through the identifiers
 * a unit logs under and init's messages about it), the pid (`_PID=`) and the time, and priorities (`-p`) are known only
 * for the kernel's entries (the others count as info). The output pages when it goes to a terminal, unless `-f`.
 */

import { getopt, tryHelp } from './lib/getopt.mjs'
import { reasonOf } from './lib/errno.mjs'
import { readTextFile } from './lib/fs-text.mjs'
import { pagerTty } from './lib/tty.mjs'
import { page } from './lib/pager.mjs'
import { parseDate } from './lib/datespec.mjs'
import { bootTime, formatShort, KERNEL_LOG, MESSAGES, parseKernelLog, parseMessages, readJournal, unitMatcher } from './lib/journal.mjs'
import { STATE_FILE, unitName } from '../lib/unit-file.ts'

const { argv, exit, writeAll, open, read, close, stat, O_RDONLY } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(text.endsWith('\n') ? text : text + '\n'))

const usage = `journalctl [OPTIONS...] [MATCHES...]

Query the journal.

Options:
  -S --since=DATE            Show entries not older than the specified date
  -U --until=DATE            Show entries not newer than the specified date
  -b --boot[=ID]             Show current boot or the specified boot
  -u --unit=UNIT             Show logs from the specified unit
  -t --identifier=STRING     Show entries with the specified syslog identifier
  -p --priority=RANGE        Show entries with the specified priority
  -g --grep=PATTERN          Show entries with MESSAGE matching PATTERN
     --case-sensitive[=BOOL] Force case sensitive or insensitive matching
  -k --dmesg                 Show kernel message log from the current boot
  -e --pager-end             Immediately jump to the end in the pager
  -f --follow                Follow the journal
  -n --lines[=INTEGER]       Number of journal entries to show
  -r --reverse               Show the newest entries first
  -o --output=STRING         Change journal output mode (short, short-iso,
                             short-precise, short-unix, cat, json, json-pretty)
     --utc                   Express time in Coordinated Universal Time
  -x --catalog               Add message explanations where available
     --no-pager              Do not pipe output into a pager
  -q --quiet                 Do not show info messages and privilege warning
     --list-boots            Show terse information about recorded boots
     --disk-usage            Show total disk usage of all journal files
  -h --help                  Show this help text
     --version               Show package version

Matches: _PID=PID, SYSLOG_IDENTIFIER=ID, _SYSTEMD_UNIT=UNIT, _TRANSPORT=kernel`

const PRIORITIES = { emerg: 0, alert: 1, crit: 2, err: 3, warning: 4, notice: 5, info: 6, debug: 7 }
const priorityOf = text => /^[0-7]$/.test(text) ? Number(text) : PRIORITIES[text]

/** journalctl's own time words: `today` and `yesterday` are midnight, `-1h` and `+30min` are from now */
function parseTime(text, now = Date.now()) {
  const trimmed = text.trim().toLowerCase()
  const midnight = days => { const d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + days); return d.getTime() }
  if (trimmed === 'today') return midnight(0)
  if (trimmed === 'yesterday') return midnight(-1)
  if (trimmed === 'tomorrow') return midnight(1)
  if (trimmed === 'now') return now
  const relative = /^([-+])(\d+)\s*(s|sec|m|min|h|hour|d|day|w|week)s?$/.exec(trimmed)
  if (relative) {
    const size = { s: 1, sec: 1, m: 60, min: 60, h: 3600, hour: 3600, d: 86400, day: 86400, w: 604800, week: 604800 }[relative[3]]
    return now + (relative[1] === '-' ? -1 : 1) * Number(relative[2]) * size * 1000
  }
  return parseDate(text, now)
}

const pad = (n, width = 2) => String(n).padStart(width, '0')

function isoTime(ms, utc) {
  const d = new Date(ms)
  if (utc) return d.toISOString().replace(/\.\d{3}Z$/, '+0000')
  const offset = -d.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(Math.abs(offset) / 60))}${pad(Math.abs(offset) % 60)}`
}

function format(entry, mode, utc) {
  const source = `${entry.host} ${entry.tag ? `${entry.tag}${entry.pid !== undefined ? `[${entry.pid}]` : ''}: ` : ''}`
  if (mode === 'cat') return entry.message
  if (mode === 'short-iso') return `${isoTime(entry.time, utc)} ${source}${entry.message}`
  if (mode === 'short-unix') return `${(entry.time / 1000).toFixed(6)} ${source}${entry.message}`
  if (mode === 'short-precise') {
    const d = new Date(entry.time)
    return `${formatShort(entry).slice(0, 15)}.${pad(d.getMilliseconds(), 3)}000 ${source}${entry.message}`
  }
  if (mode === 'json' || mode === 'json-pretty') {
    const record = {
      __REALTIME_TIMESTAMP: String(entry.time * 1000), _HOSTNAME: entry.host, PRIORITY: String(entry.level), MESSAGE: entry.message,
      ...(entry.kernel ? { _TRANSPORT: 'kernel', SYSLOG_IDENTIFIER: 'kernel' } : { _TRANSPORT: 'syslog', SYSLOG_IDENTIFIER: entry.tag }),
      ...(entry.pid !== undefined ? { _PID: String(entry.pid), SYSLOG_PID: String(entry.pid) } : {})
    }
    return mode === 'json' ? JSON.stringify(record) : JSON.stringify(record, null, '\t')
  }
  if (utc) {
    const d = new Date(entry.time)
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    return `${months[d.getUTCMonth()]} ${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${source}${entry.message}`
  }
  return formatShort(entry)
}

/** `-n 20` as `-n20`: the count is optional, and a separate number after it is the count */
function joinCounts(args) {
  const joined = []
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-n' || args[i] === '--lines') && /^\+?\d+$|^all$/.test(args[i + 1] ?? '')) joined.push(`${args[i] === '-n' ? '-n' : '--lines='}${args[++i]}`)
    else joined.push(args[i])
  }
  return joined
}

const hostname = () => {
  try { return readTextFile('/proc/sys/kernel/hostname').trim() || 'localhost' } catch { return 'localhost' }
}

async function main() {
  const { options, operands, error } = getopt(joinCounts(argv.slice(1)), {
    short: 'S:U:b::u:t:p:g:kefn::ro:xqhaml',
    long: {
      since: { key: 'S', arg: 'required' }, until: { key: 'U', arg: 'required' }, boot: { key: 'b', arg: 'optional' }, unit: { key: 'u', arg: 'required' },
      identifier: { key: 't', arg: 'required' }, priority: { key: 'p', arg: 'required' }, grep: { key: 'g', arg: 'required' }, 'case-sensitive': { key: 'case', arg: 'optional' },
      dmesg: 'k', 'pager-end': 'e', follow: 'f', lines: { key: 'n', arg: 'optional' }, reverse: 'r', output: { key: 'o', arg: 'required' }, utc: 'utc', catalog: 'x',
      'no-pager': 'no-pager', quiet: 'q', 'list-boots': 'list-boots', 'disk-usage': 'disk-usage', help: 'h', version: 'version', all: 'a', merge: 'm', full: 'l',
      'no-hostname': 'no-hostname', system: 'system', user: 'user', 'vacuum-size': { key: 'vacuum', arg: 'required' }, 'vacuum-time': { key: 'vacuum', arg: 'required' }, 'vacuum-files': { key: 'vacuum', arg: 'required' }, rotate: 'rotate', flush: 'flush', sync: 'flush'
    }
  })
  if (error) { err(`journalctl: ${error}`); err(tryHelp('journalctl')); return 1 }
  const units = []
  const identifiers = []
  const pids = []
  let kernelOnly = false
  let since
  let until
  let lines
  let follow = false
  let reverse = false
  let mode = 'short'
  let utc = false
  let noPager = false
  let grep
  let caseSensitive
  let maxPriority = 7
  let minPriority = 0
  let boot = false
  for (const [key, value] of options) {
    if (key === 'h') { out(usage + '\n'); return 0 }
    if (key === 'version') { out('ecmaOS journalctl 1.0 (the journal is /var/log/messages and the kernel log)\n'); return 0 }
    if (key === 'u') units.push(unitName(value))
    else if (key === 't') identifiers.push(value)
    else if (key === 'k') { kernelOnly = true; boot = true }
    else if (key === 'b') {
      if (value !== true && !/^(0|-0|\+?0)$/.test(value) && value !== 'all') { err(`Data from the specified boot (${value}) is not available: No such boot ID in journal`); return 1 }
      boot = value !== 'all'
    } else if (key === 'S' || key === 'U') {
      const ms = parseTime(value)
      if (Number.isNaN(ms)) { err(`Failed to parse timestamp: ${value}`); return 1 }
      if (key === 'S') since = ms
      else until = ms
    } else if (key === 'n') {
      if (value === true) lines = 10
      else if (value === 'all') lines = Infinity
      else if (/^\+?\d+$/.test(value)) lines = Number(value.replace('+', ''))
      else { err(`Failed to parse lines '${value}'`); return 1 }
    } else if (key === 'f') follow = true
    else if (key === 'r') reverse = true
    else if (key === 'o') {
      if (!['short', 'short-iso', 'short-precise', 'short-unix', 'short-full', 'cat', 'json', 'json-pretty', 'verbose', 'with-unit'].includes(value)) { err(`Unknown output format '${value}'.`); return 1 }
      mode = value === 'verbose' || value === 'with-unit' || value === 'short-full' ? 'short' : value
    } else if (key === 'utc') utc = true
    else if (key === 'no-pager') noPager = true
    else if (key === 'g') grep = value
    else if (key === 'case') caseSensitive = value === true ? true : !/^(0|no|false|off)$/i.test(value)
    else if (key === 'p') {
      const [high, low] = value.split('..')
      const a = priorityOf(high)
      const b = low === undefined ? undefined : priorityOf(low)
      if (a === undefined || (low !== undefined && b === undefined)) { err(`Failed to parse priority value: ${value}`); return 1 }
      if (b === undefined) { minPriority = 0; maxPriority = a } else { minPriority = Math.min(a, b); maxPriority = Math.max(a, b) }
    } else if (key === 'user') { err('No journal files were found: there is no per-user journal here.'); return 1 }
    else if (key === 'list-boots') {
      const start = bootTime()
      out(`IDX BOOT ID                          FIRST ENTRY                 LAST ENTRY\n  0 ${(readTextFile('/proc/sys/kernel/random/boot_id').trim() || '-').replace(/-/g, '')} ${new Date(start).toString().slice(0, 24)} ${new Date().toString().slice(0, 24)}\n`)
      return 0
    } else if (key === 'disk-usage') {
      const size = [MESSAGES, `${MESSAGES}.1`, KERNEL_LOG, `${KERNEL_LOG}.1`].reduce((sum, path) => { try { return sum + stat(path).size } catch { return sum } }, 0)
      out(`Archived and active journals take up ${size >= 1048576 ? `${(size / 1048576).toFixed(1)}M` : `${(size / 1024).toFixed(1)}K`} in the file system.\n`)
      return 0
    } else if (key === 'vacuum' || key === 'rotate' || key === 'flush') {
      if (key === 'vacuum') err('Vacuuming done, freed 0B of archived journals from /var/log: the logs rotate on their own at 1 MiB.')
      return 0
    }
  }
  for (const match of operands) {
    const [field, value = ''] = match.split('=')
    if (field === '_PID' && /^\d+$/.test(value)) pids.push(Number(value))
    else if (field === 'SYSLOG_IDENTIFIER') identifiers.push(value)
    else if (field === '_SYSTEMD_UNIT' || field === 'UNIT') units.push(unitName(value))
    else if (field === '_TRANSPORT' && value === 'kernel') kernelOnly = true
    else if (match === '+') continue
    else if (match.startsWith('/')) { err(`'${match}' is not a match: a journal of a program's entries cannot be told from these logs; try -t NAME`); return 1 }
    else { err(`Failed to add match '${match}': Invalid argument`); return 1 }
  }

  const host = hostname()
  const denied = new Set()
  const unitState = (() => { try { return JSON.parse(readTextFile(STATE_FILE)).units ?? {} } catch { return {} } })()
  const unitMatches = units.map(unit => unitMatcher(unit, unitState[unit]?.Identifiers ?? []))
  const regex = grep !== undefined ? new RegExp(grep, (caseSensitive ?? grep !== grep.toLowerCase()) ? '' : 'i') : undefined
  const fromBoot = boot ? bootTime() : undefined

  const wanted = entry => {
    if (kernelOnly && !entry.kernel) return false
    if (fromBoot !== undefined && entry.time < fromBoot - 1000) return false
    if (since !== undefined && entry.time < since) return false
    if (until !== undefined && entry.time > until) return false
    if (entry.level > maxPriority || entry.level < minPriority) return false
    if (regex && !regex.test(entry.message)) return false
    const anyOf = [
      ...(units.length ? [unitMatches.some(match => match(entry))] : []),
      ...(identifiers.length ? [identifiers.includes(entry.kernel ? 'kernel' : entry.tag)] : []),
      ...(pids.length ? [entry.pid !== undefined && pids.includes(entry.pid)] : [])
    ]
    return anyOf.length === 0 || anyOf.some(Boolean)
  }

  let entries = readJournal({ kernel: true, syslog: !kernelOnly, host, denied }).filter(wanted)
  if (entries.length === 0 && denied.size && !follow) {
    err('No journal files were opened due to insufficient permissions.')
    return 1
  }
  if (lines === undefined && follow) lines = 10
  if (lines !== undefined && lines !== Infinity) entries = entries.slice(Math.max(0, entries.length - lines))
  if (reverse) entries.reverse()
  const text = entries.map(entry => format(entry, mode, utc))

  if (!follow) {
    if (text.length === 0) {
      if (mode !== 'cat' && !options.some(([key]) => key === 'q')) out('-- No entries --\n')
      return 0
    }
    const tty = noPager ? -1 : pagerTty()
    if (tty < 0) out(text.join('\n') + '\n')
    else await page(text, tty, 'journalctl')
    return 0
  }

  if (text.length) out(text.join('\n') + '\n')
  // follow: read what is added to each file as it grows; a smaller file has been rotated and is read again from its start
  const sources = [
    { path: MESSAGES, parse: chunk => parseMessages(chunk), kernel: false },
    { path: KERNEL_LOG, parse: chunk => parseKernelLog(chunk, host), kernel: true }
  ].filter(source => !(kernelOnly && !source.kernel)).map(source => ({ ...source, offset: (() => { try { return stat(source.path).size } catch { return 0 } })(), rest: '' }))
  const decoder = new TextDecoder()
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, 500))
    const fresh = []
    for (const source of sources) {
      let size
      try { size = stat(source.path).size } catch { continue }
      if (size < source.offset) { source.offset = 0; source.rest = '' }
      if (size === source.offset) continue
      let fd
      try { fd = open(source.path, O_RDONLY) } catch { continue }
      try {
        const buffer = new Uint8Array(size - source.offset)
        let at = 0
        while (at < buffer.length) {
          const n = read(fd, buffer.subarray(at), source.offset + at)
          if (n <= 0) break
          at += n
        }
        source.offset += at
        const chunk = source.rest + decoder.decode(buffer.subarray(0, at))
        const cut = chunk.lastIndexOf('\n')
        source.rest = cut === -1 ? chunk : chunk.slice(cut + 1)
        if (cut !== -1) fresh.push(...source.parse(chunk.slice(0, cut + 1)))
      } finally { close(fd) }
    }
    const shown = fresh.filter(wanted).sort((a, b) => a.time - b.time)
    if (shown.length) out(shown.map(entry => format(entry, mode, utc)).join('\n') + '\n')
  }
}

try {
  exit(await main())
} catch (error) {
  err(`journalctl: ${reasonOf(error)}`)
  exit(1)
}
