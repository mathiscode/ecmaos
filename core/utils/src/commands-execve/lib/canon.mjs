/**
 * `realpath(3)` the way GNU `realpath` and `readlink -f` do it: walk the path a component at a time, expanding every
 * symlink (a relative target replaces the component, an absolute one restarts at `/`), resolving `.` and `..` against
 * what has been resolved so far, and giving up after 40 links (`ELOOP`).
 *
 * `mode` says what must exist: `'e'` every component, `'f'` every component but the last, `'m'` nothing. `logical`
 * collapses `..` against the text before any link is expanded (`realpath -L`); `symlinks: false` expands nothing
 * (`realpath -s`). Errors are thrown with an errno `code`.
 */

import { errnoError } from './errno.mjs'

const S_IFMT = 0xf000
const S_IFDIR = 0x4000
const S_IFLNK = 0xa000
const MAX_LINKS = 40

const split = path => path.split('/').filter(part => part !== '' && part !== '.')

/** Collapses `.` and `..` in the text of `path` without looking at the file system */
export function lexical(path) {
  const parts = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return '/' + parts.join('/')
}

export function canonicalize(path, cwd, sys, { mode = 'f', logical = false, symlinks = true } = {}) {
  if (path === '') throw errnoError('ENOENT')
  const absolute = path.startsWith('/') ? path : `${cwd.replace(/\/$/, '')}/${path}`
  const trailingSlash = /\/$/.test(path)
  if (!symlinks) return lexical(absolute)

  let queue = logical ? split(lexical(absolute)) : split(absolute)
  // `..` is kept in the queue unless the logical pass already removed them
  const resolved = []
  let links = 0
  let missing = false

  while (queue.length > 0) {
    const part = queue.shift()
    if (part === '..') { resolved.pop(); continue }
    if (missing) { resolved.push(part); continue }
    const candidate = '/' + [...resolved, part].join('/')
    let stats
    try {
      stats = sys.lstat(candidate)
    } catch (error) {
      const code = error?.code ?? (/ENOENT/.test(String(error?.message)) ? 'ENOENT' : /ENOTDIR/.test(String(error?.message)) ? 'ENOTDIR' : undefined)
      if (mode === 'm' && (code === 'ENOENT' || code === 'ENOTDIR')) { missing = true; resolved.push(part); continue }
      if (code === 'ENOENT' && mode === 'f' && queue.every(rest => rest === '.' || rest === '')) { missing = true; resolved.push(part); continue }
      throw error
    }
    if ((stats.mode & S_IFMT) === S_IFLNK) {
      if (++links > MAX_LINKS) {
        if (mode === 'm') { missing = true; resolved.push(part); continue }
        throw errnoError('ELOOP')
      }
      const target = sys.readlink(candidate)
      if (target.startsWith('/')) resolved.length = 0
      // A link to nothing, as the last component, ends up resolving to where it points (the 'f' mode allows that)
      queue = [...split(target), ...queue]
      continue
    }
    if ((stats.mode & S_IFMT) !== S_IFDIR && queue.length > 0) {
      if (mode !== 'm') throw errnoError('ENOTDIR')
      missing = true
    }
    resolved.push(part)
  }

  const result = '/' + resolved.join('/')
  if (trailingSlash && mode !== 'm' && !missing) {
    let stats
    try { stats = sys.stat(result) } catch { return result }
    if ((stats.mode & S_IFMT) !== S_IFDIR) throw errnoError('ENOTDIR')
  }
  return result
}
