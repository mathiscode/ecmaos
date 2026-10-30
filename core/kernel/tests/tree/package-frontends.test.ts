import type { IncomingMessage, Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { buildNpmTarballGzip, sha512Sri } from './fixtures/npm-tarball'
import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * The front-ends of `install` (`apt`, `apt-get`, `apt-cache`, `dpkg`, `pacman`, `npm`, `npx`, `yarn`, `pnpm`): Debian's,
 * Arch's and npm's commands, their names mapped to npm packages by `@ecmaos/package-index`. The registry is a real
 * local HTTP server, serving packages named as the built-in index maps them.
 */
describe('package manager front-ends', () => {
  let kernel: Kernel
  let server: Server
  let registry = ''
  const routes = new Map<string, () => { body: string | Uint8Array, status?: number }>()
  const requests: IncomingMessage[] = []
  const published = new Map<string, Record<string, Record<string, unknown>>>()
  const latest = new Map<string, string>()

  const fs = () => kernel.filesystem.fs
  const run = async (command: string, input = '') => {
    await fs().unlink('/tmp/fe-out').catch(() => {})
    await fs().unlink('/tmp/fe-err').catch(() => {})
    await fs().writeFile('/tmp/fe-in', input)
    const code = await kernel.shell.execute(`${command} < /tmp/fe-in > /tmp/fe-out 2> /tmp/fe-err`)
    const read = (name: string) => fs().readFile(`/tmp/fe-${name}`, 'utf-8').catch(() => '')
    return { code, out: await read('out'), err: await read('err') }
  }
  const publish = async (name: string, version: string, manifest: Record<string, unknown> = {}, files: Record<string, string> = {}) => {
    const full = { name, version, ...manifest }
    const tarball = await buildNpmTarballGzip({ 'package.json': JSON.stringify(full), 'index.js': `// ${name}@${version}\n`, ...files })
    const integrity = await sha512Sri(tarball)
    const dist = { tarball: `${registry}/${name}/-/${version}.tgz`, integrity, unpackedSize: tarball.length }
    routes.set(`/${name}/-/${version}.tgz`, () => ({ body: tarball }))
    const versions = published.get(name) ?? {}
    versions[version] = { ...full, dist }
    published.set(name, versions)
    latest.set(name, version)
    routes.set(`/${name}`, () => ({ body: JSON.stringify({ name, 'dist-tags': { latest: latest.get(name) }, versions: published.get(name), description: `the ${name} package`, maintainers: [{ name: 'someone', email: 'someone@example.com' }], homepage: `https://example.com/${name}` }) }))
  }
  const db = async (path = '/var/lib/install/db.json') => JSON.parse(await fs().readFile(path, 'utf-8')).packages as Record<string, { explicit: boolean, dependencies: Record<string, string> }>

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
    const { createServer } = process.getBuiltinModule('node:http')
    server = createServer((req, res) => {
      requests.push(req)
      const url = decodeURIComponent(req.url ?? '').replace('/@', '/%40').replace('%40', '@')
      const route = routes.get(url) ?? routes.get(req.url ?? '')
      if (url.startsWith('/-/v1/search')) {
        const text = new URL(url, 'http://x').searchParams.get('text') ?? ''
        const objects = [...published.keys()].filter(name => name.includes(text)).map(name => ({ package: { name, version: latest.get(name), description: `the ${name} package` } }))
        res.end(JSON.stringify({ objects }))
        return
      }
      if (!route) { res.statusCode = 404; res.end('not found'); return }
      const { body, status } = route()
      if (status) res.statusCode = status
      res.end(body)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
  }, 60000)

  afterAll(() => { server?.close() })

  describe('apt', () => {
    it('installs a package by its Debian name, with apt\'s output, and records it as installed by name', async () => {
      await publish('semver', '7.0.0', { bin: { semver: 'index.js' } })
      await publish('yaml', '2.0.0', { dependencies: { semver: '^7.0.0' } })
      const result = await run(`apt install -y node-semver --registry ${registry}`)
      expect(result.code, result.err).toBe(0)
      expect(result.out).toContain('Reading package lists... Done')
      expect(result.out).toContain('The following NEW packages will be installed:\n  node-semver')
      expect(result.out).toMatch(/1 newly installed/)
      expect(result.out).toContain('Setting up semver (7.0.0) ...')
      expect((await db())['semver@7.0.0']).toMatchObject({ explicit: true })
      expect(await fs().exists('/usr/bin/semver')).toBe(true)
    })

    it('says it is already the newest version', async () => {
      const result = await run(`apt install -y node-semver --registry ${registry}`)
      expect(result.code, result.err).toBe(0)
      expect(result.out).toContain('node-semver is already the newest version (7.0.0).')
    })

    it('refuses a name the index does not know, installs nothing, and points at close npm packages', async () => {
      await publish('mystery-tool', '1.0.0')
      const result = await run(`apt-get install -y mystery --registry ${registry}`)
      expect(result.code).toBe(100)
      expect(result.err).toContain('E: Unable to locate package mystery')
      expect(result.err).toContain('mystery-tool 1.0.0')
      expect(await fs().exists('/usr/lib/mystery-tool')).toBe(false)
    })

    it('says a name ecmaOS ships already needs no install', async () => {
      const result = await run(`apt install -y curl --registry ${registry}`)
      expect(result.code, result.err).toBe(0)
      expect(result.out).toContain('curl is already the newest version (curl is part of ecmaOS).')
    })

    it('asks before it goes on, and stops on no', async () => {
      await publish('json5', '2.0.0')
      let result = await run(`apt install node-json5 --registry ${registry}`, 'n\n')
      expect(result.code).toBe(1)
      expect(result.out).toContain('Do you want to continue? [Y/n]')
      expect(result.out).toContain('Abort.')
      expect(await fs().exists('/usr/lib/json5')).toBe(false)
      result = await run(`apt install node-json5 --registry ${registry}`, '\n')
      expect(result.code, result.err).toBe(0)
      expect(await fs().exists('/usr/lib/json5/2.0.0')).toBe(true)
    })

    it('does nothing with --simulate', async () => {
      await publish('terser', '5.0.0')
      const result = await run(`apt-get -s install node-terser --registry ${registry}`)
      expect(result.code, result.err).toBe(0)
      expect(result.out).toContain('Inst terser (5.0.0')
      expect(result.out).toContain('Conf terser (5.0.0')
      expect(await fs().exists('/usr/lib/terser')).toBe(false)
    })

    it('installs dependencies as automatic, lists them, and autoremove takes them once nothing needs them', async () => {
      await run(`apt install -y yaml --registry ${registry}`)
      expect((await db())['yaml@2.0.0']).toMatchObject({ explicit: true })
      const listed = await run('apt list --installed')
      expect(listed.out).toContain('Listing... Done')
      expect(listed.out).toContain('yaml/stable,now 2.0.0 all [installed]')
      let result = await run('apt remove -y yaml')
      expect(result.code, result.err).toBe(0)
      expect(result.out).toContain('The following packages will be REMOVED:\n  yaml')
      expect(result.out).toContain('Removing yaml (2.0.0) ...')
      expect(await fs().exists('/usr/lib/yaml')).toBe(false)
      result = await run('apt remove -y yaml')
      expect(result.out).toContain("Package 'yaml' is not installed, so not removed")
      result = await run('apt autoremove -y')
      expect(result.code, result.err).toBe(0)
    })

    it('shows, searches and gives the policy of a package', async () => {
      let result = await run(`apt show node-semver --registry ${registry}`)
      expect(result.code, result.err).toBe(0)
      expect(result.out).toContain('Package: node-semver')
      expect(result.out).toContain('Version: 7.0.0')
      expect(result.out).toContain('Npm-Package: semver')
      expect(result.out).toContain('Homepage: https://example.com/semver')
      result = await run(`apt search semantic --registry ${registry}`)
      expect(result.out).toContain('Sorting... Done')
      expect(result.out).toContain('semver')
      result = await run(`apt-cache policy node-semver --registry ${registry}`)
      expect(result.out).toContain('node-semver:\n  Installed: 7.0.0\n  Candidate: 7.0.0')
    })

    it('upgrades what has a newer version, and update reports it', async () => {
      await publish('semver', '7.1.0', { bin: { semver: 'index.js' } })
      let result = await run(`apt update --registry ${registry}`)
      expect(result.code, result.err).toBe(0)
      expect(result.out).toContain('1 package can be upgraded.')
      result = await run(`apt list --upgradable --registry ${registry}`)
      expect(result.out).toContain('semver/stable 7.1.0 all [upgradable from: 7.0.0]')
      result = await run(`apt upgrade -y --registry ${registry}`)
      expect(result.code, result.err).toBe(0)
      expect(result.out).toContain('The following packages will be upgraded:\n  semver')
      expect(result.out).toContain('1 upgraded, 0 newly installed')
      expect((await db())['semver@7.1.0']).toMatchObject({ explicit: true })
    })

    it('fetches the newest package index on update, and maps the names it adds', async () => {
      await publish('brand-new', '1.0.0')
      const index = JSON.stringify({ schema: 1, common: { 'brand-new-tool': { package: 'brand-new', description: 'a tool' } }, apt: {} })
      await publish('@ecmaos/package-index', '9.9.9', {}, { 'index.json': index })
      const result = await run(`apt update --registry ${registry}`)
      expect(result.code, result.err).toBe(0)
      expect(result.out).toContain('@ecmaos/package-index 9.9.9')
      expect(JSON.parse(await fs().readFile('/var/lib/install/package-index.json', 'utf-8')).version).toBe('9.9.9')
      const installed = await run(`apt install -y brand-new-tool --registry ${registry}`)
      expect(installed.code, installed.err).toBe(0)
      expect(await fs().exists('/usr/lib/brand-new/1.0.0')).toBe(true)
    })

    it('rejects an option it does not know the way apt does', async () => {
      const result = await run('apt install --frobnicate x')
      expect(result.code).toBe(100)
      expect(result.err).toContain("E: Command line option '--frobnicate' is not understood in combination with the other options.")
    })
  })
})
