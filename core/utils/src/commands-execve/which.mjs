/**
 * Locate commands in `$PATH`, as `which` does: every COMMAND is searched for along `$PATH` (a name with a slash is
 * checked as it stands), the first executable match is printed, and `-a` prints all of them. A command that is not
 * found is reported on standard error and the status is 1.
 */

import { resolve } from './lib/path-utils.mjs'
import { getopt, tryHelp } from './lib/getopt.mjs'

const { argv, exit, writeAll, getcwd, env, stat } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`which: ${text}\n`))

const usage = `Usage: which [options] [--] COMMAND [...]
Write the full path of COMMAND(s) to standard output.

  --version, -[vV] Print version and exit successfully.
  --help,          Print this help and exit successfully.
  --skip-dot       Skip directories in PATH that start with a dot.
  --skip-tilde     Skip directories in PATH that start with a tilde.
  --show-dot       Don't expand a dot to current directory in output.
  --show-tilde     Output a tilde for HOME directory for non-root.
  --tty-only       Stop processing options on the right if not on tty.
  --all, -a        Print all matches in PATH, not just the first
`

/** An executable regular file at `path`? */
function executable(path) {
  try {
    const info = stat(path)
    return (info.mode & 0xf000) === 0x8000 && (info.mode & 0o111) !== 0
  } catch { return false }
}

function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'avV',
    long: { all: 'a', version: 'v', help: 'help', 'skip-dot': 'skipdot', 'skip-tilde': 'skiptilde', 'show-dot': 'showdot', 'show-tilde': 'showtilde', 'tty-only': 'tty' }
  })
  if (error) {
    err(error.replace(/^option/, 'option'))
    writeAll(2, encoder.encode(usage))
    return 255
  }
  const keys = new Set(options.map(([key]) => key))
  if (keys.has('help')) { out(usage); return 0 }
  if (keys.has('v') || keys.has('V')) { out('which (ecmaOS) 1.0\n'); return 0 }
  if (operands.length === 0) { writeAll(2, encoder.encode(usage)); return 255 }

  const cwd = getcwd()
  const all = keys.has('a')
  const path = env.PATH ?? ''
  const dirs = path === '' ? [] : path.split(':')
  let status = 0

  for (const command of operands) {
    const found = []
    if (command.includes('/')) {
      const full = resolve(cwd, command)
      if (executable(full)) found.push(command.startsWith('/') ? command : full)
    } else {
      for (const dir of dirs) {
        // /etc/env may name a variable in a PATH entry (`$HOME/bin`)
        const base = dir === '' ? '.' : dir.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_, name) => env[name] ?? '')
        if (keys.has('skipdot') && base.startsWith('.')) continue
        const candidate = `${base.endsWith('/') ? base : base + '/'}${command}`
        const full = resolve(cwd, candidate)
        if (!executable(full)) continue
        found.push(base.startsWith('/') ? candidate : full)
        if (!all) break
      }
    }
    if (found.length === 0) {
      err(`no ${command} in (${path})`)
      status = 1
      continue
    }
    out(found.join('\n') + '\n')
  }
  return status
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(2)
}
