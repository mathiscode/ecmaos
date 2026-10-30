/**
 * Node's module resolution, over a small file-system interface (`host`), so it can be tested without a kernel.
 *
 * `resolve(specifier, from, mode)` answers `{ builtin: 'fs' }` or `{ path }` (a real path, symlinks followed, since a
 * package's own dependencies are found from where it really is). It follows Node: `node:` and bare built-in names;
 * relative and absolute paths with the extensions and directory `main`/`index` Node tries; `#imports`; and bare
 * package names, found by walking up through every `node_modules`, with `exports` (conditions, subpath patterns) or
 * `main`. A package no `node_modules` has is looked for in `globalLibs` (`/usr/lib`, `~/.local/lib`), where `install`
 * puts its packages as `NAME/VERSION`, and the highest version there is the one found; that is how a package installed
 * before `node_modules` was laid out still resolves.
 *
 * `host`: `kind(path)` is `'file'`, `'dir'` or `null` (following links); `readlink(path)` is the link's target or
 * `null` when the path is not a link; `readdir(path)`; `readText(path)`.
 */

const EXTENSIONS = ['.js', '.json', '.mjs', '.cjs']
const BUILTIN_NAME = /^[a-z][a-z0-9_]*(?:\/[a-z][a-z0-9_]*)?\/?$/

export class ResolveError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

const join = (...parts) => normalize(parts.join('/'))

export function normalize(path) {
  const absolute = path.startsWith('/')
  const stack = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') { if (stack.length && stack[stack.length - 1] !== '..') stack.pop(); else if (!absolute) stack.push('..') } else stack.push(segment)
  }
  const joined = stack.join('/')
  return absolute ? `/${joined}` : (joined || '.')
}

export const dirname = path => (path.lastIndexOf('/') > 0 ? path.slice(0, path.lastIndexOf('/')) : '/')

/** `[major, minor, patch]` of a version directory name, or `undefined` for one that is not a release */
function versionOf(name) {
  const match = /^(\d+)\.(\d+)\.(\d+)(-.*)?$/.exec(name)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ? 0 : 1] : undefined
}

const compareVersions = (a, b) => { for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0 }

/** The `exports`/`imports` target for a condition set: a string, `null` (blocked) or `undefined` (no match) */
function resolveTarget(target, conditions, patternMatch) {
  if (typeof target === 'string') return patternMatch === undefined ? target : target.replaceAll('*', patternMatch)
  if (target === null) return null
  if (Array.isArray(target)) {
    for (const item of target) {
      const found = resolveTarget(item, conditions, patternMatch)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (target && typeof target === 'object') {
    for (const [key, value] of Object.entries(target)) {
      if (key !== 'default' && !conditions.has(key)) continue
      const found = resolveTarget(value, conditions, patternMatch)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/** Looks `subpath` (`.`, `./x`) up in an `exports` or `imports` map; gives the target string, `null` or `undefined` */
function lookup(map, subpath, conditions) {
  if (Object.hasOwn(map, subpath) && !subpath.includes('*')) return resolveTarget(map[subpath], conditions)
  let best
  for (const key of Object.keys(map)) {
    const star = key.indexOf('*')
    if (star < 0) continue
    const prefix = key.slice(0, star)
    const suffix = key.slice(star + 1)
    if (subpath.startsWith(prefix) && subpath.length >= key.length && subpath.endsWith(suffix) && (!best || prefix.length > best.prefix.length)) best = { key, prefix, suffix }
  }
  if (!best) return undefined
  return resolveTarget(map[best.key], conditions, subpath.slice(best.prefix.length, subpath.length - best.suffix.length))
}

export function createResolver(host, { builtinsDir = '/usr/lib/node/builtins', globalLibs = [], builtins } = {}) {
  const realpaths = new Map()
  const packages = new Map()

  /** `path` with every symlink followed */
  function realpath(path) {
    const cached = realpaths.get(path)
    if (cached) return cached
    let pending = path.split('/').filter(Boolean)
    let resolved = ''
    let links = 0
    while (pending.length) {
      const part = pending.shift()
      if (part === '.') continue
      if (part === '..') { resolved = resolved.slice(0, resolved.lastIndexOf('/')); continue }
      const next = `${resolved}/${part}`
      const target = host.readlink(next)
      if (target === null) { resolved = next; continue }
      if (++links > 40) throw new ResolveError('ELOOP', `${path}: too many levels of symbolic links`)
      if (target.startsWith('/')) resolved = ''
      pending = [...target.split('/').filter(Boolean), ...pending]
    }
    const result = resolved || '/'
    realpaths.set(path, result)
    return result
  }

  /** The parsed `package.json` in `dir`, or `null` */
  function readPackage(dir) {
    if (packages.has(dir)) return packages.get(dir)
    let manifest = null
    if (host.kind(`${dir}/package.json`) === 'file') {
      try { manifest = JSON.parse(host.readText(`${dir}/package.json`)) } catch { manifest = null }
    }
    packages.set(dir, manifest)
    return manifest
  }

  /** The nearest `package.json` at or above `path`: `{ dir, manifest }` */
  function packageScope(path) {
    for (let dir = dirname(path); ; dir = dirname(dir)) {
      if (!dir.endsWith('/node_modules')) {
        const manifest = readPackage(dir)
        if (manifest) return { dir, manifest }
      }
      if (dir === '/') return undefined
    }
  }

  function isBuiltin(name) {
    if (builtins) return builtins.has(name)
    return host.kind(`${builtinsDir}/${name}.cjs`) === 'file'
  }

  function builtinOf(specifier) {
    if (specifier.startsWith('node:')) {
      const name = specifier.slice(5)
      if (!isBuiltin(name)) throw new ResolveError('ERR_UNKNOWN_BUILTIN_MODULE', `No such built-in module: ${specifier}`)
      return name
    }
    // only a bare name is a built-in: `./constants` is a file, whatever the file system makes of `builtins/./constants.cjs`
    if (!BUILTIN_NAME.test(specifier)) return undefined
    // `events/` is how a package asks for the npm polyfill instead of the module; the built-in stands in for it
    const bare = specifier.endsWith('/') ? specifier.slice(0, -1) : specifier
    return isBuiltin(bare) ? bare : undefined
  }

  function tryFile(path) {
    if (host.kind(path) === 'file') return path
    for (const extension of EXTENSIONS) if (host.kind(path + extension) === 'file') return path + extension
    return undefined
  }

  function tryDirectory(path) {
    if (host.kind(path) !== 'dir') return undefined
    const manifest = readPackage(path)
    if (typeof manifest?.main === 'string' && manifest.main) {
      const main = join(path, manifest.main)
      const found = tryFile(main) ?? tryIndex(main)
      if (found) return found
    }
    return tryIndex(path)
  }

  function tryIndex(path) {
    for (const extension of EXTENSIONS) if (host.kind(`${path}/index${extension}`) === 'file') return `${path}/index${extension}`
    return undefined
  }

  const notFound = (specifier, from) => new ResolveError('MODULE_NOT_FOUND', `Cannot find module '${specifier}'\nRequire stack:\n- ${from}`)

  function conditionsFor(mode) {
    return new Set(['node', 'ecmaos', mode === 'import' ? 'import' : 'require', 'module-sync'])
  }

  /** Where a package's `exports` (or its files, without them) put `subpath` (`.`, `./lib/x`) */
  function resolveInPackage(dir, manifest, subpath, mode, specifier, from) {
    if (manifest.exports !== undefined && manifest.exports !== null) {
      const conditions = conditionsFor(mode)
      let map = manifest.exports
      // a string, an array, or a conditions object is the package's main entry
      if (typeof map === 'string' || Array.isArray(map) || !Object.keys(map).some(key => key.startsWith('.'))) map = { '.': map }
      const target = lookup(map, subpath, conditions)
      if (target === undefined || target === null || typeof target !== 'string' || !target.startsWith('./')) {
        throw new ResolveError('ERR_PACKAGE_PATH_NOT_EXPORTED', subpath === '.' ? `No "exports" main defined in ${dir}/package.json` : `Package subpath '${subpath}' is not defined by "exports" in ${dir}/package.json`)
      }
      const path = join(dir, target)
      if (host.kind(path) !== 'file') throw notFound(specifier, from)
      return path
    }
    if (subpath === '.') {
      const found = tryDirectory(dir)
      if (found) return found
      throw notFound(specifier, from)
    }
    const path = join(dir, subpath)
    const found = tryFile(path) ?? tryDirectory(path)
    if (found) return found
    throw notFound(specifier, from)
  }

  /** The directory of package `name` as seen from `fromDir`: the nearest `node_modules`, then the global libraries */
  function findPackage(name, fromDir) {
    for (let dir = fromDir; ; dir = dirname(dir)) {
      if (!dir.endsWith('/node_modules')) {
        const candidate = `${dir === '/' ? '' : dir}/node_modules/${name}`
        if (host.kind(candidate) === 'dir') return realpath(candidate)
      }
      if (dir === '/') break
    }
    for (const lib of globalLibs) {
      const base = `${lib}/${name}`
      if (host.kind(base) !== 'dir') continue
      let versions
      try { versions = host.readdir(base) } catch { continue }
      const best = versions.map(version => ({ version, parsed: versionOf(version) })).filter(item => item.parsed).sort((a, b) => compareVersions(b.parsed, a.parsed))[0]
      if (best) return `${base}/${best.version}`
    }
    return undefined
  }

  /**
   * @param specifier what was imported or required
   * @param from the real path of the file that did (a directory when it is a program's working directory)
   * @param mode `'import'` or `'require'`, which `exports` conditions apply
   */
  function resolve(specifier, from, mode = 'require') {
    const builtin = builtinOf(specifier)
    if (builtin !== undefined) return { builtin }
    if (specifier.startsWith('file://')) specifier = decodeURIComponent(new URL(specifier).pathname)
    const fromDir = host.kind(from) === 'dir' ? from : dirname(from)

    if (specifier.startsWith('/') || specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../')) {
      const path = specifier.startsWith('/') ? normalize(specifier) : join(fromDir, specifier)
      const found = (specifier.endsWith('/') ? undefined : tryFile(path)) ?? tryDirectory(path)
      if (!found) throw notFound(specifier, from)
      return { path: realpath(found) }
    }

    if (specifier.startsWith('#')) {
      const scope = packageScope(join(fromDir, 'x'))
      const target = scope?.manifest.imports ? lookup(scope.manifest.imports, specifier, conditionsFor(mode)) : undefined
      if (typeof target !== 'string') throw new ResolveError('ERR_PACKAGE_IMPORT_NOT_DEFINED', `Package import specifier "${specifier}" is not defined in package ${scope?.dir ?? fromDir}/package.json imported from ${from}`)
      if (target.startsWith('./')) {
        const path = join(scope.dir, target)
        if (host.kind(path) !== 'file') throw notFound(specifier, from)
        return { path: realpath(path) }
      }
      return resolve(target, from, mode)
    }

    const match = /^((?:@[^/]+\/)?[^/]+)(\/.*)?$/.exec(specifier)
    if (!match) throw notFound(specifier, from)
    const [, name, rest = ''] = match
    const dir = findPackage(name, fromDir)
    if (!dir) throw notFound(specifier, from)
    const manifest = readPackage(dir) ?? {}
    return { path: realpath(resolveInPackage(dir, manifest, rest ? `.${rest}` : '.', mode, specifier, from)) }
  }

  return { resolve, realpath, packageScope, readPackage, isBuiltin }
}
