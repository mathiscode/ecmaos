/**
 * `dircolors`: print the shell commands that set `LS_COLORS`, from a database file or the built-in one: `eval "$(dircolors -b)"`.
 * The database is GNU's format (`TERM`, `COLOR`, `EIGHTBIT`, the file types by name and `.ext` or `*glob` lines); `-p` prints the
 * built-in one and `--print-ls-colors` shows each entry in its own color.
 */

import { readFileBytes } from './lib/bytes.mjs'
import { reasonOf } from './lib/errno.mjs'
import { readAll } from './lib/run.mjs'

const { argv, env, exit, writeAll } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`dircolors: ${text}\n`))

const usage = `Usage: dircolors [OPTION]... [FILE]
Output commands to set the LS_COLORS environment variable.

Determine format of output:
  -b, --sh, --bourne-shell    output Bourne shell code to set LS_COLORS
  -c, --csh, --c-shell        output C shell code to set LS_COLORS
  -p, --print-database        output defaults
      --print-ls-colors       output fully escaped colors for display

If FILE is specified, read it to determine which colors to use for which
file types and extensions.  Otherwise, a precompiled database is used.

      --help     display this help and exit
      --version  output version information and exit`

const database = `# Configuration file for dircolors, a utility to help you set the
# LS_COLORS environment variable used by GNU ls with the --color option.
# Copyright (C) 1996-2025 Free Software Foundation, Inc.

# Below are TERM entries, which can be a glob patterns, to match
# against the TERM environment variable to determine if it is colorizable.
TERM Eterm
TERM ansi
TERM *color*
TERM con[0-9]*x[0-9]*
TERM cons25
TERM console
TERM cygwin
TERM *direct*
TERM dtterm
TERM gnome
TERM hurd
TERM jfbterm
TERM konsole
TERM kterm
TERM linux
TERM linux-c
TERM mlterm
TERM putty
TERM rxvt*
TERM screen*
TERM st
TERM terminator
TERM tmux*
TERM vt100
TERM xterm*

# Below are the color init strings for the basic file types.
RESET 0                      # reset to "normal" color
DIR 01;34                    # directory
LINK 01;36                   # symbolic link
MULTIHARDLINK 00             # regular file with more than one link
FIFO 40;33                   # pipe
SOCK 01;35                   # socket
DOOR 01;35                   # door
BLK 40;33;01                 # block device driver
CHR 40;33;01                 # character device driver
ORPHAN 40;31;01              # symlink to nonexistent file, or non-stat'able file
MISSING 00                   # ... and the files they point to
SETUID 37;41                 # file that is setuid (u+s)
SETGID 30;43                 # file that is setgid (g+s)
CAPABILITY 00                # file with capability (very expensive to lookup)
STICKY_OTHER_WRITABLE 30;42  # dir that is sticky and other-writable (+t,o+w)
OTHER_WRITABLE 34;42         # dir that is other-writable (o+w) and not sticky
STICKY 37;44                 # dir with the sticky bit set (+t) and not other-writable

# This is for regular files with execute permission:
EXEC 01;32

# List any file extensions like '.gz' or '.tar' that you would like ls
# to colorize below. Put the extension, a space, and the color init string.
.tar 01;31
.tgz 01;31
.zip 01;31
.gz 01;31
.bz2 01;31
.xz 01;31
.7z 01;31
.rar 01;31
.deb 01;31
.jpg 01;35
.jpeg 01;35
.png 01;35
.gif 01;35
.bmp 01;35
.svg 01;35
.webp 01;35
.mp4 01;35
.mkv 01;35
.webm 01;35
.mp3 00;36
.ogg 00;36
.wav 00;36
.flac 00;36
`

/** The keyword of a database line and the two-letter code `LS_COLORS` knows it by */
const codes = {
  RESET: 'rs', DIR: 'di', LINK: 'ln', SYMLINK: 'ln', MULTIHARDLINK: 'mh', FIFO: 'pi', PIPE: 'pi', SOCK: 'so', DOOR: 'do', BLK: 'bd', BLOCK: 'bd',
  CHR: 'cd', CHAR: 'cd', ORPHAN: 'or', MISSING: 'mi', SETUID: 'su', SETGID: 'sg', CAPABILITY: 'ca', STICKY_OTHER_WRITABLE: 'tw',
  OTHER_WRITABLE: 'ow', STICKY: 'st', EXEC: 'ex', NORMAL: 'no', NORM: 'no', FILE: 'fi', LEFTCODE: 'lc', LCODE: 'lc', RIGHTCODE: 'rc',
  RCODE: 'rc', ENDCODE: 'ec', ECODE: 'ec', CLEAR_TO_EOL: 'cl'
}

/** Matches a `TERM` pattern (`*color*`, `xterm*`, `con[0-9]*x[0-9]*`) against `term` */
const termMatches = (pattern, term) => new RegExp(`^${pattern.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test(term)

function convert(text, term) {
  const entries = []
  let colorable = false
  let seenTerm = false
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s*#.*$/, '').trim()
    if (!line) continue
    const [keyword, ...words] = line.split(/\s+/)
    const value = words.join(' ')
    if (keyword === 'TERM') { seenTerm = true; if (termMatches(value, term)) colorable = true; continue }
    if (keyword === 'COLOR' || keyword === 'COLORTERM' || keyword === 'EIGHTBIT') continue
    if (!value) return { error: `invalid line;  missing second token: ${line}` }
    if (keyword.startsWith('.')) entries.push(`*${keyword}=${value}`)
    else if (keyword.startsWith('*')) entries.push(`${keyword}=${value}`)
    else if (codes[keyword]) entries.push(`${codes[keyword]}=${value}`)
    else return { error: `unrecognized keyword ${keyword}` }
  }
  return { entries, colorable: !seenTerm || colorable }
}

async function main() {
  const args = argv.slice(1)
  let shell = 'sh'
  let print = false
  let display = false
  const operands = []
  for (const arg of args) {
    if (arg === '--help') { out(usage + '\n'); return 0 }
    if (arg === '--version') { out('dircolors (ecmaOS coreutils) 1.0\n'); return 0 }
    if (['-b', '--sh', '--bourne-shell'].includes(arg)) shell = 'sh'
    else if (['-c', '--csh', '--c-shell'].includes(arg)) shell = 'csh'
    else if (arg === '-p' || arg === '--print-database') print = true
    else if (arg === '--print-ls-colors') display = true
    else if (arg.startsWith('-') && arg !== '-') { err(`invalid option -- '${arg.replace(/^-+/, '')}'\nTry 'dircolors --help' for more information.`); return 1 }
    else operands.push(arg)
  }
  if (operands.length > 1) { err(`extra operand ‘${operands[1]}’\nTry 'dircolors --help' for more information.`); return 1 }
  if (print && operands.length) { err('the options to output non-printable shell commands and print the database are mutually exclusive'); return 1 }
  if (print) { out(database); return 0 }

  let text = database
  if (operands.length) {
    try { text = new TextDecoder().decode(operands[0] === '-' ? readAll(0) : readFileBytes(operands[0])) } catch (error) {
      err(`${operands[0]}: ${reasonOf(error)}`)
      return 1
    }
  }
  const { entries, colorable, error } = convert(text, env.TERM ?? '')
  if (error) { err(error); return 1 }
  if (display) {
    for (const entry of entries) out(`\x1b[${entry.slice(entry.indexOf('=') + 1)}m${entry}\x1b[0m\n`)
    return 0
  }
  const value = colorable ? entries.join(':') + ':' : ''
  out(shell === 'csh' ? `setenv LS_COLORS '${value}'\n` : `LS_COLORS='${value}';\nexport LS_COLORS\n`)
  return 0
}

try {
  exit(await main())
} catch (error) {
  err(error?.message ?? String(error))
  exit(1)
}
