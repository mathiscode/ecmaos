import { describe, expect, it } from 'vitest'

import { createResolver, normalize } from '../../../src/bin/loader/resolve.mjs'

/** A file system of text files and symlinks: `files` maps a path to its text, `links` a path to its target */
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
    kind: (path: string) => { const real = follow(path); return real in files ? 'file' : directories.has(real) ? 'dir' : null },
    readlink: (path: string) => links[path] ?? null,
    readdir: (path: string) => [...new Set([...Object.keys(files), ...directories].filter(entry => entry.startsWith(path + '/') && entry !== path).map(entry => entry.slice(path.length + 1).split('/')[0]!))],
    readText: (path: string) => files[follow(path)]!
  }
}

const json = (value: unknown) => JSON.stringify(value)

describe('node module resolution', () => {
  const builtins = new Set(['fs', 'path', 'fs/promises'])

  it('resolves built-ins with and without node:, and refuses an unknown node: name', () => {
    const { resolve } = createResolver(memory({}), { builtins })
    expect(resolve('node:fs', '/x/a.js')).toEqual({ builtin: 'fs' })
    expect(resolve('fs/promises', '/x/a.js')).toEqual({ builtin: 'fs/promises' })
    // a package's `require('path/')` means the npm package; the built-in is what is there
    expect(resolve('path/', '/x/a.js')).toEqual({ builtin: 'path' })
    expect(() => resolve('node:nope', '/x/a.js')).toThrow(/No such built-in module/)
    expect(() => resolve('nope', '/x/a.js')).toThrow(/Cannot find module 'nope'/)
  })

  it('resolves relative paths with Node\'s extensions, directories, main and index', () => {
    const { resolve } = createResolver(memory({
      '/app/main.js': '', '/app/util.js': '', '/app/data.json': '{}', '/app/lib/index.js': '', '/app/pkg/package.json': json({ main: 'src/entry' }),
      '/app/pkg/src/entry.js': '', '/app/mod.mjs': ''
    }), { builtins })
    expect(resolve('./util', '/app/main.js')).toEqual({ path: '/app/util.js' })
    expect(resolve('./data', '/app/main.js')).toEqual({ path: '/app/data.json' })
    expect(resolve('./lib', '/app/main.js')).toEqual({ path: '/app/lib/index.js' })
    expect(resolve('./pkg', '/app/main.js')).toEqual({ path: '/app/pkg/src/entry.js' })
    expect(resolve('./mod', '/app/main.js')).toEqual({ path: '/app/mod.mjs' })
    expect(resolve('../util.js', '/app/lib/index.js')).toEqual({ path: '/app/util.js' })
    expect(resolve('/app/util.js', '/elsewhere/x.js')).toEqual({ path: '/app/util.js' })
    expect(() => resolve('./missing', '/app/main.js')).toThrow(/Cannot find module '\.\/missing'/)
  })

  it('finds a package in the nearest node_modules, and follows the links install lays out to the real directory', () => {
    const files = {
      '/usr/lib/app/1.0.0/package.json': json({ name: 'app' }),
      '/usr/lib/app/1.0.0/cli.js': '',
      '/usr/lib/dep/2.0.0/package.json': json({ name: 'dep', main: 'dep.js' }),
      '/usr/lib/dep/2.0.0/dep.js': '',
      '/usr/lib/dep/2.0.0/node_modules/inner/package.json': json({ name: 'inner' }),
      '/usr/lib/dep/2.0.0/node_modules/inner/index.js': ''
    }
    const links = { '/usr/lib/app/1.0.0/node_modules/dep': '../../../dep/2.0.0', '/usr/bin/app': '/usr/lib/app/1.0.0/cli.js' }
    const { resolve, realpath } = createResolver(memory(files, links), { builtins })
    expect(realpath('/usr/bin/app')).toBe('/usr/lib/app/1.0.0/cli.js')
    // the importer is the real file, so its dependency is the one linked beside it
    expect(resolve('dep', '/usr/lib/app/1.0.0/cli.js')).toEqual({ path: '/usr/lib/dep/2.0.0/dep.js' })
    // and from inside the dependency, what it was given by its own node_modules
    expect(resolve('inner', '/usr/lib/dep/2.0.0/dep.js')).toEqual({ path: '/usr/lib/dep/2.0.0/node_modules/inner/index.js' })
    expect(() => resolve('inner', '/usr/lib/app/1.0.0/cli.js')).toThrow(/Cannot find module 'inner'/)
  })

  it('falls back to the highest version in the global libraries for a package installed before node_modules was laid out', () => {
    const { resolve } = createResolver(memory({
      '/usr/lib/old/1.2.0/package.json': json({ main: 'a.js' }), '/usr/lib/old/1.2.0/a.js': '',
      '/usr/lib/old/1.10.0/package.json': json({ main: 'b.js' }), '/usr/lib/old/1.10.0/b.js': '',
      '/usr/lib/old/2.0.0-beta.1/package.json': json({ main: 'c.js' }), '/usr/lib/old/2.0.0-beta.1/c.js': '',
      '/usr/lib/@s/scoped/3.0.0/package.json': json({ main: 'd.js' }), '/usr/lib/@s/scoped/3.0.0/d.js': ''
    }), { builtins, globalLibs: ['/usr/lib'] })
    // 2.0.0-beta.1 is a pre-release of 2.0.0, which is above 1.10.0 in order but not a release
    expect(resolve('old', '/home/u/script.js')).toEqual({ path: '/usr/lib/old/2.0.0-beta.1/c.js' })
    expect(resolve('@s/scoped', '/home/u/script.js')).toEqual({ path: '/usr/lib/@s/scoped/3.0.0/d.js' })
  })

  describe('package.json exports', () => {
    const files = {
      '/n/node_modules/p/package.json': json({
        name: 'p',
        exports: {
          '.': { import: './esm/index.mjs', require: './cjs/index.cjs', default: './index.js' },
          './feature': './feature.js',
          './features/*': './features/*.js',
          './features/private/*': null,
          './sub': { node: { import: './sub-esm.mjs', default: './sub.js' } },
          './package.json': './package.json'
        }
      }),
      '/n/node_modules/p/esm/index.mjs': '', '/n/node_modules/p/cjs/index.cjs': '', '/n/node_modules/p/index.js': '',
      '/n/node_modules/p/feature.js': '', '/n/node_modules/p/features/a.js': '', '/n/node_modules/p/features/private/x.js': '',
      '/n/node_modules/p/sub-esm.mjs': '', '/n/node_modules/p/sub.js': '', '/n/node_modules/p/hidden.js': '',
      '/n/node_modules/str/package.json': json({ exports: './only.js' }), '/n/node_modules/str/only.js': '',
      '/n/node_modules/cond/package.json': json({ exports: { require: './r.js', import: './i.mjs' } }), '/n/node_modules/cond/r.js': '', '/n/node_modules/cond/i.mjs': ''
    }
    const { resolve } = createResolver(memory(files), { builtins })

    it('picks the entry by the condition: import for an import, require for a require', () => {
      expect(resolve('p', '/n/a.js', 'import')).toEqual({ path: '/n/node_modules/p/esm/index.mjs' })
      expect(resolve('p', '/n/a.js', 'require')).toEqual({ path: '/n/node_modules/p/cjs/index.cjs' })
      expect(resolve('cond', '/n/a.js', 'require')).toEqual({ path: '/n/node_modules/cond/r.js' })
      expect(resolve('cond', '/n/a.js', 'import')).toEqual({ path: '/n/node_modules/cond/i.mjs' })
    })

    it('takes a string as the main entry, matches subpaths and patterns, and nests conditions', () => {
      expect(resolve('str', '/n/a.js')).toEqual({ path: '/n/node_modules/str/only.js' })
      expect(resolve('p/feature', '/n/a.js')).toEqual({ path: '/n/node_modules/p/feature.js' })
      expect(resolve('p/features/a', '/n/a.js')).toEqual({ path: '/n/node_modules/p/features/a.js' })
      expect(resolve('p/sub', '/n/a.js', 'import')).toEqual({ path: '/n/node_modules/p/sub-esm.mjs' })
      expect(resolve('p/sub', '/n/a.js', 'require')).toEqual({ path: '/n/node_modules/p/sub.js' })
      expect(resolve('p/package.json', '/n/a.js')).toEqual({ path: '/n/node_modules/p/package.json' })
    })

    it('refuses what exports does not list, and what it blocks with null', () => {
      expect(() => resolve('p/hidden', '/n/a.js')).toThrow(/Package subpath '\.\/hidden' is not defined by "exports"/)
      expect(() => resolve('p/features/private/x', '/n/a.js')).toThrow(/not defined by "exports"/)
      expect(() => resolve('p/features/missing', '/n/a.js')).toThrow(/Cannot find module/)
    })
  })

  it('resolves #imports from the package that asks', () => {
    const { resolve } = createResolver(memory({
      '/n/node_modules/q/package.json': json({ imports: { '#internal': './src/internal.js', '#dep': 'dep', '#lib/*': './src/lib/*.js' } }),
      '/n/node_modules/q/src/internal.js': '', '/n/node_modules/q/src/lib/x.js': '', '/n/node_modules/q/index.js': '',
      '/n/node_modules/q/node_modules/dep/package.json': json({ main: 'd.js' }), '/n/node_modules/q/node_modules/dep/d.js': ''
    }), { builtins })
    expect(resolve('#internal', '/n/node_modules/q/index.js')).toEqual({ path: '/n/node_modules/q/src/internal.js' })
    expect(resolve('#lib/x', '/n/node_modules/q/index.js')).toEqual({ path: '/n/node_modules/q/src/lib/x.js' })
    expect(resolve('#dep', '/n/node_modules/q/index.js')).toEqual({ path: '/n/node_modules/q/node_modules/dep/d.js' })
    expect(() => resolve('#nope', '/n/node_modules/q/index.js')).toThrow(/not defined/)
  })

  it('finds the nearest package.json for a file, skipping node_modules directories themselves', () => {
    const { packageScope } = createResolver(memory({
      '/n/package.json': json({ type: 'module' }), '/n/a/b/c.js': '', '/n/node_modules/z/package.json': json({ name: 'z' }), '/n/node_modules/z/lib/x.js': ''
    }), { builtins })
    expect(packageScope('/n/a/b/c.js')?.dir).toBe('/n')
    expect(packageScope('/n/node_modules/z/lib/x.js')?.dir).toBe('/n/node_modules/z')
    expect(packageScope('/other/x.js')).toBeUndefined()
  })
})
