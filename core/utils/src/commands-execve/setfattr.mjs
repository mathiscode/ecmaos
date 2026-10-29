/**
 * `setfattr`: set or remove an extended attribute of files, as the attr package's does (`-n NAME -v VALUE`, `-x NAME`,
 * `-h`), or put back what `getfattr -d` wrote (`--restore=FILE`, `-` for standard input).
 */

import { reasonOf } from './lib/errno.mjs'
import { getopt } from './lib/getopt.mjs'
import { readAll } from './lib/run.mjs'
import { decodeValue, unquotePath } from './lib/xattr-text.mjs'

const { argv, exit, open, close, setxattr, removexattr, writeAll, O_RDONLY } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`setfattr: ${text}\n`))

const usage = `Usage: setfattr {-n name} [-v value] [-h] file...
       setfattr {-x name} [-h] file...
Try \`setfattr --help' for more information.
`
const help = `setfattr 2.5.2 -- set extended attributes
Usage: setfattr {-n name} [-v value] [-h] file...
       setfattr {-x name} [-h] file...
  -n, --name=name         set the value of the named extended attribute
  -x, --remove=name       remove the named extended attribute
  -v, --value=value       use value as the attribute value
  -h, --no-dereference    do not dereference symbolic links
      --restore=file      restore extended attributes
      --version           print version and exit
      --help              this help text
`

let status = 0

/** Puts back a `getfattr -d` dump: each `# file:` block's attributes on that file, relative paths from here */
function restore(source, noFollow) {
  let text
  try {
    const fd = source === '-' ? 0 : open(source, O_RDONLY)
    try { text = new TextDecoder().decode(readAll(fd)) } finally { if (fd !== 0) close(fd) }
  } catch (e) { err(`${source}: ${reasonOf(e)}`); return 1 }
  let file
  for (const [index, line] of text.split('\n').entries()) {
    if (line.startsWith('# file: ')) { file = unquotePath(line.slice(8)); continue }
    if (!line.trim() || line.startsWith('#')) continue
    if (file === undefined) { err(`${source}: no filename found in line ${index + 1}, aborting`); return 1 }
    const at = line.indexOf('=')
    const attr = at < 0 ? line : line.slice(0, at)
    try { setxattr(file, attr, at < 0 ? new Uint8Array() : decodeValue(line.slice(at + 1)), noFollow) } catch (e) {
      err(`${file}: ${reasonOf(e)}`)
      status = 1
    }
  }
  return status
}

function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'n:x:v:hV',
    long: {
      name: { key: 'n', arg: 'required' }, remove: { key: 'x', arg: 'required' }, value: { key: 'v', arg: 'required' },
      'no-dereference': 'h', restore: { key: 'restore', arg: 'required' }, version: 'V', help: 'help'
    }
  })
  if (error) { err(error); writeAll(2, encoder.encode(usage)); return 1 }
  let name, remove, value, noFollow = false, from
  for (const [key, arg] of options) {
    if (key === 'help') { out(help); return 0 }
    if (key === 'V') { out('setfattr 2.5.2\n'); return 0 }
    if (key === 'n') name = arg
    else if (key === 'x') remove = arg
    else if (key === 'v') value = arg
    else if (key === 'h') noFollow = true
    else if (key === 'restore') from = arg
  }
  if (from !== undefined) return restore(from, noFollow)
  if ((name === undefined) === (remove === undefined) || !operands.length || (remove !== undefined && value !== undefined)) {
    writeAll(2, encoder.encode(usage))
    return 1
  }
  let bytes = new Uint8Array()
  if (value !== undefined) {
    try { bytes = decodeValue(value) } catch (e) { err(`${name}: ${e.message}`); return 1 }
  }
  for (const file of operands) {
    try {
      if (remove !== undefined) removexattr(file, remove, noFollow)
      else setxattr(file, name, bytes, noFollow)
    } catch (e) {
      err(`${file}: ${reasonOf(e)}`)
      status = 1
    }
  }
  return status
}

exit(main())
