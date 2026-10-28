/** Build the file name database `locate` reads: a walk of the filesystem from a root, skipping the places that are not files. */

import { getopt } from './lib/getopt.mjs'
import { reasonOf } from './lib/errno.mjs'
import { dirname, resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, getcwd, readdir, isDirectory, isSymbolicLink, mkdir, rename, open, write, close, O_WRONLY, O_CREAT, O_TRUNC } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`updatedb: ${text}\n`))

const HEADER = '#ecmaos-locatedb 1'
const DEFAULT_DATABASE = '/var/lib/plocate/plocate.db'
/** what is not files on this machine, or changes by the second */
const DEFAULT_PRUNE = ['/proc', '/sys', '/dev', '/run', '/tmp', '/media', '/var/spool', '/var/lib/plocate']

const usage = `Usage: updatedb [OPTION]...
Update a file name database for locate.

  -U, --database-root PATH  scan from PATH instead of /
  -o, --output FILE         write the database to FILE (default ${DEFAULT_DATABASE})
  -e, --prune-path PATHS    do not enter these directories (space separated; adds to the default list)
  -v, --verbose             print the paths as they are scanned
      --help                display this help and exit
      --version             output version information and exit

The default list is: ${DEFAULT_PRUNE.join(' ')}. A directory that cannot be read is skipped.`

function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'U:o:e:v',
    long: { 'database-root': { key: 'U', arg: 'required' }, output: { key: 'o', arg: 'required' }, 'prune-path': { key: 'e', arg: 'required' }, prunepaths: { key: 'e', arg: 'required' }, verbose: 'v', help: 'help', version: 'version' }
  })
  if (error) { err(error); return 1 }
  if (operands.length) { err(`unexpected argument ‘${operands[0]}’`); return 1 }
  let root = '/'
  let output = DEFAULT_DATABASE
  let verbose = false
  const prune = new Set(DEFAULT_PRUNE)
  for (const [key, value] of options) {
    if (key === 'help') { out(usage + '\n'); return 0 }
    if (key === 'version') { out('updatedb (ecmaOS coreutils) 1.0\n'); return 0 }
    if (key === 'U') root = resolve(getcwd(), value)
    else if (key === 'o') output = resolve(getcwd(), value)
    else if (key === 'v') verbose = true
    else if (key === 'e') for (const path of value.split(/\s+/).filter(Boolean)) prune.add(resolve(getcwd(), path))
  }

  const paths = []
  const walk = dir => {
    let names
    try { names = readdir(dir).map(entry => (typeof entry === 'string' ? entry : entry.name)).filter(name => name !== '.' && name !== '..').sort() } catch { return }
    for (const name of names) {
      const path = dir === '/' ? `/${name}` : `${dir}/${name}`
      if (prune.has(path)) continue
      if (verbose) out(path + '\n')
      paths.push(path)
      let enter = false
      try { enter = !isSymbolicLink(path) && isDirectory(path) } catch { /* it went away */ }
      if (enter) walk(path)
    }
  }
  walk(root)
  if (root !== '/') paths.unshift(root)

  const text = encoder.encode(`${HEADER}\n${paths.join('\n')}${paths.length ? '\n' : ''}`)
  // the directory, and the ones above it
  let made = ''
  for (const part of dirname(output).split('/').filter(Boolean)) {
    made += `/${part}`
    try { mkdir(made, 0o755) } catch { /* it exists, or the open below says why not */ }
  }
  // written beside and renamed, so a locate running now reads the old database whole or the new one
  const temporary = `${output}.${Date.now()}.new`
  try {
    const fd = open(temporary, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
    try { for (let at = 0; at < text.length;) at += write(fd, text.subarray(at), -1) } finally { close(fd) }
    rename(temporary, output)
  } catch (e) { err(`${output}: ${reasonOf(e)}`); return 1 }
  return 0
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
