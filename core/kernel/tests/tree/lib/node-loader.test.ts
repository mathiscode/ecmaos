import { describe, expect, it } from 'vitest'
import { transform } from 'sucrase'

import { createLoader } from '../../../src/bin/loader/loader.mjs'
import { normalize } from '../../../src/bin/loader/resolve.mjs'

/** A file system of text files and symlinks, as the resolver's host wants it */
function memory(files: Record<string, string>, links: Record<string, string> = {}) {
  const directories = new Set<string>(['/'])
  for (const path of [...Object.keys(files), ...Object.keys(links)]) {
    for (let at = path.lastIndexOf('/'); at > 0; at = path.lastIndexOf('/', at - 1)) directories.add(path.slice(0, at))
  }
  const follow = (path: string): string => {
    for (const [link, target] of Object.entries(links)) {
      if (path === link) return follow(target.startsWith('/') ? target : normalize(`${link.slice(0, link.lastIndexOf('/'))}/${target}`))
      if (path.startsWith(link + '/')) return follow(follow(link) + path.slice(link.length))
    }
    return path
  }
  return {
    kind: (path: string) => { const real = follow(normalize(path)); return real in files ? 'file' : directories.has(real) ? 'dir' : null },
    readlink: (path: string) => links[path] ?? null,
    readdir: (path: string) => [...new Set([...Object.keys(files), ...directories].filter(entry => entry.startsWith(path + '/') && entry !== path).map(entry => entry.slice(path.length + 1).split('/')[0]!))],
    readText: (path: string) => files[follow(path)]!
  }
}

const B = '/usr/lib/node/builtins'
const baseFiles = {
  [`${B}/path.cjs`]: "exports.join = (...p) => p.join('/')",
  [`${B}/events.cjs`]: 'module.exports = class EventEmitter { constructor() { this.n = 0 } }'
}
const json = (value: unknown) => JSON.stringify(value)

/** Runs `/app/main.js` (or another entry) in a loader over `files` and gives `globalThis.__result` that the program set */
async function run(files: Record<string, string>, entry = '/app/main.js', links: Record<string, string> = {}) {
  ;(globalThis as Record<string, unknown>)['__result'] = undefined
  const loader = createLoader({ host: memory({ ...baseFiles, ...files }, links), transform })
  await loader.runMain(entry)
  // what a program leaves is whatever its test says, read back with `any`
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { result: (globalThis as Record<string, unknown>)['__result'] as any, loader }
}

describe('node module loader', () => {
  describe('CommonJS', () => {
    it('requires relative files, JSON and directories, passes module.exports through, and evaluates a file once', async () => {
      const { result } = await run({
        '/app/main.js': "const a = require('./a'); const b = require('./a.js'); const data = require('./data.json'); const lib = require('./lib'); globalThis.__result = { same: a === b, a: a.name, count: global.__count, data, lib: lib.tag }",
        '/app/a.js': "global.__count = (global.__count || 0) + 1; exports.name = 'a'",
        '/app/data.json': '{"k": [1, 2]}',
        '/app/lib/index.js': "module.exports = function lib() {}; module.exports.tag = 'lib'"
      })
      expect(result.same).toBe(true)
      expect(result.a).toBe('a')
      expect(result.count).toBe(1)
      expect(result.data).toEqual({ k: [1, 2] })
      expect(result.lib).toBe('lib')
    })

    it('gives a file its __filename, __dirname, module, this and require.main, with the shebang ignored', async () => {
      const { result } = await run({
        '/app/main.js': "#!/usr/bin/env node\nconst sub = require('./sub'); globalThis.__result = { f: __filename, d: __dirname, id: module.id, thisIsExports: this === module.exports, main: require.main === module, sub }",
        '/app/sub.js': "module.exports = { main: require.main.filename, mine: module.id, parent: module.parent.filename }"
      })
      expect(result).toMatchObject({ f: '/app/main.js', d: '/app', id: '.', thisIsExports: true, main: true })
      expect(result.sub).toEqual({ main: '/app/main.js', mine: '/app/sub.js', parent: '/app/main.js' })
    })

    it('lets a cycle see the exports so far', async () => {
      const { result } = await run({
        '/app/main.js': "const a = require('./a'); globalThis.__result = { fromA: a.fromB, aDone: a.done }",
        '/app/a.js': "exports.early = 1; const b = require('./b'); exports.fromB = b.sawEarly; exports.done = true",
        '/app/b.js': "const a = require('./a'); exports.sawEarly = a.early; exports.sawDone = a.done"
      })
      expect(result).toEqual({ fromA: 1, aDone: true })
    })

    it('finds packages through node_modules, follows install\'s links, and uses exports', async () => {
      const files = {
        '/usr/lib/app/1.0.0/package.json': json({ name: 'app' }),
        '/usr/lib/app/1.0.0/cli.js': "#!/usr/bin/env node\nconst dep = require('dep'); const sub = require('dep/feature'); globalThis.__result = { dep: dep(), sub, where: __filename }",
        '/usr/lib/dep/2.0.0/package.json': json({ name: 'dep', exports: { '.': { require: './main.cjs', import: './main.mjs' }, './feature': './feature.js' } }),
        '/usr/lib/dep/2.0.0/main.cjs': "const inner = require('inner'); module.exports = () => 'dep+' + inner",
        '/usr/lib/dep/2.0.0/feature.js': "module.exports = 'feature'",
        '/usr/lib/dep/2.0.0/node_modules/inner/package.json': json({ main: 'i.js' }),
        '/usr/lib/dep/2.0.0/node_modules/inner/i.js': "module.exports = 'inner'"
      }
      const links = { '/usr/lib/app/1.0.0/node_modules/dep': '../../../dep/2.0.0', '/usr/bin/app': '/usr/lib/app/1.0.0/cli.js' }
      const { result } = await run(files, '/usr/bin/app', links)
      expect(result).toEqual({ dep: 'dep+inner', sub: 'feature', where: '/usr/lib/app/1.0.0/cli.js' })
    })

    it('loads a built-in module on demand, with or without node:, and gives the same object each time', async () => {
      const { result } = await run({
        '/app/main.js': "const a = require('path'); const b = require('node:path'); const E = require('events'); globalThis.__result = { same: a === b, joined: a.join('x', 'y'), ee: new E().n }"
      })
      expect(result).toEqual({ same: true, joined: 'x/y', ee: 0 })
    })

    it('says which module is missing and which file asked for it', async () => {
      await expect(run({ '/app/main.js': "require('./nope')" })).rejects.toThrow(/Cannot find module '\.\/nope'\nRequire stack:\n- \/app\/main\.js/)
      await expect(run({ '/app/main.js': "require('nope-pkg')" })).rejects.toMatchObject({ code: 'MODULE_NOT_FOUND' })
    })

    it('forgets a module whose evaluation threw, so requiring it again throws again', async () => {
      const { result } = await run({
        '/app/main.js': "let n = 0; for (let i = 0; i < 2; i++) { try { require('./bad') } catch (e) { n++ } } globalThis.__result = n",
        '/app/bad.js': "throw new Error('boom')"
      })
      expect(result).toBe(2)
    })
  })

  describe('ES modules', () => {
    it('imports files and packages, with default, named and namespace bindings and re-exports', async () => {
      const { result } = await run({
        '/app/package.json': json({ type: 'module' }),
        '/app/main.js': "import def, { named, renamed as r } from './lib.js'\nimport * as ns from './lib.js'\nimport { reexported } from './re.js'\nimport path from 'node:path'\nglobalThis.__result = { def, named, r, ns: Object.keys(ns).sort(), reexported, path: path.join('a', 'b') }",
        '/app/lib.js': "export default 'D'\nexport const named = 'N'\nconst local = 'R'\nexport { local as renamed }",
        '/app/re.js': "export * from './lib.js'\nexport { named as reexported } from './lib.js'"
      })
      expect(result.def).toBe('D')
      expect(result.named).toBe('N')
      expect(result.r).toBe('R')
      expect(result.reexported).toBe('N')
      expect(result.ns).toEqual(['default', 'named', 'renamed'])
      expect(result.path).toBe('a/b')
    })

    it('keeps live bindings: an importer sees an export change', async () => {
      const { result } = await run({
        '/app/main.mjs': "import { count, inc } from './counter.mjs'\nconst before = count\ninc()\nglobalThis.__result = [before, count]",
        '/app/counter.mjs': 'export let count = 0\nexport function inc() { count++ }'
      }, '/app/main.mjs')
      expect(result).toEqual([0, 1])
    })

    it('awaits a module with top-level await before the module that imports it', async () => {
      const { result } = await run({
        '/app/main.mjs': "import { value } from './slow.mjs'\nglobalThis.__result = value",
        '/app/slow.mjs': "export const value = await new Promise(resolve => setTimeout(() => resolve('late'), 5))"
      }, '/app/main.mjs')
      expect(result).toBe('late')
    })

    it('runs an entry that uses top-level await itself', async () => {
      const { result } = await run({ '/app/main.mjs': "const x = await Promise.resolve(41)\nglobalThis.__result = x + 1" }, '/app/main.mjs')
      expect(result).toBe(42)
    })

    it('imports a CommonJS module: module.exports is the default, and its keys are named exports', async () => {
      const { result } = await run({
        '/app/main.mjs': "import cjs, { alpha } from './c.cjs'\nimport * as all from './c.cjs'\nglobalThis.__result = { alpha, same: cjs.alpha === alpha, keys: Object.keys(all).filter(k => k !== 'default' && k !== '__esModule').sort() }",
        '/app/c.cjs': "exports.alpha = 'a'; exports.beta = 'b'"
      }, '/app/main.mjs')
      expect(result).toEqual({ alpha: 'a', same: true, keys: ['alpha', 'beta'] })
    })

    it('lets CommonJS require an ES module, but not one that awaits at the top level', async () => {
      const { result } = await run({
        '/app/main.js': "const ok = require('./e.mjs'); let error; try { require('./tla.mjs') } catch (e) { error = e.code } globalThis.__result = { value: ok.value, def: ok.default, error }",
        '/app/e.mjs': "export const value = 7\nexport default 'dflt'",
        '/app/tla.mjs': 'await 0\nexport const x = 1'
      })
      expect(result).toEqual({ value: 7, def: 'dflt', error: 'ERR_REQUIRE_ASYNC_MODULE' })
    })

    it('resolves the import condition of a package\'s exports, and the require condition from CommonJS', async () => {
      const files = {
        '/n/node_modules/dual/package.json': json({ exports: { import: './esm.mjs', require: './cjs.cjs' } }),
        '/n/node_modules/dual/esm.mjs': "export default 'esm'",
        '/n/node_modules/dual/cjs.cjs': "module.exports = 'cjs'",
        '/n/a.mjs': "import dual from 'dual'\nglobalThis.__result = [dual, ...(globalThis.__result || [])]",
        '/n/b.js': "globalThis.__result = [require('dual')]"
      }
      expect((await run(files, '/n/a.mjs')).result).toEqual(['esm'])
      expect((await run(files, '/n/b.js')).result).toEqual(['cjs'])
    })

    it('gives import.meta its url, dirname and filename, and import() a namespace', async () => {
      const { result } = await run({
        '/app/main.mjs': "const m = await import('./dyn.mjs')\nconst c = await import('./c.cjs')\nglobalThis.__result = { url: import.meta.url, dir: import.meta.dirname, file: import.meta.filename, dyn: m.default, named: m.n, cjs: c.default, cjsKey: c.k }",
        '/app/dyn.mjs': "export default 'dyn'\nexport const n = 2",
        '/app/c.cjs': "module.exports = { k: 'kk' }"
      }, '/app/main.mjs')
      expect(result).toEqual({ url: 'file:///app/main.mjs', dir: '/app', file: '/app/main.mjs', dyn: 'dyn', named: 2, cjs: { k: 'kk' }, cjsKey: 'kk' })
    })

    it('supports a cycle between two ES modules through function declarations', async () => {
      const { result } = await run({
        '/app/main.mjs': "import { a } from './a.mjs'\nglobalThis.__result = a()",
        '/app/a.mjs': "import { b } from './b.mjs'\nexport function a() { return 'a' + b() }",
        '/app/b.mjs': "import { a } from './a.mjs'\nexport function b() { return typeof a }"
      }, '/app/main.mjs')
      expect(result).toBe('afunction')
    })

    it('treats a .js file as the package type says, and as CommonJS when it compiles as such', async () => {
      const { loader } = await run({
        '/m/package.json': json({ type: 'module' }), '/m/x.js': 'export default 1',
        '/c/package.json': json({ type: 'commonjs' }), '/c/x.js': 'module.exports = 1',
        '/u/x.js': "module.exports = require('os')", '/u/y.js': 'export const y = 1', '/u/z.js': 'const v = await 1',
        '/app/main.js': 'globalThis.__result = 1'
      })
      expect(loader.formatOf('/m/x.js', 'export default 1')).toBe('esm')
      expect(loader.formatOf('/c/x.js', 'module.exports = 1')).toBe('cjs')
      expect(loader.formatOf('/u/x.js', "module.exports = require('os')")).toBe('cjs')
      expect(loader.formatOf('/u/y.js', 'export const y = 1')).toBe('esm')
      expect(loader.formatOf('/u/z.js', 'const v = await 1')).toBe('esm')
    })
  })

  describe('which programs take the loader', () => {
    const { loader } = { loader: createLoader({ host: memory({}), transform }) }

    it('takes CommonJS and ES modules that import files or packages', () => {
      expect(loader.needsLoader('/a/f1.js', "const fs = require('fs')\nfs.readFileSync('x')")).toBe(true)
      expect(loader.needsLoader('/a/f2.cjs', 'console.log(1)')).toBe(true)
      expect(loader.needsLoader('/a/f3.mjs', "import { a } from './a.js'\nconsole.log(a)")).toBe(true)
      expect(loader.needsLoader('/a/f4.mjs', "import path from 'node:path'")).toBe(true)
      expect(loader.needsLoader('/a/f5.mjs', "export * from './y.js'")).toBe(true)
    })

    it('leaves a single-file program, one with top-level await, and one that imports a URL to import natively', () => {
      expect(loader.needsLoader('/a/f6.js', 'const { exit } = globalThis.ecmaosSyscalls\nexit(await Promise.resolve(0))')).toBe(false)
      expect(loader.needsLoader('/a/f7.mjs', 'console.log(import.meta.url)')).toBe(false)
      expect(loader.needsLoader('/a/f8.js', "import x from 'https://esm.sh/x'\nconsole.log(x)")).toBe(false)
      expect(loader.needsLoader('/a/f9.js', "const m = await import('https://esm.sh/x')")).toBe(false)
      expect(loader.needsLoader('/a/f10.js', 'const important = 1\nconsole.log(important)')).toBe(false)
    })
  })
})
