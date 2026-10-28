/**
 * `hostnamectl`: show or change the host name and what describes the machine. The static name is `/etc/hostname`, the
 * one boot gives the kernel; the transient name is the kernel's, `/proc/sys/kernel/hostname`; the pretty name, chassis,
 * deployment and location are `/etc/machine-info`. Setting any of them is root's. `set-hostname` sets both the static
 * and the transient name unless `--static` or `--transient` narrows it.
 */

import { getopt, tryHelp } from './lib/getopt.mjs'
import { reasonOf } from './lib/errno.mjs'
import { readTextFile } from './lib/fs-text.mjs'
import { machineName } from './lib/machine.mjs'

const { argv, env, exit, writeAll, open, close, geteuid, rename, O_WRONLY, O_CREAT, O_TRUNC } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(text.endsWith('\n') ? text : text + '\n'))

const usage = `hostnamectl [OPTIONS...] COMMAND ...

Query or change system hostname.

Commands:
  status                 Show current hostname settings
  hostname [NAME]        Get/set system hostname
  set-hostname NAME      Set system hostname
  icon-name [NAME]       Get/set icon name for host
  chassis [NAME]         Get/set chassis type for host
  deployment [NAME]      Get/set deployment environment for host
  location [NAME]        Get/set location for host

Options:
  -h --help              Show this help
     --version           Show package version
     --transient         Only set transient hostname
     --static            Only set static hostname
     --pretty            Only set pretty hostname
     --json=MODE         Output as JSON (pretty, short or off)`

const MACHINE_INFO = '/etc/machine-info'
const CHASSIS = ['desktop', 'laptop', 'convertible', 'server', 'tablet', 'handset', 'watch', 'embedded', 'vm', 'container']

const readOr = (path, fallback = '') => { try { return readTextFile(path) } catch { return fallback } }

function writeFile(path, text) {
  const temporary = `${path}.tmp`
  const fd = open(temporary, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
  try { writeAll(fd, encoder.encode(text)) } finally { close(fd) }
  rename(temporary, path)
}

/** `KEY=value` lines, quotes taken off */
function readInfo() {
  const info = {}
  for (const line of readOr(MACHINE_INFO).split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim())
    if (match) info[match[1]] = match[2].replace(/^"(.*)"$/, '$1').replace(/\\"/g, '"')
  }
  return info
}

function writeInfo(info) {
  const lines = Object.entries(info).filter(([, value]) => value !== '').map(([key, value]) => `${key}="${value.replace(/"/g, '\\"')}"`)
  writeFile(MACHINE_INFO, lines.length ? lines.join('\n') + '\n' : '')
}

/** `browser` in a page; on the Node host there is nothing to name */
const virtualization = () => /Node\.js/.test(String(globalThis.navigator?.userAgent ?? '')) ? null : 'browser'

const valid = name => name.length <= 64 && /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(name)

/** The pretty name as a host name: lowercase, spaces and other characters dropped or made dashes */
const cleaned = name => name.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'localhost'

const osRelease = () => {
  const fields = {}
  for (const line of readOr('/etc/os-release').split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line)
    if (match) fields[match[1]] = match[2].replace(/^"(.*)"$/, '$1')
  }
  return fields
}

async function status(json) {
  const info = readInfo()
  const staticName = readOr('/etc/hostname').trim()
  const transient = readOr('/proc/sys/kernel/hostname').trim()
  const os = osRelease()
  const release = env.KERNEL_VERSION || ''
  const chassis = info.CHASSIS || 'vm'
  const fields = {
    Hostname: transient || staticName,
    StaticHostname: staticName || null,
    PrettyHostname: info.PRETTY_HOSTNAME || null,
    IconName: info.ICON_NAME || `computer-${chassis}`,
    Chassis: chassis,
    Deployment: info.DEPLOYMENT || null,
    Location: info.LOCATION || null,
    KernelName: 'Linux',
    KernelRelease: release || null,
    OperatingSystemPrettyName: os.PRETTY_NAME || 'ecmaOS',
    OperatingSystemHomeURL: os.HOME_URL || null,
    MachineID: readOr('/etc/machine-id').trim() || null,
    BootID: readOr('/proc/sys/kernel/random/boot_id').trim().replace(/-/g, '') || null,
    Virtualization: virtualization()
  }
  if (json) { out((json === 'pretty' ? JSON.stringify(fields, null, '\t') : JSON.stringify(fields)) + '\n'); return 0 }
  const rows = [
    ['Static hostname', staticName || 'n/a'],
    ...(transient && transient !== staticName ? [['Transient hostname', transient]] : []),
    ...(info.PRETTY_HOSTNAME ? [['Pretty hostname', info.PRETTY_HOSTNAME]] : []),
    ['Icon name', fields.IconName],
    ['Chassis', chassis],
    ...(info.DEPLOYMENT ? [['Deployment', info.DEPLOYMENT]] : []),
    ...(info.LOCATION ? [['Location', info.LOCATION]] : []),
    ['Machine ID', fields.MachineID ?? 'n/a'],
    ['Boot ID', fields.BootID ?? 'n/a'],
    ...(fields.Virtualization ? [['Virtualization', fields.Virtualization]] : []),
    ['Operating System', fields.OperatingSystemPrettyName],
    ['Kernel', `Linux ${release}`.trim()],
    ['Architecture', (await machineName()).replace('_', '-')]
  ]
  const width = Math.max(...rows.map(([key]) => key.length))
  out(rows.map(([key, value]) => `${key.padStart(width)}: ${value}`).join('\n') + '\n')
  return 0
}

function setHostname(name, which) {
  if (geteuid() !== 0) { err('Could not set hostname: Access denied'); return 1 }
  const pretty = name !== cleaned(name) || !valid(name)
  const hostname = pretty ? cleaned(name) : name
  try {
    if (which.static) writeFile('/etc/hostname', `${hostname}\n`)
    if (which.transient) {
      const fd = open('/proc/sys/kernel/hostname', O_WRONLY | O_TRUNC)
      try { writeAll(fd, encoder.encode(`${hostname}\n`)) } finally { close(fd) }
    }
    if (which.pretty) {
      const info = readInfo()
      info.PRETTY_HOSTNAME = pretty ? name : ''
      writeInfo(info)
    }
  } catch (error) { err(`Could not set hostname: ${reasonOf(error)}`); return 1 }
  return 0
}

function infoField(key, value, check) {
  if (value === undefined) { out(`${readInfo()[key] ?? ''}\n`); return 0 }
  if (geteuid() !== 0) { err(`Could not set property: Access denied`); return 1 }
  if (check && value !== '' && !check(value)) { err(`Invalid value '${value}'.`); return 1 }
  const info = readInfo()
  info[key] = value
  try { writeInfo(info) } catch (error) { err(`Could not set property: ${reasonOf(error)}`); return 1 }
  return 0
}

async function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'h',
    long: { help: 'h', version: 'version', transient: 'transient', static: 'static', pretty: 'pretty', json: { key: 'json', arg: 'required' }, 'no-ask-password': 'ask' }
  })
  if (error) { err(`hostnamectl: ${error}`); err(tryHelp('hostnamectl')); return 1 }
  let json
  const only = {}
  for (const [key, value] of options) {
    if (key === 'h') { out(usage + '\n'); return 0 }
    if (key === 'version') { out('ecmaOS hostnamectl 1.0\n'); return 0 }
    if (key === 'json') json = value === 'off' ? undefined : value
    else if (key === 'transient' || key === 'static' || key === 'pretty') only[key] = true
  }
  const which = Object.keys(only).length ? only : { static: true, transient: true, pretty: true }
  const [command = 'status', value, extra] = operands
  if (extra !== undefined) { err('Too many arguments.'); return 1 }
  switch (command) {
    case 'status': return await status(json)
    case 'hostname':
      if (value === undefined) {
        const info = readInfo()
        out(`${which.pretty && !which.static && !which.transient ? info.PRETTY_HOSTNAME ?? '' : which.static && !which.transient ? readOr('/etc/hostname').trim() : readOr('/proc/sys/kernel/hostname').trim()}\n`)
        return 0
      }
      return setHostname(value, which)
    case 'set-hostname':
      if (value === undefined) { err('Too few arguments.'); return 1 }
      return setHostname(value, which)
    case 'icon-name': case 'set-icon-name': return infoField('ICON_NAME', value)
    case 'chassis': case 'set-chassis': return infoField('CHASSIS', value, name => CHASSIS.includes(name))
    case 'deployment': case 'set-deployment': return infoField('DEPLOYMENT', value)
    case 'location': case 'set-location': return infoField('LOCATION', value)
    default: err(`Unknown command verb '${command}'.`); return 1
  }
}

try {
  exit(await main())
} catch (error) {
  err(`hostnamectl: ${reasonOf(error)}`)
  exit(1)
}
