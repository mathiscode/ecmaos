/**
 * Minimal POSIX path helpers for worker-hosted coreutil programs.
 *
 * Deliberately hand-written rather than `import path from 'path'` -- not because a real import
 * would break the way `@zenfs/linux/uapi/*` does (this carries no shared runtime state to diverge
 * across bundles), but because every migrated coreutil bundles independently (see
 * `vite-plugin-bin-node.ts`) and this is small enough that hand-writing it avoids pulling in
 * `vite-plugin-node-polyfills`'s full `path` shim N times over for four functions.
 */

/** Collapse `.`/`..`/empty segments and join with `/`, the way `path.resolve` does for one path. */
function normalize(path) {
  const absolute = path.startsWith('/')
  const segments = path.split('/')
  const stack = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') { if (stack.length && stack[stack.length - 1] !== '..') stack.pop(); else if (!absolute) stack.push('..') }
    else stack.push(segment)
  }
  const joined = stack.join('/')
  return absolute ? `/${joined}` : (joined || '.')
}

/** `path.resolve(cwd, target)` -- `target` relative to `cwd` if it isn't already absolute. */
export function resolve(cwd, target) {
  if (target.startsWith('/')) return normalize(target)
  return normalize(`${cwd}/${target}`)
}

/** `path.basename(path)` */
export function basename(path) {
  const trimmed = path.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  return idx === -1 ? trimmed : trimmed.slice(idx + 1)
}

/** `path.dirname(path)` */
export function dirname(path) {
  const trimmed = path.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  if (idx === -1) return '.'
  if (idx === 0) return '/'
  return trimmed.slice(0, idx)
}

/** `path.join(...parts)` */
export function join(...parts) {
  return normalize(parts.join('/'))
}
