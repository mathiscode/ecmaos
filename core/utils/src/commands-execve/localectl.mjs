/**
 * `localectl`: show and set the system locale, `LANG` (and any `LC_*`) in `/etc/default/locale`, which boot reads; the
 * kernel's own messages change language at the next boot, programs see it in a new login's environment. The keyboard
 * layout is the host's, so the keymap commands are refused.
 */

import { getopt, tryHelp } from './lib/getopt.mjs'
import { reasonOf } from './lib/errno.mjs'
import { isLocale, LOCALE_FILE, supportedLocales, systemLocale } from './lib/locales.mjs'

const { argv, exit, writeAll, open, close, geteuid, rename, O_WRONLY, O_CREAT, O_TRUNC } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(text.endsWith('\n') ? text : text + '\n'))

const usage = `localectl [OPTIONS...] COMMAND ...

Query or change system locale and keyboard settings.

Commands:
  status                   Show current locale settings
  set-locale LOCALE...     Set system locale
  list-locales             Show known locales
  set-keymap MAP [MAP]     Set console and X11 keyboard mappings
  list-keymaps             Show known virtual console keyboard mappings
  set-x11-keymap LAYOUT [MODEL [VARIANT [OPTIONS]]]
                           Set X11 and console keyboard mappings

Options:
  -h --help                Show this help
     --version             Show package version
     --no-pager            Do not pipe output into a pager`

const CATEGORIES = ['LANG', 'LANGUAGE', 'LC_CTYPE', 'LC_NUMERIC', 'LC_TIME', 'LC_COLLATE', 'LC_MONETARY', 'LC_MESSAGES', 'LC_PAPER', 'LC_NAME', 'LC_ADDRESS', 'LC_TELEPHONE', 'LC_MEASUREMENT', 'LC_IDENTIFICATION']

function status() {
  const settings = systemLocale()
  const lines = Object.entries(settings).map(([key, value]) => `${key}=${value}`)
  out(`System Locale: ${lines.length ? lines.join('\n               ') : 'n/a'}\n    VC Keymap: (unset)\n   X11 Layout: (unset)\n`)
  return 0
}

function setLocale(assignments) {
  if (geteuid() !== 0) { err('Failed to issue method call: Access denied'); return 1 }
  if (assignments.length === 0) { err('Too few arguments.'); return 1 }
  const settings = {}
  for (const assignment of assignments) {
    // a bare locale is LANG's, as localectl takes it
    const [key, value] = assignment.includes('=') ? [assignment.slice(0, assignment.indexOf('=')), assignment.slice(assignment.indexOf('=') + 1)] : ['LANG', assignment]
    if (!CATEGORIES.includes(key)) { err(`Failed to issue method call: Invalid locale assignment: ${assignment}`); return 1 }
    if (key !== 'LANGUAGE' && !isLocale(value)) { err(`Failed to issue method call: Locale ${value} not installed, refusing.`); return 1 }
    settings[key] = value
  }
  const text = Object.entries(settings).map(([key, value]) => `${key}=${value}`).join('\n') + '\n'
  try {
    const temporary = `${LOCALE_FILE}.tmp`
    const fd = open(temporary, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
    try { writeAll(fd, encoder.encode(text)) } finally { close(fd) }
    rename(temporary, LOCALE_FILE)
  } catch (error) { err(`Failed to set locale: ${reasonOf(error)}`); return 1 }
  return 0
}

function main() {
  const { options, operands, error } = getopt(argv.slice(1), { short: 'h', long: { help: 'h', version: 'version', 'no-pager': 'no-pager', 'no-ask-password': 'ask', 'no-convert': 'convert' } })
  if (error) { err(`localectl: ${error}`); err(tryHelp('localectl')); return 1 }
  for (const [key] of options) {
    if (key === 'h') { out(usage + '\n'); return 0 }
    if (key === 'version') { out('ecmaOS localectl 1.0\n'); return 0 }
  }
  const [command = 'status', ...rest] = operands
  switch (command) {
    case 'status': return status()
    case 'set-locale': return setLocale(rest)
    case 'list-locales': out(supportedLocales().join('\n') + '\n'); return 0
    case 'list-keymaps': case 'list-x11-keymap-models': case 'list-x11-keymap-layouts': case 'list-x11-keymap-variants': case 'list-x11-keymap-options':
      err('Failed to read list of keymaps: the keyboard layout is the host\'s; there are none to choose from here')
      return 1
    case 'set-keymap': case 'set-x11-keymap':
      err('Failed to set keymap: the keyboard layout is the host\'s and is set there')
      return 1
    default:
      err(`Unknown command verb '${command}'.`)
      return 1
  }
}

try {
  exit(main())
} catch (error) {
  err(`localectl: ${reasonOf(error)}`)
  exit(1)
}
