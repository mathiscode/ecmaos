/**
 * `locale`: show the locale settings in effect, list the locales there are (`-a`) and the character maps (`-m`), or
 * show a setting by name (`charmap`, `codeset`, `decimal_point`...). Every locale here is UTF-8 but `C` and `POSIX`, and
 * all of them format numbers as `C` does.
 */

import { supportedLocales } from './lib/locales.mjs'

const { argv, env, exit, writeAll } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(text))

const usage = `Usage: locale [OPTION...] NAME
  or:  locale [OPTION...] [-a|-m]
Get locale-specific information.

 System information:
  -a, --all-locales          Write names of available locales
  -m, --charmaps             Write names of available charmaps

 Modify output format:
  -c, --category-name        Write names of selected categories
  -k, --keyword-name         Write names of selected keywords
  -v, --verbose              Print more information

  -?, --help                 Give this help list
  -V, --version              Print program version`

const CATEGORIES = ['LC_CTYPE', 'LC_NUMERIC', 'LC_TIME', 'LC_COLLATE', 'LC_MONETARY', 'LC_MESSAGES', 'LC_PAPER', 'LC_NAME', 'LC_ADDRESS', 'LC_TELEPHONE', 'LC_MEASUREMENT', 'LC_IDENTIFICATION']

/** What a category is set to: `LC_ALL`, else its own variable, else `LANG`, else `POSIX`; and whether that was implicit */
function effective(category) {
  if (env.LC_ALL) return { value: env.LC_ALL, implicit: false }
  if (env[category]) return { value: env[category], implicit: false }
  return { value: env.LANG || 'POSIX', implicit: true }
}

const isUtf8 = name => /\.utf-?8$/i.test(name) || /^[a-z]{2}_[A-Z]{2}$/.test(name)

const KEYWORDS = {
  charmap: ['LC_CTYPE', () => isUtf8(effective('LC_CTYPE').value) ? 'UTF-8' : 'ANSI_X3.4-1968'],
  codeset: ['LC_CTYPE', () => isUtf8(effective('LC_CTYPE').value) ? 'UTF-8' : 'ANSI_X3.4-1968'],
  decimal_point: ['LC_NUMERIC', () => '.'],
  thousands_sep: ['LC_NUMERIC', () => ''],
  grouping: ['LC_NUMERIC', () => '-1'],
  d_t_fmt: ['LC_TIME', () => '%a %d %b %Y %r %Z'],
  d_fmt: ['LC_TIME', () => '%m/%d/%Y'],
  t_fmt: ['LC_TIME', () => '%r'],
  yesexpr: ['LC_MESSAGES', () => '^[yY]'],
  noexpr: ['LC_MESSAGES', () => '^[nN]']
}

function main() {
  const args = argv.slice(1)
  const flags = new Set(args.filter(arg => arg.startsWith('-')))
  const names = args.filter(arg => !arg.startsWith('-'))
  if (flags.has('--help') || flags.has('-?')) { out(usage + '\n'); return 0 }
  if (flags.has('-V') || flags.has('--version')) { out('locale (ecmaOS coreutils) 1.0\n'); return 0 }
  if (flags.has('-a') || flags.has('--all-locales')) {
    const names = ['C', 'C.utf8', 'POSIX', ...supportedLocales().filter(name => name !== 'C.UTF-8').map(name => name.replace(/\.UTF-8$/, '.utf8'))]
    out(names.join('\n') + '\n')
    return 0
  }
  if (flags.has('-m') || flags.has('--charmaps')) { out('ANSI_X3.4-1968\nUTF-8\n'); return 0 }
  const unknown = [...flags].find(flag => !['-c', '--category-name', '-k', '--keyword-name', '-v', '--verbose'].includes(flag))
  if (unknown) { err(`locale: invalid option -- '${unknown.replace(/^-+/, '')}'\nTry 'locale --help' for more information.\n`); return 1 }
  if (names.length === 0) {
    const lines = [`LANG=${env.LANG ?? ''}`, `LANGUAGE=${env.LANGUAGE ?? ''}`]
    for (const category of CATEGORIES) {
      const { value, implicit } = effective(category)
      lines.push(implicit ? `${category}="${value}"` : `${category}=${value}`)
    }
    lines.push(`LC_ALL=${env.LC_ALL ?? ''}`)
    out(lines.join('\n') + '\n')
    return 0
  }
  const category = flags.has('-c') || flags.has('--category-name')
  const keyword = flags.has('-k') || flags.has('--keyword-name')
  let status = 0
  for (const name of names) {
    if (CATEGORIES.includes(name)) {
      if (category) out(`${name}\n`)
      for (const [key, [owner, value]] of Object.entries(KEYWORDS)) if (owner === name) out(keyword ? `${key}="${value()}"\n` : `${value()}\n`)
      continue
    }
    const entry = KEYWORDS[name]
    if (!entry) { err(`locale: unknown name "${name}"\n`); status = 1; continue }
    if (category) out(`${entry[0]}\n`)
    out(keyword ? `${name}="${entry[1]()}"\n` : `${entry[1]()}\n`)
  }
  return status
}

try {
  exit(main())
} catch (error) {
  err(`locale: ${error instanceof Error ? error.message : String(error)}\n`)
  exit(1)
}
