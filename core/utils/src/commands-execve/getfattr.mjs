/**
 * `getfattr`: show the extended attributes of files, as the attr package's does. `-n` one attribute, `-d` all those `-m`
 * matches (default `^user\.`, `-` for every one), otherwise only their names; `-e` text, hex or base64, `-h` not
 * following links, `-R` into directories, `--only-values` and `--absolute-names`.
 */

import { reasonOf, is } from './lib/errno.mjs'
import { getopt } from './lib/getopt.mjs'
import { encodeValue, quotePath } from './lib/xattr-text.mjs'

const { argv, getxattr, listxattr, lstat, stat, readdir, writeAll } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, typeof text === 'string' ? encoder.encode(text) : text)
const err = text => writeAll(2, encoder.encode(`getfattr: ${text}\n`))

const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000

const usage = `Usage: getfattr [-hRLP] [-n name|-d] [-e en] [-m pattern] path...
Try \`getfattr --help' for more information.
`
const help = `getfattr 2.5.2 -- get extended attributes
Usage: getfattr [-hRLP] [-n name|-d] [-e en] [-m pattern] path...
  -n, --name=name         get the named extended attribute value
  -d, --dump              get all extended attribute values
  -e, --encoding=...      encode values (as 'text', 'hex' or 'base64')
      --match=pattern     only get attributes with names matching pattern
      --only-values       print the bare values only
  -h, --no-dereference    do not dereference symbolic links
      --absolute-names    don't strip leading '/' in pathnames
  -R, --recursive         recurse into subdirectories
  -L, --logical           logical walk, follow symbolic links
  -P  --physical          physical walk, do not follow symbolic links
      --version           print version and exit
      --help              this help text
`

let name, dump = false, encoding, pattern = /^user\./, onlyValues = false, noFollow = false, absolute = false
let recursive = false, logical = false
let status = 0
let warnedAbsolute = false

/** A path as it is shown: without its leading `/` unless `--absolute-names`, which getfattr says once */
function shown(path) {
  if (absolute || !path.startsWith('/')) return path
  if (!warnedAbsolute) { warnedAbsolute = true; err("Removing leading '/' from absolute path names") }
  return path.replace(/^\/+/, '') || '.'
}

function report(path, names) {
  if (onlyValues) {
    for (const attr of names) out(getxattr(path, attr, noFollow))
    return
  }
  if (!names.length) return
  out(`# file: ${quotePath(shown(path))}\n`)
  for (const attr of names) {
    if (!dump && name === undefined) { out(`${attr}\n`); continue }
    const value = getxattr(path, attr, noFollow)
    out(value.length || encoding ? `${attr}=${encodeValue(value, encoding)}\n` : `${attr}\n`)
  }
  out('\n')
}

function show(path) {
  try {
    if (name !== undefined) {
      try { getxattr(path, name, noFollow) } catch (e) {
        if (is(e, 'ENODATA')) { writeAll(2, encoder.encode(`${shown(path)}: ${name}: No such attribute\n`)); status = 1; return }
        throw e
      }
      report(path, [name])
      return
    }
    const names = listxattr(path, noFollow).filter(attr => attr && pattern.test(attr)).sort()
    report(path, names)
  } catch (e) {
    err(`${shown(path)}: ${reasonOf(e)}`)
    status = 1
  }
}

function walk(path, top) {
  let mode = 0
  try { mode = Number((noFollow && !logical ? lstat : stat)(path).mode) } catch (e) { err(`${shown(path)}: ${reasonOf(e)}`); status = 1; return }
  show(path)
  if (!recursive || (mode & S_IFMT) !== S_IFDIR) return
  // a link below the top is followed only in a logical walk
  if (!top && !logical) { try { if ((Number(lstat(path).mode) & S_IFMT) === S_IFLNK) return } catch {} }
  let names
  try { names = readdir(path) } catch (e) { err(`${shown(path)}: ${reasonOf(e)}`); status = 1; return }
  for (const entry of names.filter(entry => entry !== '.' && entry !== '..').sort()) walk(path === '/' ? `/${entry}` : `${path}/${entry}`, false)
}

function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'n:de:m:hRLPV',
    long: {
      name: { key: 'n', arg: 'required' }, dump: 'd', encoding: { key: 'e', arg: 'required' }, match: { key: 'm', arg: 'required' },
      'only-values': 'only-values', 'no-dereference': 'h', 'absolute-names': 'absolute-names', recursive: 'R', logical: 'L',
      physical: 'P', version: 'V', help: 'help'
    }
  })
  if (error) { err(error); writeAll(2, encoder.encode(usage)); return 1 }
  for (const [key, value] of options) {
    if (key === 'help') { out(help); return 0 }
    if (key === 'V') { out('getfattr 2.5.2\n'); return 0 }
    if (key === 'n') name = value
    else if (key === 'd') dump = true
    else if (key === 'e') {
      if (!['text', 'hex', 'base64'].includes(value)) { err(`unrecognized encoding '${value}'`); return 1 }
      encoding = value
    } else if (key === 'm') {
      if (value === '-') pattern = /(?:)/
      else try { pattern = new RegExp(value) } catch { err(`${value}: invalid pattern`); return 1 }
    } else if (key === 'only-values') onlyValues = true
    else if (key === 'h') noFollow = true
    else if (key === 'absolute-names') absolute = true
    else if (key === 'R') recursive = true
    else if (key === 'L') logical = true
    else if (key === 'P') logical = false
  }
  if (!operands.length) { writeAll(2, encoder.encode(usage)); return 1 }
  for (const path of operands) walk(path, true)
  return status
}

globalThis.ecmaosSyscalls.exit(main())
