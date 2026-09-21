/** Resolves `target` against `cwd`, collapsing `.` and `..` -- `path.resolve`, for programs with no `path` module. */
export function resolvePath(cwd, target) {
  const parts = (target.startsWith('/') ? target : `${cwd}/${target}`).split('/')
  const resolved = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') resolved.pop()
    else resolved.push(part)
  }
  return '/' + resolved.join('/')
}

export const basename = path => path.slice(path.lastIndexOf('/') + 1)
