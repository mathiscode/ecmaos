/**
 * Make a temporary file or directory, as GNU `mktemp` does, and print its name. The last run of three or more `X`
 * in TEMPLATE becomes random letters and digits (what follows it is kept as a suffix). A TEMPLATE with no directory is
 * made in the current directory; with `-p DIR`, `--tmpdir` or `-t` it goes in DIR, `$TMPDIR` or `/tmp`. With no
 * TEMPLATE it is `tmp.XXXXXXXXXX` in that directory. Files get mode 0600 and directories 0700.
 */

import { resolve } from './lib/path-utils.mjs'
import { getopt, tryHelp } from './lib/getopt.mjs'
import { reasonOf, is } from './lib/errno.mjs'

const sys = globalThis.ecmaosSyscalls
const { argv, exit, writeAll, getcwd, env, mkdir, open, close, O_WRONLY, O_CREAT } = sys
const O_EXCL = 0x80

const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
let quiet = false
const err = text => { if (!quiet) writeAll(2, encoder.encode(`mktemp: ${text}\n`)) }
const hint = () => { if (!quiet) writeAll(2, encoder.encode(tryHelp('mktemp') + '\n')) }
const quote = text => `‘${text}’`

const usage = `Usage: mktemp [OPTION]... [TEMPLATE]
Create a temporary file or directory, safely, and print its name.
TEMPLATE must contain at least 3 consecutive 'X's in last component.
If TEMPLATE is not specified, use tmp.XXXXXXXXXX, and --tmpdir is implied.
Files are created u+rw, and directories u+rwx, minus umask restrictions.

  -d, --directory     create a directory, not a file
  -u, --dry-run       do not create anything; merely print a name (unsafe)
  -q, --quiet         suppress diagnostics about file/dir-creation failure
      --suffix=SUFF   append SUFF to TEMPLATE; SUFF must not contain a slash.
                        This option is implied if TEMPLATE does not end in X
  -p DIR, --tmpdir[=DIR]  interpret TEMPLATE relative to DIR; if DIR is not
                        specified, use $TMPDIR if set, else /tmp.  With
                        this option, TEMPLATE must not be an absolute name;
                        unlike with -t, TEMPLATE may contain slashes, but
                        mktemp creates only the final component
  -t                  interpret TEMPLATE as a single file name component,
                        relative to a directory: $TMPDIR, if set; else the
                        directory specified via -p; else /tmp [deprecated]
      --help        display this help and exit
      --version     output version information and exit
`

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

function randomChars(count) {
  const bytes = crypto.getRandomValues(new Uint8Array(count))
  let text = ''
  for (const byte of bytes) text += CHARS[byte % CHARS.length]
  return text
}

function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'dp:qtu',
    long: { directory: 'd', 'dry-run': 'u', quiet: 'q', suffix: { key: 'S', arg: 'required' }, tmpdir: { key: 'p', arg: 'optional' }, help: 'help', version: 'version' }
  })
  if (error) { err(error); hint(); return 1 }
  let directory = false
  let dry = false
  let suffix
  let tmpdir
  let useTmpdir = false
  let tflag = false
  for (const [key, value] of options) {
    if (key === 'help') { out(usage); return 0 }
    if (key === 'version') { out('mktemp (ecmaOS coreutils) 1.0\n'); return 0 }
    if (key === 'd') directory = true
    else if (key === 'u') dry = true
    else if (key === 'q') quiet = true
    else if (key === 'S') suffix = String(value)
    else if (key === 't') { tflag = true; useTmpdir = true }
    else if (key === 'p') { useTmpdir = true; if (value !== true) tmpdir = String(value) }
  }
  if (operands.length > 1) { err(`too many templates`); hint(); return 1 }
  let template = operands[0]
  if (template === undefined) { template = 'tmp.XXXXXXXXXX'; useTmpdir = true }

  if (suffix !== undefined && suffix.includes('/')) { err(`invalid suffix ${quote(suffix)}, contains directory separator`); return 1 }

  // The run of X's that is replaced: with --suffix the template must end in them; otherwise the last run, and
  // whatever follows it is the suffix
  let head
  let run
  let tail
  if (suffix !== undefined) {
    const match = /^(.*?)(X{3,})$/s.exec(template)
    if (!match) { err(`too few X's in template ${quote(template)}`); return 1 }
    ;[, head, run] = match
    tail = suffix
  } else {
    const match = /^(.*?)(X{3,})([^X]*)$/s.exec(template)
    if (!match) { err(`too few X's in template ${quote(template)}`); return 1 }
    ;[, head, run, tail] = match
    // a slash after the run belongs to a directory part, which is not allowed
    if (tail.includes('/')) { err(`invalid suffix ${quote(tail)}, contains directory separator`); return 1 }
  }

  let dir = ''
  if (useTmpdir) {
    if (template.startsWith('/')) { err(`invalid template, ${quote(template)}; with --tmpdir, it may not be absolute`); return 1 }
    if (tflag && template.includes('/')) { err(`invalid template, ${quote(template)}, contains directory separator`); return 1 }
    dir = tmpdir ?? (env.TMPDIR || '/tmp')
  }

  const cwd = getcwd()
  const build = () => `${dir ? (dir.endsWith('/') ? dir : dir + '/') : ''}${head}${randomChars(run.length)}${tail}`
  let lastError
  for (let attempt = 0; attempt < 100; attempt++) {
    const name = build()
    const path = resolve(cwd, name)
    if (dry) { out(name + '\n'); return 0 }
    try {
      if (directory) mkdir(path, 0o700)
      else close(open(path, O_WRONLY | O_CREAT | O_EXCL, 0o600))
      out(name + '\n')
      return 0
    } catch (e) {
      lastError = e
      if (!is(e, 'EEXIST')) break
    }
  }
  err(`failed to create ${directory ? 'directory' : 'file'} via template ${quote(template)}: ${reasonOf(lastError)}`)
  return 1
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
