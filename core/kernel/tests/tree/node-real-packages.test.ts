import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { buildNpmTarballGzip, sha512Sri } from './fixtures/npm-tarball'
import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * Real packages from npm, as the monorepo has them installed, with their whole dependency graphs, published to a local
 * registry, installed with `install` and run by `/bin/node`'s loader. This is what the resolver, the ES module conversion
 * and the Node modules are for.
 */
describe('real npm packages run', { timeout: 120000 }, () => {
  const nodeFs = process.getBuiltinModule('node:fs')
  const nodePath = process.getBuiltinModule('node:path')
  const kernelDir = nodePath.resolve(import.meta.dirname, '../..')

  let kernel: Kernel
  let server: Server
  let registry = ''
  const routes = new Map<string, () => { body: string | Uint8Array }>()
  const published = new Set<string>()

  const fs = () => kernel.filesystem.fs
  const run = async (command: string) => {
    await fs().unlink('/tmp/rp-out').catch(() => {})
    await fs().unlink('/tmp/rp-err').catch(() => {})
    const code = await kernel.shell.execute(`${command} > /tmp/rp-out 2> /tmp/rp-err`)
    const read = (name: string) => fs().readFile(`/tmp/rp-${name}`, 'utf-8').catch(() => '')
    return { code, out: await read('out'), err: await read('err') }
  }

  /** The files of a package as npm would pack them (no nested node_modules, maps, declarations or docs) */
  function filesOf(directory: string, prefix = ''): Record<string, Uint8Array> {
    const files: Record<string, Uint8Array> = {}
    for (const entry of nodeFs.readdirSync(nodePath.join(directory, prefix), { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        Object.assign(files, filesOf(directory, relative))
      } else if (!/\.(map|md|d\.ts|d\.mts|d\.cts|ts)$/.test(entry.name) || entry.name.endsWith('.mts') === false && /\.js$/.test(entry.name)) {
        files[relative] = nodeFs.readFileSync(nodePath.join(directory, relative))
      }
    }
    return files
  }

  /** Publishes the package at `directory` and everything it depends on, which pnpm keeps beside it */
  async function publishClosure(name: string, directory = nodeFs.realpathSync(nodePath.join(kernelDir, 'node_modules', name))) {
    const manifest = JSON.parse(nodeFs.readFileSync(nodePath.join(directory, 'package.json'), 'utf8')) as { name: string, version: string, dependencies?: Record<string, string>, optionalDependencies?: Record<string, string> }
    const key = `${manifest.name}@${manifest.version}`
    if (published.has(key)) return
    published.add(key)
    const base = manifest.name.startsWith('@') ? nodePath.dirname(nodePath.dirname(directory)) : nodePath.dirname(directory)
    for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      const location = nodePath.join(base, dependency)
      if (nodeFs.existsSync(location)) await publishClosure(dependency, nodeFs.realpathSync(location))
    }
    const files = filesOf(directory)
    const tarball = await buildNpmTarballGzip(files)
    const integrity = await sha512Sri(tarball)
    routes.set(`/${manifest.name}/-/${manifest.version}.tgz`, () => ({ body: tarball }))
    routes.set(`/${manifest.name}`, () => ({ body: JSON.stringify({ name: manifest.name, 'dist-tags': { latest: manifest.version }, versions: { [manifest.version]: { ...manifest, dist: { tarball: `${registry}/${manifest.name}/-/${manifest.version}.tgz`, integrity } } } }) }))
  }

  const use = async (...names: string[]) => {
    for (const name of names) {
      await publishClosure(name)
      const result = await run(`install ${name} --registry ${registry}`)
      expect(result.code, result.err).toBe(0)
    }
  }

  /** Writes `source` as a program and runs it with `node` */
  const program = async (name: string, source: string, stdin = '') => {
    await fs().writeFile(`/tmp/${name}`, `#!/usr/bin/env node\n${source}\n`)
    if (stdin) await fs().writeFile(`/tmp/${name}.in`, stdin)
    return await run(`node /tmp/${name}${stdin ? ` < /tmp/${name}.in` : ''}`)
  }

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
    const { createServer } = process.getBuiltinModule('node:http')
    server = createServer((req, res) => {
      const route = routes.get(decodeURIComponent(req.url ?? ''))
      if (!route) { res.statusCode = 404; res.end('not found'); return }
      res.end(route().body)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
  }, 60000)

  afterAll(() => { server?.close() })

  it('semver (CommonJS, many files)', async () => {
    await use('semver')
    const result = await program('semver.js', "const semver = require('semver')\nconsole.log(semver.maxSatisfying(['1.2.3', '1.9.0', '2.0.0'], '^1'), semver.valid('1.2.3'), semver.coerce('v2').version, semver.gt('1.2.4', '1.2.3'))")
    expect(result.err).toBe('')
    expect(result.out).toBe('1.9.0 1.2.3 2.0.0 true\n')
  }, 60000)

  it('chalk (ES module with #imports and conditional exports)', async () => {
    await use('chalk')
    const result = await program('chalk.mjs', "import chalk, { Chalk } from 'chalk'\nconsole.log(typeof chalk.red, chalk.level >= 0, JSON.stringify(new Chalk({ level: 1 }).red('x')))")
    expect(result.err).toBe('')
    expect(result.out).toBe('function true "\\u001b[31mx\\u001b[39m"\n')
  }, 60000)

  it('marked (ES module): the library, and its command reading a pipe', async () => {
    await use('marked')
    const library = await program('marked.mjs', "import { marked } from 'marked'\nconsole.log(marked.parse('# hi\\n\\n*em*').trim())")
    expect(library.err).toBe('')
    expect(library.out).toBe('<h1>hi</h1>\n<p><em>em</em></p>\n')
    const command = await run('printf "**bold**\\n" | marked')
    expect(command.err).toBe('')
    expect(command.out).toBe('<p><strong>bold</strong></p>\n\n')
  }, 60000)

  it('command-line-args and command-line-usage (CommonJS with dependencies)', async () => {
    await use('command-line-args', 'command-line-usage')
    const result = await program('cla.js', "const args = require('command-line-args')\nconst usage = require('command-line-usage')\nconst o = args([{ name: 'n', type: Number }, { name: 'v', alias: 'v', type: Boolean }], { argv: ['--n', '3', '-v'] })\nconsole.log(JSON.stringify(o))\nconsole.log(usage([{ header: 'Tool', content: 'does things' }]).includes('Tool'))")
    expect(result.err).toBe('')
    expect(result.out).toBe('{"n":3,"v":true}\ntrue\n')
  }, 60000)

  it('smol-toml, cronstrue, pako and human-format', async () => {
    await use('smol-toml', 'cronstrue', 'pako', 'human-format')
    const result = await program('misc.mjs', "import { parse } from 'smol-toml'\nimport { gzip, inflate } from 'pako'\nimport cronstrue from 'cronstrue'\nimport humanFormat from 'human-format'\nconsole.log(JSON.stringify(parse('a = 1\\n[t]\\nb = \"x\"')))\nconsole.log(new TextDecoder().decode(inflate(gzip('round trip'))))\nconsole.log(cronstrue.toString('*/5 * * * *'))\nconsole.log(humanFormat(1500000))")
    expect(result.err).toBe('')
    expect(result.out.split('\n')).toEqual(['{"a":1,"t":{"b":"x"}}', 'round trip', 'Every 5 minutes', '1.5 M', ''])
  }, 60000)

  it('tslog and jose (ES modules using process, TextEncoder and WebCrypto)', async () => {
    await use('tslog', 'jose')
    const result = await program('tj.mjs', "import { Logger } from 'tslog'\nimport * as jose from 'jose'\nconst log = new Logger({ type: 'json', name: 'x' })\nlog.info('hello')\nconst key = new TextEncoder().encode('a-secret-of-at-least-32-bytes-long!!')\nconst jwt = await new jose.SignJWT({ a: 1 }).setProtectedHeader({ alg: 'HS256' }).sign(key)\nconst { payload } = await jose.jwtVerify(jwt, key)\nconsole.log(payload.a, jwt.split('.').length)")
    expect(result.err).toBe('')
    expect(result.out).toContain('hello')
    expect(result.out).toContain('1 3')
  }, 60000)

  it('figlet (CommonJS reading its fonts with fs from __dirname)', async () => {
    await use('figlet')
    const result = await program('fig.js', "const figlet = require('figlet')\nconsole.log(figlet.textSync('Hi', { font: 'Standard' }).split('\\n').length > 3)")
    expect(result.err).toBe('')
    expect(result.out).toBe('true\n')
  }, 60000)
})
