/**
 * Minimal POSIX path helpers for worker-hosted kernel-native command programs -- a copy of
 * `@ecmaos/coreutils/src/commands-execve/lib/path-utils.mjs`, not a shared import: every migrated
 * command bundles independently (see `vite-plugin-bin-node.ts`), and `src/bin/commands/*.mjs`
 * (kernel-native, no @ecmaos/coreutils dependency) needs its own copy for the same reason that file's
 * own doc comment gives for not just `import path from 'path'`.
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

/** `path.resolve(cwd, target)` -- `target` relative to `cwd` if it isn't already absolute. */
export function resolve(cwd, target) {
  if (target.startsWith('/')) return normalize(target)
  return normalize(`${cwd}/${target}`)
}

/** `path.join(...parts)` */
export function join(...parts) {
  return normalize(parts.join('/'))
}
