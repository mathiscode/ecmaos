/**
 * `getfacl`: show the access control list of files, as the acl package's does: the owner, the group and the entries,
 * the default entries of a directory, and what the mask leaves of each. A file with no ACL shows the entries its mode stands for.
 */

import { reasonOf, is } from './lib/errno.mjs'
import { getopt } from './lib/getopt.mjs'
import { ACCESS, DEFAULT, decode, fromMode, isExtended, lines, modeBits, MASK, OTHER, USER_OBJ, find, groupName, userName } from './lib/acl.mjs'

const { argv, getxattr, lstat, stat, readdir, writeAll } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`getfacl: ${text}\n`))

const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000

const usage = `Usage: getfacl [-aceEsRLPtpndvh] file ...
Try \`getfacl --help' for more information.
`
const help = `getfacl 2.3.2 -- get file access control lists
Usage: getfacl [-aceEsRLPtpndvh] file ...
  -a,  --access           display the file access control list only
  -d, --default           display the default access control list only
  -c, --omit-header       do not display the comment header
  -e, --all-effective     print all effective rights
  -E, --no-effective      print no effective rights
  -s, --skip-base         skip files that only have the base entries
  -R, --recursive         recurse into subdirectories
  -L, --logical           logical walk, follow symbolic links
  -P, --physical          physical walk, do not follow symbolic links
  -t, --tabular           use tabular output format
  -p, --absolute-names    don't strip leading '/' in pathnames
  -n, --numeric           print numeric user/group identifiers
  -v, --version           print version and exit
  -h, --help              this help text
`

const opts = { access: false, def: false, header: true, effective: true, skipBase: false, recursive: false, logical: false, absolute: false, numeric: false }
let status = 0
let warned = false

function shown(path) {
  if (opts.absolute || !path.startsWith('/')) return path
  if (!warned) { warned = true; err("Removing leading '/' from absolute path names") }
  return path.replace(/^\/+/, '') || '.'
}

function read(path, name) {
  try { return decode(getxattr(path, name, false)) } catch (e) {
    if (is(e, 'ENODATA') || is(e, 'ENOTSUP') || is(e, 'EOPNOTSUPP')) return undefined
    throw e
  }
}

function show(path, info) {
  const isDir = (Number(info.mode) & S_IFMT) === S_IFDIR
  const stored = read(path, ACCESS)
  let access = stored ?? fromMode(Number(info.mode) & 0o777)
  if (stored) {
    // the owner, the group class and the others live in the mode: a chmod since the ACL was set shows
    const mode = Number(info.mode)
    access = access.map(entry => entry.tag === USER_OBJ ? { ...entry, perm: (mode >> 6) & 7 } : entry.tag === OTHER ? { ...entry, perm: mode & 7 } : entry.tag === MASK ? { ...entry, perm: (mode >> 3) & 7 } : entry)
    if (!find(access, MASK) && isExtended(access)) access = [...access, { tag: MASK, perm: modeBits(access) >> 3 & 7, id: 0xffffffff }]
  }
  const defaults = isDir ? read(path, DEFAULT) : undefined
  if (opts.skipBase && !isExtended(access) && !defaults) return

  let text = ''
  if (opts.header) {
    text += `# file: ${shown(path)}\n# owner: ${opts.numeric ? info.uid : userName(Number(info.uid))}\n# group: ${opts.numeric ? info.gid : groupName(Number(info.gid))}\n`
  }
  const style = { numeric: opts.numeric, effective: opts.effective }
  if (!opts.def) text += lines(access, style).join('\n') + '\n'
  if (!opts.access && defaults) text += lines(defaults, { ...style, prefix: 'default:' }).join('\n') + '\n'
  out(text + '\n')
}

function walk(path, top) {
  let info
  try { info = (opts.logical || top ? stat : lstat)(path) } catch (e) { err(`${shown(path)}: ${reasonOf(e)}`); status = 1; return }
  try { show(path, info) } catch (e) { err(`${shown(path)}: ${reasonOf(e)}`); status = 1 }
  if (!opts.recursive || (Number(info.mode) & S_IFMT) !== S_IFDIR) return
  if (!top && !opts.logical && (Number(lstat(path).mode) & S_IFMT) === S_IFLNK) return
  let names
  try { names = readdir(path) } catch (e) { err(`${shown(path)}: ${reasonOf(e)}`); status = 1; return }
  for (const entry of names.map(e => (typeof e === 'string' ? e : e.name)).filter(entry => entry !== '.' && entry !== '..').sort()) walk(path === '/' ? `/${entry}` : `${path}/${entry}`, false)
}

function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'adceEsRLPtpnvh',
    long: {
      access: 'a', default: 'd', 'omit-header': 'c', 'all-effective': 'e', 'no-effective': 'E', 'skip-base': 's', recursive: 'R', logical: 'L',
      physical: 'P', tabular: 't', 'absolute-names': 'p', numeric: 'n', version: 'v', help: 'h'
    }
  })
  if (error) { err(error); writeAll(2, encoder.encode(usage)); return 1 }
  for (const [key] of options) {
    if (key === 'h') { out(help); return 0 }
    if (key === 'v') { out('getfacl 2.3.2\n'); return 0 }
    if (key === 'a') opts.access = true
    else if (key === 'd') opts.def = true
    else if (key === 'c') opts.header = false
    else if (key === 'E') opts.effective = false
    else if (key === 's') opts.skipBase = true
    else if (key === 'R') opts.recursive = true
    else if (key === 'L') opts.logical = true
    else if (key === 'P') opts.logical = false
    else if (key === 'p') opts.absolute = true
    else if (key === 'n') opts.numeric = true
  }
  if (!operands.length) { writeAll(2, encoder.encode(usage)); return 1 }
  for (const path of operands) walk(path, true)
  return status
}

globalThis.ecmaosSyscalls.exit(main())
