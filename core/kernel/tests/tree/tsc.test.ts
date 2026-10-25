import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { buildNpmTarballGzip, sha512Sri } from './fixtures/npm-tarball'
import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

// the test environment stubs the ES import of node:fs, so the real modules come from the process
const builtin = <T>(id: string) => (process as unknown as { getBuiltinModule: (id: string) => T }).getBuiltinModule(id)
const nodeFs = builtin<typeof import('node:fs')>('node:fs')
const nodePath = builtin<typeof import('node:path')>('node:path')
const nodeModule = builtin<typeof import('node:module')>('node:module')

const packageDir = nodePath.resolve(nodePath.dirname(new URL(import.meta.url).pathname), '../../../../apps/tsc')

/** The files `npm pack` would put in the package at `dir` (its `files` list, the manifest and the README/licence files) */
function packFiles(dir: string): Record<string, Uint8Array> {
  const manifest = JSON.parse(nodeFs.readFileSync(nodePath.join(dir, 'package.json'), 'utf8')) as { files?: string[] }
  const files: Record<string, Uint8Array> = {}
  const add = (relative: string) => {
    const full = nodePath.join(dir, relative)
    if (nodeFs.statSync(full).isDirectory()) { for (const name of nodeFs.readdirSync(full)) add(nodePath.join(relative, name)); return }
    files[relative] = new Uint8Array(nodeFs.readFileSync(full))
  }
  for (const relative of ['package.json', ...nodeFs.readdirSync(dir).filter(name => /^(README|LICEN[SC]E|NOTICE)/i.test(name)), ...(manifest.files ?? [])]) add(relative)
  return files
}

/**
 * `tsc` is the `@ecmaos-apps/tsc` package, installed with `install` along with the `@tsrs/wasm` it depends on (tsrs, a Rust
 * port of TypeScript 7, built to WebAssembly). The registry is a local server that serves the two packages exactly as
 * they are on disk after a build.
 */
describe('tsc', () => {
  let kernel: Kernel
  let server: Server
  let registry = ''
  let wasmVersion = ''

  beforeAll(async () => {
    const wasmDir = nodePath.dirname(nodeModule.createRequire(nodePath.join(packageDir, 'package.json')).resolve('@tsrs/wasm/package.json'))
    const packages = {
      '@tsrs/wasm': packFiles(wasmDir),
      '@ecmaos-apps/tsc': packFiles(packageDir)
    }
    const tarballs = new Map<string, { bytes: Uint8Array, integrity: string, version: string }>()
    for (const [name, files] of Object.entries(packages)) {
      const bytes = await buildNpmTarballGzip(files)
      const version = (JSON.parse(new TextDecoder().decode(files['package.json']!)) as { version: string }).version
      tarballs.set(name, { bytes, integrity: await sha512Sri(bytes), version })
    }
    wasmVersion = tarballs.get('@tsrs/wasm')!.version

    const { createServer } = process.getBuiltinModule('node:http')
    server = createServer((req, res) => {
      const url = req.url ?? ''
      for (const [name, { bytes, integrity, version }] of tarballs) {
        if (url === `/${name}`) { res.end(JSON.stringify({ name, 'dist-tags': { latest: version }, versions: { [version]: { dist: { tarball: `${registry}/${name}/-/${version}.tgz`, integrity } } } })); return }
        if (url === `/${name}/-/${version}.tgz`) { res.end(bytes); return }
      }
      res.statusCode = 404
      res.end('not found')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()
  }, 120000)

  afterAll(() => { server?.close() })

  const run = async (command: string) => {
    const code = await kernel.shell.execute(`${command} > /tmp/tsc.out 2> /tmp/tsc.err`)
    return { code, out: await kernel.filesystem.fs.readFile('/tmp/tsc.out', 'utf8'), err: await kernel.filesystem.fs.readFile('/tmp/tsc.err', 'utf8') }
  }

  it('is installed with its compiler, and only tsc is on the path', async () => {
    expect((await run(`install @ecmaos-apps/tsc --registry ${registry}`)).code).toBe(0)
    const { fs } = kernel.filesystem
    expect((await fs.stat(`/usr/lib/@tsrs/wasm/${wasmVersion}/tsrs.wasm`)).size).toBeGreaterThan(5_000_000)
    expect(await fs.exists(`/usr/lib/@tsrs/wasm/${wasmVersion}/NOTICE.txt`)).toBe(true)
    expect(await fs.exists('/usr/bin/tsc')).toBe(true)
    expect(await fs.exists('/usr/bin/tsrs-wasm')).toBe(false)
    expect(await fs.readFile('/usr/share/docs/@ecmaos-apps/tsc/tsc.md', 'utf8')).toContain('# tsc')
  }, 300000)

  it('type-checks a file that is right, and reports one that is wrong', async () => {
    await kernel.filesystem.fs.mkdir('/tmp/ts', { recursive: true })
    await kernel.filesystem.fs.writeFile('/tmp/ts/good.ts', 'export const n: number = 1\n')
    await kernel.filesystem.fs.writeFile('/tmp/ts/bad.ts', 'export const n: number = "one"\n')

    expect(await run('cd /tmp/ts && tsc --noEmit good.ts')).toEqual({ code: 0, out: '', err: '' })

    const bad = await run('cd /tmp/ts && tsc --noEmit bad.ts')
    expect(bad.code).toBe(2)
    expect(bad.out + bad.err).toContain("Type 'string' is not assignable to type 'number'")
  }, 120000)

  it('--json-diagnostics prints the errors as JSON and still exits 2', async () => {
    const result = await run('cd /tmp/ts && tsc --noEmit --json-diagnostics bad.ts')
    expect(result.code).toBe(2)
    const text = (result.out + result.err).trim()
    expect(() => JSON.parse(text.slice(text.indexOf('[') >= 0 && text.indexOf('[') < text.indexOf('{') ? text.indexOf('[') : text.indexOf('{')))).not.toThrow()
    expect(text).toContain('bad.ts')
    expect(text).toContain('2322')
  }, 120000)

  it('writes JavaScript and declarations to the file system', async () => {
    const result = await run('cd /tmp/ts && tsc --outDir out --declaration good.ts')
    expect(result.code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/ts/out/good.js', 'utf8')).toContain('export const n = 1')
    expect(await kernel.filesystem.fs.readFile('/tmp/ts/out/good.d.ts', 'utf8')).toContain('export declare const n: number')
  }, 120000)

  const write = async (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      await kernel.filesystem.fs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true })
      await kernel.filesystem.fs.writeFile(path, text)
    }
  }
  const read = (path: string) => kernel.filesystem.fs.readFile(path, 'utf8')

  it('builds a project from its tsconfig.json: include, compilerOptions, imports between files and the bundled lib', async () => {
    await write({
      '/tmp/proj/tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', outDir: 'dist', rootDir: 'src', declaration: true }, include: ['src'] }),
      '/tmp/proj/src/a.ts': "import { double } from './b.js'\nexport const answer: number = double(21)\nexport const last = [1, 2, 3].at(-1)\nexport const later: Promise<number> = Promise.resolve(answer)\n",
      '/tmp/proj/src/b.ts': 'export const double = (n: number): number => n * 2\n',
      '/tmp/proj/notes/ignored.ts': 'export const x: string = 1\n'
    })

    expect(await run('cd /tmp/proj && tsc')).toEqual({ code: 0, out: '', err: '' })
    expect(await read('/tmp/proj/dist/a.js')).toContain("import { double } from './b.js'")
    expect(await read('/tmp/proj/dist/b.d.ts')).toContain('export declare const double: (n: number) => number')
    expect(await kernel.filesystem.fs.exists('/tmp/proj/dist/ignored.js')).toBe(false)
  }, 120000)

  it('-p takes a directory or a file, and strict from the tsconfig makes the errors', async () => {
    await write({
      '/tmp/strict/tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['*.ts'] }),
      '/tmp/strict/loose.ts': 'export function f(x) { return x }\n'
    })
    for (const project of ['/tmp/strict', '/tmp/strict/tsconfig.json']) {
      const result = await run(`cd /tmp && tsc -p ${project}`)
      expect(result.code).toBe(2)
      expect(result.out + result.err).toMatch(/TS7006|implicitly has an 'any' type/)
    }
    // the same file is fine when the tsconfig says it is
    await write({ '/tmp/strict/tsconfig.json': JSON.stringify({ compilerOptions: { strict: false, noEmit: true }, include: ['*.ts'] }) })
    expect(await run('cd /tmp && tsc -p strict')).toEqual({ code: 0, out: '', err: '' })
  }, 120000)

  it('-b builds the referenced project first, and a second build with nothing changed writes nothing', async () => {
    await write({
      '/tmp/refs/lib/tsconfig.json': JSON.stringify({ compilerOptions: { composite: true, declaration: true, outDir: 'dist', rootDir: 'src', module: 'esnext', target: 'es2022', moduleResolution: 'bundler' }, include: ['src'] }),
      '/tmp/refs/lib/src/index.ts': 'export const greet = (name: string): string => `hello ${name}`\n',
      '/tmp/refs/app/tsconfig.json': JSON.stringify({ compilerOptions: { composite: true, outDir: 'dist', rootDir: 'src', module: 'esnext', target: 'es2022', moduleResolution: 'bundler' }, include: ['src'], references: [{ path: '../lib' }] }),
      '/tmp/refs/app/src/main.ts': "import { greet } from '../../lib/src/index.js'\nexport const message: string = greet('ecmaOS')\n"
    })

    const first = await run('cd /tmp/refs && tsc -b app')
    expect(first.code).toBe(0)
    expect(await read('/tmp/refs/lib/dist/index.d.ts')).toContain('export declare const greet')
    expect(await read('/tmp/refs/app/dist/main.js')).toContain('greet')
    const built = (await kernel.filesystem.fs.stat('/tmp/refs/app/dist/main.js')).mtimeMs

    await new Promise(resolve => setTimeout(resolve, 1100))
    const second = await run('cd /tmp/refs && tsc -b app')
    expect(second.code).toBe(0)
    expect((await kernel.filesystem.fs.stat('/tmp/refs/app/dist/main.js')).mtimeMs).toBe(built)

    // a change to the library rebuilds what depends on it
    await write({ '/tmp/refs/lib/src/index.ts': 'export const greet = (name: string): string => `goodbye ${name}`\n' })
    expect((await run('cd /tmp/refs && tsc -b app')).code).toBe(0)
    expect(await read('/tmp/refs/lib/dist/index.js')).toContain('goodbye')
  }, 180000)

  it('reports an error in a referenced project with its file and position', async () => {
    await write({ '/tmp/refs/lib/src/index.ts': 'export const greet = (name: string): number => `hello ${name}`\n' })
    const result = await run('cd /tmp/refs && tsc -b app')
    expect(result.code).not.toBe(0)
    expect(result.out + result.err).toContain('lib/src/index.ts(1,')
  }, 120000)

  it('says so when the compiler is not where it should be', async () => {
    const result = await run('TSRS_WASM=/nonexistent/tsrs.wasm tsc --noEmit /tmp/ts/good.ts')
    expect(result.code).toBe(2)
    expect(result.err).toContain('cannot read /nonexistent/tsrs.wasm')
  }, 60000)
})
