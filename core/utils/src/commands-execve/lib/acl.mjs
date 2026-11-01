/**
 * POSIX ACLs as Linux keeps them in the `system.posix_acl_access` and `system.posix_acl_default` attributes: a 4-byte
 * version (2) and 8-byte entries of tag, permissions and id, little-endian. `getfacl` and `setfacl` share this.
 */

import { readTextFile } from './fs-text.mjs'

export const ACCESS = 'system.posix_acl_access'
export const DEFAULT = 'system.posix_acl_default'

export const USER_OBJ = 0x01
export const USER = 0x02
export const GROUP_OBJ = 0x04
export const GROUP = 0x08
export const MASK = 0x10
export const OTHER = 0x20
const NO_ID = 0xffffffff

export function decode(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 4 || view.getUint32(0, true) !== 2) throw new Error('Invalid argument')
  const entries = []
  for (let at = 4; at + 8 <= bytes.length; at += 8) {
    entries.push({ tag: view.getUint16(at, true), perm: view.getUint16(at + 2, true), id: view.getUint32(at + 4, true) })
  }
  return entries
}

export function encode(entries) {
  const bytes = new Uint8Array(4 + entries.length * 8)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 2, true)
  entries.forEach((entry, index) => {
    const at = 4 + index * 8
    view.setUint16(at, entry.tag, true)
    view.setUint16(at + 2, entry.perm, true)
    view.setUint32(at + 4, entry.tag === USER || entry.tag === GROUP ? entry.id : NO_ID, true)
  })
  return bytes
}

/** The entries a plain mode stands for */
export const fromMode = mode => [
  { tag: USER_OBJ, perm: (mode >> 6) & 7, id: NO_ID },
  { tag: GROUP_OBJ, perm: (mode >> 3) & 7, id: NO_ID },
  { tag: OTHER, perm: mode & 7, id: NO_ID }
]

export const sorted = entries => [...entries].sort((a, b) => a.tag - b.tag || (a.id === b.id ? 0 : a.id < b.id ? -1 : 1))
export const isExtended = entries => entries.some(entry => entry.tag === USER || entry.tag === GROUP)
export const find = (entries, tag, id) => entries.find(entry => entry.tag === tag && (id === undefined || entry.id === id))

/** The mode bits an ACL leaves in the file: user and other as they are, the group bits holding the mask when there is one */
export function modeBits(entries) {
  const get = tag => find(entries, tag)?.perm ?? 0
  return (get(USER_OBJ) << 6) | ((isExtended(entries) ? get(MASK) : get(GROUP_OBJ)) << 3) | get(OTHER)
}

/** Adds the mask an ACL with named entries needs: the union of the group class */
export function withMask(entries) {
  const rest = entries.filter(entry => entry.tag !== MASK)
  if (!isExtended(rest)) return rest
  const perm = rest.filter(entry => entry.tag === GROUP_OBJ || entry.tag === USER || entry.tag === GROUP).reduce((all, entry) => all | entry.perm, 0)
  return sorted([...rest, { tag: MASK, perm, id: NO_ID }])
}

let accounts
function table(path) {
  const rows = []
  try { for (const line of readTextFile(path).split('\n')) { const [name, , id] = line.split(':'); if (name && id !== undefined) rows.push([name, Number(id)]) } } catch {}
  return rows
}
function load() {
  accounts ??= { users: table('/etc/passwd'), groups: table('/etc/group') }
  return accounts
}
export const userName = uid => load().users.find(([, id]) => id === uid)?.[0] ?? String(uid)
export const groupName = gid => load().groups.find(([, id]) => id === gid)?.[0] ?? String(gid)
export function userId(name) { if (/^\d+$/.test(name)) return Number(name); return load().users.find(([n]) => n === name)?.[1] }
export function groupId(name) { if (/^\d+$/.test(name)) return Number(name); return load().groups.find(([n]) => n === name)?.[1] }

export const permText = perm => `${perm & 4 ? 'r' : '-'}${perm & 2 ? 'w' : '-'}${perm & 1 ? 'x' : '-'}`

/** `user::rw-` lines, with `#effective:` when the mask takes permissions away */
export function lines(entries, { numeric = false, effective = true, prefix = '' } = {}) {
  const mask = find(entries, MASK)?.perm
  const kinds = { [USER_OBJ]: 'user', [USER]: 'user', [GROUP_OBJ]: 'group', [GROUP]: 'group', [MASK]: 'mask', [OTHER]: 'other' }
  return sorted(entries).map(entry => {
    const named = entry.tag === USER ? (numeric ? String(entry.id) : userName(entry.id)) : entry.tag === GROUP ? (numeric ? String(entry.id) : groupName(entry.id)) : ''
    const text = `${prefix}${kinds[entry.tag]}:${named}:${permText(entry.perm)}`
    const masked = effective && mask !== undefined && (entry.tag === USER || entry.tag === GROUP || entry.tag === GROUP_OBJ) && (entry.perm & ~mask & 7)
    return masked ? `${text.padEnd(32)}#effective:${permText(entry.perm & mask)}` : text
  })
}

/** `rwx`, `r-x`, `---`, or an octal digit, as setfacl reads permissions; `X` is execute for a directory only */
export function parsePerm(text, isDir = false) {
  if (/^[0-7]$/.test(text)) return Number(text)
  if (!/^[rwxX-]{1,3}$/.test(text)) return undefined
  let perm = 0
  for (const letter of text) perm |= letter === 'r' ? 4 : letter === 'w' ? 2 : letter === 'x' ? 1 : letter === 'X' && isDir ? 1 : 0
  return perm
}

/** One ACL entry spec: `[default:]u[ser]:[name]:perms`, `g[roup]`, `m[ask]`, `o[ther]`. Returns `{ def, tag, id, perm }` or `{ error }`. */
export function parseSpec(spec, { remove = false } = {}) {
  const parts = spec.trim().split(':')
  let def = false
  if (/^d(efault)?$/.test(parts[0])) { def = true; parts.shift() }
  const kind = parts.shift()
  const tagOf = { u: USER, user: USER, g: GROUP, group: GROUP, m: MASK, mask: MASK, o: OTHER, other: OTHER }[kind]
  if (tagOf === undefined) return { error: `Invalid entry type: ${kind}` }
  let qualifier = ''
  let perm
  if (remove) qualifier = parts[0] ?? ''
  else {
    if (parts.length >= 2) qualifier = parts[0]
    const text = parts.length >= 2 ? parts[1] : parts[0]
    perm = text === undefined ? undefined : parsePerm(text, true)
    if (perm === undefined) return { error: `Invalid permissions in entry: ${spec}` }
  }
  let tag = tagOf
  let id
  if (tagOf === USER || tagOf === GROUP) {
    if (qualifier === '' || qualifier === undefined) tag = tagOf === USER ? USER_OBJ : GROUP_OBJ
    else {
      id = (tagOf === USER ? userId : groupId)(qualifier)
      if (id === undefined) return { error: `${qualifier}: ${tagOf === USER ? 'Invalid user' : 'Invalid group'} name` }
    }
  } else if (qualifier) return { error: `Invalid entry: ${spec}` }
  return { def, tag, id: id ?? NO_ID, perm }
}
