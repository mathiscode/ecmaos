/**
 * `timedatectl`: show the clock and the zone, and set the zone. The clock is the browser's, which only its host sets,
 * so `set-time`, `set-ntp` and `set-local-rtc` are refused and whether it is synchronized is not known here. The zone is
 * `/etc/timezone`; `set-timezone` (root) writes it and gives the kernel's shells the zone's `TZ`, so programs started
 * from then on use it, and a login shell started earlier keeps the `TZ` it has. `list-timezones` is every zone the
 * browser's `Intl` knows.
 */

import { getopt, tryHelp } from './lib/getopt.mjs'
import { reasonOf } from './lib/errno.mjs'
import { readTextFile } from './lib/fs-text.mjs'
import { zoneAt } from './lib/tz.mjs'

const { argv, exit, writeAll, geteuid, custom } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(text.endsWith('\n') ? text : text + '\n'))

const usage = `timedatectl [OPTIONS...] COMMAND ...

Query or change system time and date settings.

Commands:
  status                   Show current time settings
  show                     Show properties of systemd-timedated
  set-time TIME            Set system time
  set-timezone ZONE        Set system time zone
  list-timezones           Show known time zones
  set-local-rtc BOOL       Control whether RTC is in local time
  set-ntp BOOL             Enable or disable network time synchronization
  timesync-status          Show status of systemd-timesyncd

Options:
  -h --help                Show this help message
     --version             Show package version
  -p --property=NAME       Show only properties by this name
  -a --all                 Show all properties, including empty ones
     --value               When showing properties, only print the value
     --no-pager            Do not pipe output into a pager`

const browserZone = () => new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
const systemZone = () => { try { return readTextFile('/etc/timezone').trim() || browserZone() } catch { return browserZone() } }

const pad = n => String(n).padStart(2, '0')
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** `Tue 2026-10-27 15:04:05 CDT`, in `zone` (or UTC) */
function stamp(ms, zone) {
  const info = zone ? zoneAt(ms, zone) : { offset: 0, abbr: 'UTC' }
  const d = new Date(ms + (info?.offset ?? 0) * 60000)
  return `${DAYS[d.getUTCDay()]} ${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${info?.abbr ?? 'UTC'}`
}

const offsetText = minutes => `${minutes < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(minutes) / 60))}${pad(Math.abs(minutes) % 60)}`

function status() {
  const now = Date.now()
  const zone = systemZone()
  const info = zoneAt(now, zone) ?? { offset: 0, abbr: 'UTC' }
  const rows = [
    ['Local time', stamp(now, zone)],
    ['Universal time', stamp(now)],
    ['RTC time', stamp(now).replace(/ UTC$/, '')],
    ['Time zone', `${zone} (${info.abbr}, ${offsetText(info.offset)})`],
    ['System clock synchronized', 'n/a'],
    ['NTP service', 'n/a'],
    ['RTC in local TZ', 'no']
  ]
  const width = Math.max(...rows.map(([key]) => key.length))
  out(rows.map(([key, value]) => `${key.padStart(width)}: ${value}`).join('\n') + '\n')
  return 0
}

function zones() {
  try { return Intl.supportedValuesOf('timeZone').concat('UTC') } catch { return ['UTC'] }
}

function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'hp:aH:M:',
    long: { help: 'h', version: 'version', property: { key: 'p', arg: 'required' }, all: 'a', value: 'value', 'no-pager': 'no-pager', 'no-ask-password': 'ask', 'adjust-system-clock': 'adjust', monitor: 'monitor', host: { key: 'H', arg: 'required' }, machine: { key: 'M', arg: 'required' } }
  })
  if (error) { err(`timedatectl: ${error}`); err(tryHelp('timedatectl')); return 1 }
  const properties = []
  let value = false
  for (const [key, given] of options) {
    if (key === 'h') { out(usage + '\n'); return 0 }
    if (key === 'version') { out('ecmaOS timedatectl 1.0\n'); return 0 }
    if (key === 'p') properties.push(...given.split(','))
    else if (key === 'value') value = true
    else if (key === 'H' || key === 'M') { err('Cannot connect to another machine: there is one here'); return 1 }
  }
  const [command = 'status', ...rest] = operands
  switch (command) {
    case 'status': return status()
    case 'show': {
      const now = Date.now()
      const props = { Timezone: systemZone(), LocalRTC: 'no', CanNTP: 'no', NTP: 'no', NTPSynchronized: 'no', TimeUSec: stamp(now, systemZone()), RTCTimeUSec: stamp(now, systemZone()) }
      const keys = properties.length ? properties.filter(key => key in props) : Object.keys(props)
      out(keys.map(key => value ? props[key] : `${key}=${props[key]}`).join('\n') + '\n')
      return 0
    }
    case 'list-timezones':
      out(zones().join('\n') + '\n')
      return 0
    case 'set-timezone': {
      const zone = rest[0]
      if (!zone) { err('Too few arguments.'); return 1 }
      if (geteuid() !== 0) { err('Failed to set time zone: Access denied'); return 1 }
      return custom('tz_set', zone).then(() => 0, e => {
        err(`Failed to set time zone: ${/EINVAL|Invalid/.test(`${e?.code} ${e?.message}`) ? `Invalid or not installed time zone '${zone}'` : reasonOf(e)}`)
        return 1
      })
    }
    case 'set-time':
      if (!rest[0]) { err('Too few arguments.'); return 1 }
      err('Failed to set time: the clock is the browser\'s, which only its host can set')
      return 1
    case 'set-ntp':
      if (!rest[0]) { err('Too few arguments.'); return 1 }
      err('Failed to set ntp: the host keeps the browser\'s clock; there is no time service to start here')
      return 1
    case 'set-local-rtc':
      if (!rest[0]) { err('Too few arguments.'); return 1 }
      if (/^(0|no|false|off)$/i.test(rest[0])) return 0
      err('Failed to set local RTC: the clock here is kept in UTC')
      return 1
    case 'timesync-status': case 'show-timesync':
      err('Failed to query server: there is no systemd-timesyncd here; the host keeps the clock')
      return 1
    default:
      err(`Unknown command verb '${command}'.`)
      return 1
  }
}

try {
  exit(await main())
} catch (error) {
  err(`timedatectl: ${reasonOf(error)}`)
  exit(1)
}
