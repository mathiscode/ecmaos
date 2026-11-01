/**
 * `setfacl`: change the access control list of files, as the acl package's does: `-m` modify, `-x` remove entries, `--set`
 * replace the list, `-b` remove all extended entries, `-k` remove the default entries, `-d` act on the default list, `-R`
 * recurse, `-n` leave the mask alone. The list is kept in the file's `system.posix_acl_*` attributes and the mode shows
 * the owner, the mask and the others.
 */

import { reasonOf, is } from './lib/errno.mjs'
import { getopt } from './lib/getopt.mjs'
import { readTextFile } from './lib/fs-text.mjs'
import { chmodOwned } from './lib/owner-ops.mjs'
import {
  ACCESS, DEFAULT, GROUP, GROUP_OBJ, MASK, OTHER, USER, USER_OBJ, decode, encode, find, fromMode, isExtended, modeBits, parseSpec, sorted, withMask
} from './lib/acl.mjs'

const sys = globalThis.ecmaosSyscalls
const { argv, getxattr, setxattr, removexattr, lstat, stat, readdir, writeAll } = sys
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`setfacl: ${text}\n`))

const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000
const NO_ID = 0xffffffff

const usage = `Usage: setfacl [-bkndRLP] { -m|-M|-x|-X ... } file ...
Try \`setfacl --help' for more information.
`
const help = `setfacl 2.3.2 -- set file access control lists
Usage: setfacl [-bkndRLP] { -m|-M|-x|-X ... } file ...
  -m, --modify=acl        modify the current ACL(s) of file(s)
  -M, --modify-file=file  read ACL entries to modify from file
  -x, --remove=acl        remove entries from the ACL(s) of file(s)
  -X, --remove-file=file  read ACL entries to remove from file
  -b, --remove-all        remove all extended ACL entries
  -k, --remove-default    remove the default ACL
      --set=acl           set the ACL of file(s), replacing the current ACL
      --set-file=file     read ACL entries to set from file
      --mask              do recalculate the effective rights mask
  -n, --no-mask           don't recalculate the effective rights mask
  -d, --default           operations apply to the default ACL
  -R, --recursive         recurse into subdirectories
  -L, --logical           logical walk, follow symbolic links
  -P, --physical          physical walk, do not follow symbolic links
      --version           print version information and exit
  -h, --help              this help text
`

const state = { ops: [], keepMask: false, defaultOnly: false, recursive: false, logical: false, removeAll: false, removeDefault: false }
let status = 0

const specsOf = text => text.split(/[,\n]/).map(part => part.replace(/#.*$/, '').trim()).filter(Boolean)

function readAcl(path, name) {
  try { return decode(getxattr(path, name, false)) } catch (e) {
    if (is(e, 'ENODATA') || is(e, 'ENOTSUP') || is(e, 'EOPNOTSUPP')) return undefined
    throw e
  }
}

function clear(path, name) {
  try { removexattr(path, name, false) } catch (e) { if (!is(e, 'ENODATA')) throw e }
}

/** The entries after one `-m`, `-x` or `--set` operation, or throws with setfacl's complaint */
function apply(entries, op) {
  if (op.kind === 'set') {
    const next = op.specs.map(spec => ({ tag: spec.tag, perm: spec.perm, id: spec.id }))
    for (const tag of [USER_OBJ, GROUP_OBJ, OTHER]) if (!find(next, tag)) throw new Error('Malformed access ACL: Missing or wrong entry')
    return sorted(next)
  }
  let next = [...entries]
  for (const spec of op.specs) {
    const same = entry => entry.tag === spec.tag && entry.id === spec.id
    if (op.kind === 'remove') {
      if (!next.some(same)) throw new Error('Malformed access ACL: No such entry')
      if (spec.tag !== USER && spec.tag !== GROUP && spec.tag !== MASK) throw new Error('Invalid argument')
      next = next.filter(entry => !same(entry))
    } else {
      const at = next.findIndex(same)
      if (at === -1) next.push({ tag: spec.tag, perm: spec.perm, id: spec.id })
      else next[at] = { ...next[at], perm: spec.perm }
    }
  }
  return sorted(next)
}

async function change(path, info) {
  const mode = Number(info.mode)
  const isDir = (mode & S_IFMT) === S_IFDIR
  let access = readAcl(path, ACCESS) ?? fromMode(mode & 0o777)
  let defaults = isDir ? readAcl(path, DEFAULT) : undefined
  const explicitMask = {}

  if (state.removeAll) {
    const groupClass = find(access, GROUP_OBJ)?.perm ?? (mode >> 3) & 7
    access = fromMode(((mode >> 6) & 7) << 6 | groupClass << 3 | (mode & 7))
    defaults = undefined
  }
  if (state.removeDefault) defaults = undefined

  for (const op of state.ops) {
    const forDefault = op.specs.map(spec => spec.def || state.defaultOnly)
    const pick = flag => ({ ...op, specs: op.specs.filter((_, index) => forDefault[index] === flag) })
    const toDefault = pick(true)
    const toAccess = pick(false)
    if (toDefault.specs.length) {
      if (!isDir) throw new Error('Only directories can have default ACLs')
      const base = defaults ?? (op.kind === 'set' ? [] : withMask(fromMode(mode & 0o777)).filter(entry => entry.tag !== MASK))
      if (toDefault.specs.some(spec => spec.tag === MASK)) explicitMask.default = true
      defaults = apply(base, toDefault)
      for (const [tag, source] of [[USER_OBJ, USER_OBJ], [GROUP_OBJ, GROUP_OBJ], [OTHER, OTHER]]) {
        if (defaults.length && !find(defaults, tag)) defaults = sorted([...defaults, { ...find(access, source), id: NO_ID }])
      }
    }
    if (toAccess.specs.length || op.kind === 'set' && !toDefault.specs.length) {
      if (toAccess.specs.some(spec => spec.tag === MASK)) explicitMask.access = true
      access = apply(access, toAccess.specs.length || op.kind !== 'set' ? toAccess : op)
    }
  }

  if (!state.keepMask) {
    if (!explicitMask.access) access = withMask(access)
    if (defaults && !explicitMask.default && isExtended(defaults)) defaults = withMask(defaults)
  }

  if (isExtended(access)) setxattr(path, ACCESS, encode(sorted(access)), false)
  else clear(path, ACCESS)
  if (defaults?.length) setxattr(path, DEFAULT, encode(sorted(defaults)), false)
  else if (isDir) clear(path, DEFAULT)
  await chmodOwned(sys, path, (mode & ~0o777) | modeBits(access))
}

async function walk(path, top) {
  let info
  try { info = (state.logical || top ? stat : lstat)(path) } catch (e) { err(`${path}: ${reasonOf(e)}`); status = 1; return }
  if ((Number(info.mode) & S_IFMT) !== S_IFLNK) {
    try { await change(path, info) } catch (e) { err(`${path}: ${e?.code ? reasonOf(e) : e.message}`); status = 1 }
  }
  if (!state.recursive || (Number(info.mode) & S_IFMT) !== S_IFDIR) return
  let names
  try { names = readdir(path) } catch (e) { err(`${path}: ${reasonOf(e)}`); status = 1; return }
  for (const entry of names.map(e => (typeof e === 'string' ? e : e.name)).filter(entry => entry !== '.' && entry !== '..').sort()) await walk(path === '/' ? `/${entry}` : `${path}/${entry}`, false)
}

function addOp(kind, texts, remove) {
  const specs = []
  for (const text of texts) {
    const spec = parseSpec(text, { remove })
    if (spec.error) { err(spec.error); return false }
    specs.push(spec)
  }
  state.ops.push({ kind, specs })
  return true
}

async function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'm:M:x:X:bknndRLPh',
    long: {
      modify: { key: 'm', arg: 'required' }, 'modify-file': { key: 'M', arg: 'required' }, remove: { key: 'x', arg: 'required' },
      'remove-file': { key: 'X', arg: 'required' }, 'remove-all': 'b', 'remove-default': 'k', set: { key: 'set', arg: 'required' },
      'set-file': { key: 'set-file', arg: 'required' }, mask: 'mask', 'no-mask': 'n', default: 'd', recursive: 'R', logical: 'L',
      physical: 'P', version: 'version', help: 'h'
    }
  })
  if (error) { err(error); writeAll(2, encoder.encode(usage)); return 1 }
  const fromFile = file => {
    try { return specsOf(file === '-' ? '' : readTextFile(file)) } catch (e) { err(`${file}: ${reasonOf(e)}`); return undefined }
  }
  for (const [key, value] of options) {
    if (key === 'h') { out(help); return 0 }
    if (key === 'version') { out('setfacl 2.3.2\n'); return 0 }
    if (key === 'm' && !addOp('modify', specsOf(value), false)) return 1
    if (key === 'x' && !addOp('remove', specsOf(value), true)) return 1
    if (key === 'set' && !addOp('set', specsOf(value), false)) return 1
    if (key === 'M' || key === 'X' || key === 'set-file') {
      const texts = fromFile(value)
      if (!texts || !addOp(key === 'M' ? 'modify' : key === 'X' ? 'remove' : 'set', texts, key === 'X')) return 1
    }
    if (key === 'b') state.removeAll = true
    else if (key === 'k') state.removeDefault = true
    else if (key === 'n') state.keepMask = true
    else if (key === 'mask') state.keepMask = false
    else if (key === 'd') state.defaultOnly = true
    else if (key === 'R') state.recursive = true
    else if (key === 'L') state.logical = true
    else if (key === 'P') state.logical = false
  }
  if (!operands.length || (!state.ops.length && !state.removeAll && !state.removeDefault)) { writeAll(2, encoder.encode(usage)); return 1 }
  for (const path of operands) await walk(path, true)
  return status
}

main().then(code => sys.exit(code), error => { err(error instanceof Error ? error.message : String(error)); sys.exit(1) })
