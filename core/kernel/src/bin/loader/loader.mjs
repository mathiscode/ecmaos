/**
 * Runs a program that needs more than its own file: one that `require`s or `import`s other files, packages from
 * `node_modules`, or Node's built-in modules.
 *
 * Every module is a function over `(exports, require, module, __filename, __dirname)` in a registry keyed by real path,
 * as in Node, so a module is evaluated once however it is reached, a cycle sees the exports so far, and a package's
 * dependencies are the ones its `node_modules` lists. A CommonJS file runs as it is. An ES module is converted first
 * (`sucrase`, which turns `import` and `export` into `require` and `exports`, keeping live bindings by reading
 * through the module object, and which loads only when a program has an ES module to run); top-level `await` makes the
 * module's function asynchronous, and the modules it imports are evaluated before it, in order. `import()` is converted
 * to a `require` in a promise, and `import.meta` to an object of this file's `url`, `dirname` and `filename`.
 *
 * What a module is, by its file: `.mjs` is an ES module, `.cjs` is CommonJS, `.json` is data; `.js` follows the
 * `type` of the nearest `package.json`, and without one it is CommonJS if it compiles as one, as in Node.
 *
 * The built-in modules (`fs`, `path`, ...) are CommonJS files in `builtinsDir`, loaded the same way and on demand.
 */

import { ResolveError, createResolver, dirname } from './resolve.mjs'

const SHEBANG = /^#!.*/
/** `#!/usr/bin/env node`, which every npm command starts with */
const NODE_SHEBANG = /^#!.*\bnode\b/
const USES_COMMONJS = /\b(?:require\s*\(|module\.exports|exports\.\w|__dirname|__filename)/
const BOUNDARY = '(?:^|[\\n;{})])\\s*'
const HAS_MODULE_SYNTAX = new RegExp(`${BOUNDARY}(?:import(?:\\s+[\\w$*{"']|\\s*[{*"'])|export(?:\\s+(?:default|(?:async\\s+)?(?:function|class)|const|let|var)\\b|\\s*[{*])|import\\.meta\\b)`)
const HAS_DYNAMIC_IMPORT = /(?:^|[^.\w$])import\s*\(/
const STATIC_REQUIRE = /(?<!_interopRequireWildcard\()\brequire\(\s*(["'])((?:(?!\1)[^\\\n])+)\1\s*\)/g
/** The specifiers of `import ... from 'x'`, `import 'x'` and `export ... from 'x'` */
const IMPORT_SPECIFIER = new RegExp(`${BOUNDARY}(?:(?:import|export)\\b[^'"\`;]*?\\bfrom\\s*(["'])(.+?)\\1|import\\s*(["'])(.+?)\\3)`, 'g')
const URL_SPECIFIER = /^(?:https?|data|blob|file|node):/

const fileUrl = path => 'file://' + path.split('/').map(encodeURIComponent).join('/')
const stripShebang = source => source.replace(SHEBANG, '//')
const stripBom = source => (source.charCodeAt(0) === 0xFEFF ? source.slice(1) : source)

/** An error with a Node-style `code` */
function codeError(code, message) {
  return Object.assign(new Error(message), { code })
}

class Module {
  constructor(id, parent) {
    this.id = id
    this.filename = id
    this.path = dirname(id)
    this.exports = {}
    this.loaded = false
    this.children = []
    this.paths = []
    this.parent = parent
    /** `'loading'` while its imports are evaluated, `'running'` while its body is, then `'done'` */
    this.status = 'loading'
    for (let dir = this.path; ; dir = dirname(dir)) {
      if (!dir.endsWith('/node_modules')) this.paths.push((dir === '/' ? '' : dir) + '/node_modules')
      if (dir === '/') break
    }
  }
}

/**
 * @param options.host the file system (see `resolve.mjs`), and `readBytes(path)`
 * @param options.builtinsDir where the built-in modules are
 * @param options.globalLibs where `install` puts packages (`/usr/lib`, `~/.local/lib`)
 * @param options.transformPath the converter's CommonJS bundle (sucrase), loaded when an ES module first needs it
 * @param options.transform the converter itself (`sucrase.transform`), when the caller has it
 */
export function createLoader({ host, builtinsDir = '/usr/lib/node/builtins', globalLibs = [], transformPath = '/usr/lib/node/loader/sucrase.cjs', transform: provided }) {
  const resolver = createResolver(host, { builtinsDir, globalLibs })
  const registry = new Map()
  const decoder = new TextDecoder()
  const formats = new Map()
  let transformer
  let main

  const readSource = path => stripBom(host.readText(path))

  function transform(code, options = {}) {
    transformer ??= provided ?? requireFile(transformPath).transform
    return transformer(code, { transforms: ['imports'], disableESTransforms: true, preserveDynamicImport: false, ...options }).code
  }

  /** Evaluates `code` as the body of a function of `params`; `(async function ...)` when `isAsync` */
  function compile(code, filename, params, isAsync) {
    return (0, eval)(`(${isAsync ? 'async ' : ''}function (${params.join(', ')}) {${code}\n})\n//# sourceURL=${fileUrl(filename)}`)
  }

  const CJS_PARAMS = ['exports', 'require', 'module', '__filename', '__dirname']
  // an ES module has no `module`, `__filename` or `__dirname` (it declares its own, as often as not); `exports` and
  // `require` are for the code the conversion writes
  const ESM_PARAMS = ['exports', 'require', '__import_meta']
  const ESM_PARAMS_OWN_REQUIRE = ['exports', '__ecmaos_require', '__import_meta']

  /** Whether `.js` source is CommonJS, by trying it as such: a syntax error is an ES module's `import`, `export` or `await` */
  function compilesAsCommonJs(source, filename) {
    if (HAS_MODULE_SYNTAX.test(source)) return false
    if (!USES_COMMONJS.test(source)) return false
    try { compile(stripShebang(source), filename, CJS_PARAMS, false); return true } catch (error) {
      if (error instanceof SyntaxError) return false
      throw error
    }
  }

  /** `'json'`, `'cjs'` or `'esm'` for a file */
  function formatOf(filename, source) {
    const known = formats.get(filename)
    if (known) return known
    const format = detectFormat(filename, source)
    formats.set(filename, format)
    return format
  }

  function detectFormat(filename, source) {
    if (filename.endsWith('.json')) return 'json'
    if (filename.endsWith('.mjs')) return 'esm'
    if (filename.endsWith('.cjs')) return 'cjs'
    const type = resolver.packageScope(filename)?.manifest.type
    if (type === 'module') return 'esm'
    if (type === 'commonjs') return 'cjs'
    return compilesAsCommonJs(source, filename) ? 'cjs' : 'esm'
  }

  /** What a file becomes: `{ format, code, async, imports }`. `code` is the body of a module function. */
  function prepare(filename, source) {
    // the built-ins and the converter are CommonJS already; converting the converter would need the converter
    if (filename === transformPath || filename.startsWith(`${builtinsDir}/`)) return { format: 'cjs', code: stripShebang(source), async: false, imports: [] }
    const format = formatOf(filename, source)
    if (format === 'json') return { format, code: `module.exports = ${JSON.stringify(JSON.parse(source))}`, async: false, imports: [] }
    if (format === 'cjs') {
      let code = stripShebang(source)
      if (HAS_DYNAMIC_IMPORT.test(code)) code = transform(code)
      return { format, code, async: false, imports: [] }
    }
    // an ES module with nothing to convert is a script in a function, which is what it is to the registry
    const converted = HAS_MODULE_SYNTAX.test(source) || HAS_DYNAMIC_IMPORT.test(source) ? transform(stripShebang(source)) : stripShebang(source)
    let code = converted.replace(/(?<![.\w$])import\.meta\b/g, '__import_meta')
    // a module that makes its own `require` (`createRequire(import.meta.url)`) cannot also be handed one: the calls the
    // conversion wrote, and its own, go to ours, which resolves as its would
    const ownRequire = /(?<![.\w$])(?:const|let|var|function|class)\s+require\b/.test(code)
    const params = ownRequire ? ESM_PARAMS_OWN_REQUIRE : ESM_PARAMS
    if (ownRequire) code = code.replace(/(?<![.\w$])require\(/g, '__ecmaos_require(')
    const imports = []
    for (const match of code.matchAll(STATIC_REQUIRE)) if (!imports.includes(match[2])) imports.push(match[2])
    let isAsync = false
    try { compile(code, filename, params, false) } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      // top-level await: it compiles only as an async function; a real syntax error comes from this attempt
      compile(code, filename, params, true)
      isAsync = true
    }
    return { format, code, async: isAsync, imports, params }
  }

  function makeRequire(mod, mode) {
    const require = id => {
      if (typeof id !== 'string') throw codeError('ERR_INVALID_ARG_TYPE', 'The "id" argument must be of type string')
      const found = resolver.resolve(id, mod.filename, mode)
      if (found.builtin !== undefined) return requireBuiltin(found.builtin)
      const child = requireFile(found.path, mod)
      return child
    }
    require.resolve = (id, options) => {
      const from = options?.paths?.[0] ? `${options.paths[0].replace(/\/$/, '')}/x` : mod.filename
      const found = resolver.resolve(id, from, mode)
      return found.builtin !== undefined ? (id.startsWith('node:') ? id : `node:${id}`) : found.path
    }
    require.resolve.paths = () => mod.paths
    require.main = main
    require.cache = new Proxy({}, {
      get: (_, key) => registry.get(String(key)),
      has: (_, key) => registry.has(String(key)),
      ownKeys: () => [...registry.keys()],
      getOwnPropertyDescriptor: (_, key) => (registry.has(String(key)) ? { value: registry.get(String(key)), enumerable: true, configurable: true } : undefined),
      deleteProperty: (_, key) => registry.delete(String(key))
    })
    require.extensions = Object.create(null)
    return require
  }

  function makeMeta(filename) {
    return Object.freeze({ url: fileUrl(filename), dirname: dirname(filename), filename, resolve: id => { const found = resolver.resolve(id, filename, 'import'); return found.builtin !== undefined ? `node:${found.builtin}` : fileUrl(found.path) } })
  }

  function createModule(filename, parent) {
    const mod = new Module(filename, parent)
    registry.set(filename, mod)
    if (parent) parent.children.push(mod)
    return mod
  }

  /** Runs a prepared module's function; gives a promise when it is asynchronous */
  function evaluate(mod, prepared) {
    mod.status = 'running'
    const finish = () => { mod.loaded = true; mod.status = 'done'; return mod }
    const fail = error => { registry.delete(mod.filename); throw error }
    try {
      const esm = prepared.format === 'esm'
      const run = compile(prepared.code, mod.filename, esm ? prepared.params : CJS_PARAMS, prepared.async)
      const args = esm ? [mod.exports, makeRequire(mod, 'import'), makeMeta(mod.filename)] : [mod.exports, makeRequire(mod, 'require'), mod, mod.filename, mod.path]
      // `this` is `module.exports` in CommonJS and `undefined` in an ES module
      const result = Reflect.apply(run, esm ? undefined : mod.exports, args)
      if (prepared.async) return result.then(finish, fail)
      return finish()
    } catch (error) {
      return fail(error)
    }
  }

  /** The exports of a file, loading it now; an ES module with top-level `await` cannot be had this way */
  function requireFile(filename, parent) {
    const known = registry.get(filename)
    if (known) return known.exports
    const mod = createModule(filename, parent)
    try {
      const prepared = prepare(filename, readSource(filename))
      if (prepared.async) throw codeError('ERR_REQUIRE_ASYNC_MODULE', `require() cannot load ${filename}: it uses top-level await; import it instead`)
      evaluate(mod, prepared)
    } catch (error) {
      registry.delete(filename)
      throw error
    }
    return mod.exports
  }

  /** Loads a file and what it imports, awaiting any that use top-level `await`, in order; gives its exports */
  async function importFile(filename, parent) {
    const known = registry.get(filename)
    if (known) return known.exports
    const mod = createModule(filename, parent)
    let prepared
    try {
      prepared = prepare(filename, readSource(filename))
      for (const specifier of prepared.imports) {
        let found
        try { found = resolver.resolve(specifier, filename, 'import') } catch { continue }
        if (found.builtin !== undefined) requireBuiltin(found.builtin)
        else await importFile(found.path, mod)
      }
    } catch (error) {
      registry.delete(filename)
      throw error
    }
    await evaluate(mod, prepared)
    return mod.exports
  }

  const builtinCache = new Map()

  function requireBuiltin(name) {
    const key = `node:${name}`
    const known = builtinCache.get(key)
    if (known) return known
    const exports = requireFile(`${builtinsDir}/${name}.cjs`)
    builtinCache.set(key, exports)
    return exports
  }

  /**
   * Runs `filename` as the program: an ES module is imported and awaited; CommonJS is required. `process.mainModule` and
   * `require.main` are the program's module.
   */
  async function runMain(filename) {
    const path = resolver.realpath(filename)
    const prepared = prepare(path, readSource(path))
    main = new Module(path, undefined)
    main.id = '.'
    registry.set(path, main)
    try {
      if (prepared.format === 'esm') {
        for (const specifier of prepared.imports) {
          let found
          try { found = resolver.resolve(specifier, path, 'import') } catch { continue }
          if (found.builtin !== undefined) requireBuiltin(found.builtin)
          else await importFile(found.path, main)
        }
      }
      await evaluate(main, prepared)
    } catch (error) {
      registry.delete(path)
      throw error
    }
    return main.exports
  }

  /** `import(specifier)` from a file: the exports as a namespace, with `default` */
  async function dynamicImport(specifier, from) {
    const found = resolver.resolve(specifier, from, 'import')
    const exports = found.builtin !== undefined ? requireBuiltin(found.builtin) : await importFile(found.path)
    if (exports && exports.__esModule) return exports
    return { ...(exports !== null && typeof exports === 'object' || typeof exports === 'function' ? exports : {}), default: exports }
  }

  /** `module.createRequire(filename)`: a `require` that resolves from `filename` */
  function createRequire(filename) {
    const path = filename.startsWith('file://') ? decodeURIComponent(new URL(filename).pathname) : filename
    const mod = new Module(path, undefined)
    return makeRequire(mod, 'require')
  }

  /**
   * Whether a program must be run by the loader: CommonJS, or an ES module that imports files or packages. Anything
   * else (a single file, even one with top-level `await`, `import.meta` or an import of a URL) is imported as it is.
   */
  function needsLoader(filename, source) {
    if (filename.endsWith('.cjs') || filename.endsWith('.json') || NODE_SHEBANG.test(source)) return true
    const specifiers = [...source.matchAll(IMPORT_SPECIFIER)].map(match => match[2] ?? match[4])
    if (specifiers.length) return !specifiers.some(specifier => URL_SPECIFIER.test(specifier) && !specifier.startsWith('node:'))
    return formatOf(filename, source) === 'cjs'
  }

  return { needsLoader, runMain, requireFile, requireBuiltin, importFile, dynamicImport, createRequire, resolver, registry, formatOf, ResolveError, decoder }
}
