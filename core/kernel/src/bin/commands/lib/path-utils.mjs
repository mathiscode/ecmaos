/**
 * Minimal POSIX path helpers for the kernel commands; a copy of `@ecmaos/coreutils`' `path-utils.mjs`, since each
 * command bundles independently.
 */

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

/** `path.resolve(cwd, target)` - `target` relative to `cwd` if it isn't already absolute. */
export function resolve(cwd, target) {
  if (target.startsWith('/')) return normalize(target)
  return normalize(`${cwd}/${target}`)
}

/** `path.join(...parts)` */
export function join(...parts) {
  return normalize(parts.join('/'))
}
