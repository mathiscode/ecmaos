/** The mount table as `/proc/mounts` lists it, and the questions `findmnt` and `mountpoint` ask of it. */

import { readTextFile } from './fs-text.mjs'

const { getcwd, isSymbolicLink, readlink } = globalThis.ecmaosSyscalls

/** @returns {Array<{ source: string, target: string, fstype: string, options: string }>} in table order */
export function readMounts(path = '/proc/mounts') {
  return readTextFile(path).split('\n').filter(line => line.trim()).map(line => {
    // a space, tab, newline or backslash in a field is written as an octal escape
    const [source, target, fstype, options] = line.split(/\s+/).map(field => field.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8))))
    return { source, target, fstype, options: options ?? '' }
  })
}

/** The absolute path with every symbolic link followed (`follow` false leaves a link in the last component alone) */
export function canonical(path, follow = true) {
  let pending = (path.startsWith('/') ? path : `${getcwd()}/${path}`).split('/').filter(Boolean)
  let done = []
  let hops = 0
  while (pending.length) {
    const name = pending.shift()
    if (name === '.') continue
    if (name === '..') { done.pop(); continue }
    const here = '/' + [...done, name].join('/')
    let target
    try {
      if ((pending.length || follow) && isSymbolicLink(here)) target = readlink(here)
    } catch { /* a missing component is the caller's to report */ }
    if (target === undefined) { done.push(name); continue }
    if (++hops > 40) throw Object.assign(new Error('ELOOP'), { code: 'ELOOP' })
    if (target.startsWith('/')) done = []
    pending = [...target.split('/').filter(Boolean), ...pending]
  }
  return '/' + done.join('/')
}

/** The mount that holds `path`: the one with the longest target that is `path` or a parent of it; the last of equals wins */
export function mountFor(mounts, path) {
  let best
  for (const mount of mounts) {
    const target = mount.target === '/' ? '' : mount.target
    if (path === mount.target || path === target || path.startsWith(target + '/')) {
      if (!best || mount.target.length >= best.target.length) best = mount
    }
  }
  return best
}
