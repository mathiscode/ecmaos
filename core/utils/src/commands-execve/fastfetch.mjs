/** Print a logo and a summary of the system. `neofetch` is the same program. */

import { readTextFile } from './lib/fs-text.mjs'
import { isTty } from './lib/tty.mjs'

const { argv, env, exit, writeAll } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(text + '\n'))

const usage = `Usage: fastfetch [--no-color] [--no-logo]
Show the system at a glance.

  --no-color  no colors, even on a terminal
  --no-logo   print the facts only
  --help      display this help and exit

Everything shown comes from /etc/os-release, /proc and the environment; a line is left out when it is not known.`

const LOGO = [
  ' ___ ___ __  __   _    ___  ___ ',
  '| __/ __|  \\/  | /_\\  / _ \\/ __|',
  '| _| (__| |\\/| |/ _ \\| (_) \\__ \\',
  '|___\\___|_|  |_/_/ \\_\\\\___/|___/'
]

const tryRead = path => { try { return readTextFile(path) } catch { return '' } }

function uptime() {
  const seconds = Number(tryRead('/proc/uptime').split(' ')[0])
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const d = Math.floor(seconds / 86400), h = Math.floor(seconds % 86400 / 3600), m = Math.floor(seconds % 3600 / 60)
  return [d && `${d} day${d === 1 ? '' : 's'}`, h && `${h} hour${h === 1 ? '' : 's'}`, `${m} min${m === 1 ? '' : 's'}`].filter(Boolean).join(', ')
}

function memory() {
  const info = {}
  for (const line of tryRead('/proc/meminfo').split('\n')) {
    const match = /^(\w+):\s*(\d+) kB/.exec(line)
    if (match) info[match[1]] = Number(match[2])
  }
  const mib = kb => `${Math.round(kb / 1024)} MiB`
  // MemAvailable is what is left of the tab's own heap limit, not of the machine's memory, so the two are not subtracted
  if (info.MemTotal && info.MemAvailable !== undefined) return `${mib(info.MemAvailable)} available to this tab (${mib(info.MemTotal)} in the device)`
  if (info.MemAvailable !== undefined) return `${mib(info.MemAvailable)} available to this tab`
  if (info.MemTotal) return `${mib(info.MemTotal)} in the device`
  return ''
}

/** `Chrome/126.0` from a user agent string: Edge, Firefox, then Chrome, then Safari, since Chrome's own string also says Safari. */
function browserName(agent) {
  for (const [token, name] of [['Edg/', 'Edge'], ['Firefox/', 'Firefox'], ['Chrome/', 'Chrome'], ['Version/', 'Safari']]) {
    const at = agent.indexOf(token)
    if (at >= 0) return `${name} ${agent.slice(at + token.length).split(/[ ;)]/)[0]}`
  }
  return ''
}

function main() {
  const args = argv.slice(1)
  if (args.includes('--help') || args.includes('-h')) { globalThis.ecmaosSyscalls.writeAll(1, new TextEncoder().encode(usage + '\n')); return 0 }
  const unknown = args.find(arg => arg !== '--no-color' && arg !== '--no-logo')
  if (unknown) { err(`fastfetch: unknown option '${unknown}'`); err("Try 'fastfetch --help' for more information."); return 1 }

  const color = !args.includes('--no-color') && isTty(1) && env?.TERM !== 'dumb'
  const paint = (codes, text) => color ? `\x1b[${codes}m${text}\x1b[0m` : text

  const release = {}
  for (const line of tryRead('/etc/os-release').split('\n')) {
    const match = /^(\w+)=(.*)$/.exec(line)
    if (match) release[match[1]] = match[2].replace(/^"|"$/g, '')
  }
  const cores = tryRead('/proc/cpuinfo').split('\n\n').filter(Boolean).length
  const hostname = tryRead('/etc/hostname').trim() || env?.HOSTNAME || 'localhost'
  const user = env?.USER ?? 'unknown'

  const facts = [
    ['OS', release.PRETTY_NAME],
    ['Kernel', tryRead('/proc/version').split(' (')[0].replace(/ version /, ' ').trim()],
    ['Uptime', uptime()],
    ['Shell', env?.SHELL ? env.SHELL.split('/').pop() : ''],
    ['Terminal', env?.TERM],
    ['CPU', cores ? `${cores} core${cores === 1 ? '' : 's'} (browser)` : ''],
    ['Memory', memory()],
    ['Browser', browserName(tryRead('/proc/userAgent').trim())],
    ['Platform', tryRead('/proc/platform').trim()]
  ].filter(([, value]) => value)

  const title = `${paint('1;36', user)}@${paint('1;36', hostname)}`
  const lines = [title, '-'.repeat(user.length + hostname.length + 1), ...facts.map(([key, value]) => `${paint('1;36', key)}: ${value}`)]
  const noLogo = args.includes('--no-logo')
  const rows = Math.max(lines.length, noLogo ? 0 : LOGO.length)
  let text = ''
  for (let i = 0; i < rows; i++) {
    const logo = noLogo ? '' : paint('36', LOGO[i] ?? ' '.repeat(LOGO[0].length)) + '  '
    text += `${logo}${lines[i] ?? ''}\n`
  }
  writeAll(1, encoder.encode(text))
  return 0
}

try {
  exit(main())
} catch (error) {
  err(`fastfetch: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
