/**
 * A package's `share/` tree is linked into `/usr/share` file by file, so two packages can each add a manual page to
 * `man1` or a document under `docs/@scope`. Only the listed directories are linked.
 */

import { join } from './path-utils.mjs'

const { readdir, symlink, unlink, readlink, isDirectory, mkdir, access } = globalThis.ecmaosSyscalls

export const SHARE_DIRS = ['applications', 'docs', 'licenses', 'man']

const entries = path => readdir(path).map(entry => (typeof entry === 'string' ? entry : entry.name))
const exists = path => { try { access(path); return true } catch { return false } }

function mkdirp(path) {
  if (path === '/' || exists(path)) return
  mkdirp(path.slice(0, path.lastIndexOf('/')) || '/')
  mkdir(path, 0o755)
}

/** Links each file under `source` to the same place under `target`, replacing a link an earlier version left. Returns the links made. */
export function linkTree(source, target) {
  const linked = []
  for (const name of entries(source)) {
    const from = join(source, name)
    const to = join(target, name)
    if (isDirectory(from)) { linked.push(...linkTree(from, to)); continue }
    mkdirp(target)
    try { unlink(to) } catch { /* not there yet */ }
    symlink(from, to)
    linked.push(to)
  }
  return linked
}

/** Removes the links under `target` that point into `source`, leaving the ones another package made */
export function unlinkTree(source, target) {
  for (const name of entries(source)) {
    const from = join(source, name)
    const to = join(target, name)
    if (isDirectory(from)) { unlinkTree(from, to); continue }
    try { if (readlink(to) === from) unlink(to) } catch { /* not linked */ }
  }
}
