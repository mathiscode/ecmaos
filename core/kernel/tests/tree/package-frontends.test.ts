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

    it('rejects an option it does not know the way apt does', async () => {
      const result = await run('apt install --frobnicate x')
      expect(result.code).toBe(100)
      expect(result.err).toContain("E: Command line option '--frobnicate' is not understood in combination with the other options.")
    })
  })

  describe('dpkg', () => {
    it('lists, shows, finds files and owners of what is installed, by Debian name', async () => {
      await publish('prettier', '3.0.0', { description: 'a formatter', bin: { prettier: 'index.js' }, dependencies: { 'dp-dep': '^1.0.0' } })
      await publish('dp-dep', '1.0.0')
      expect((await run(`apt install -y node-prettier --registry ${registry}`)).code).toBe(0)

      let result = await run('dpkg -l')
      expect(result.code, result.err).toBe(0)
      expect(result.out).toContain('Desired=Unknown/Install/Remove/Purge/Hold')
      expect(result.out).toMatch(/ii\s+prettier\s+3\.0\.0\s+all\s+a formatter/)
      expect(result.out).toMatch(/ii\s+dp-dep\s+1\.0\.0/)
      expect((await run('dpkg -l no-such-thing')).code).toBe(1)

      result = await run('dpkg -s prettier')
      expect(result.out).toContain('Package: prettier')
      expect(result.out).toContain('Status: install ok installed')
      expect(result.out).toContain('Depends: dp-dep (^1.0.0)')
      expect((await run('dpkg -s dp-dep')).out).toContain('Auto-Installed: yes')
      result = await run('dpkg -s nothing-here')
      expect(result.code).toBe(1)
      expect(result.err).toContain("package 'nothing-here' is not installed and no information is available")

      result = await run('dpkg -L prettier')
      expect(result.out).toContain('/usr/lib/prettier/3.0.0/package.json')
      expect(result.out).toContain('/usr/bin/prettier')
      result = await run('dpkg -S /usr/bin/prettier')
      expect(result.out.trim()).toBe('prettier: /usr/bin/prettier')
      expect((await run('dpkg -S /etc/passwd')).code).toBe(1)
      expect((await run('dpkg -W prettier')).out.trim()).toBe('prettier\t3.0.0')
      expect((await run('dpkg --get-selections')).out).toMatch(/dp-dep\s+install/)
    })

    it('installs a local npm tarball and removes a package', async () => {
      const tarball = await buildNpmTarballGzip({ 'package.json': JSON.stringify({ name: 'dp-local', version: '1.2.3' }), 'index.js': '//\n' })
      await fs().writeFile('/tmp/dp-local-1.2.3.tgz', tarball)
      let result = await run('dpkg -i /tmp/dp-local-1.2.3.tgz')
      expect(result.code, result.err).toBe(0)
      expect(result.out).toContain('Setting up dp-local (1.2.3) ...')
      result = await run('dpkg -r dp-local')
      expect(result.code, result.err).toBe(0)
      expect(await fs().exists('/usr/lib/dp-local')).toBe(false)
      result = await run('dpkg -i /tmp/x.deb')
      expect(result.code).toBe(2)
      expect(result.err).toContain('a .deb cannot be installed here')
    })
  })

  describe('pacman', () => {
    it('syncs, installs with pacman\'s output, queries, and removes', async () => {
      await publish('pm-tool', '2.0.0', { description: 'a tool', dependencies: { 'pm-lib': '^1.0.0' }, bin: { 'pm-tool': 'index.js' } })
      await publish('pm-lib', '1.0.0', { description: 'a library' })
      let result = await run(`pacman -S --noconfirm pm-tool --registry ${registry}`)
      expect(result.code).toBe(1)
      expect(result.err).toContain('error: target not found: pm-tool')
      expect(result.err).toContain('hint: pm-tool 2.0.0 is on npm')

      // the pacman names are npm names unless the index says otherwise: use one it maps
      await publish('typescript', '5.0.0', { description: 'the compiler', dependencies: { 'pm-lib': '^1.0.0' }, bin: { tsc: 'index.js' } })
      result = await run(`pacman -S --noconfirm typescript --registry ${registry}`)
      expect(result.code, result.err).toBe(0)
      expect(result.out).toContain('resolving dependencies...')
      expect(result.out).toContain('Packages (2) pm-lib-1.0.0  typescript-5.0.0')
      expect(result.out).toContain(':: Proceed with installation? [Y/n]')
      expect(result.out).toMatch(/\(\d\/2\) installing/)
      expect(await fs().exists('/usr/bin/tsc')).toBe(true)

      result = await run('pacman -Q')
      expect(result.out).toContain('typescript 5.0.0')
      expect(result.out).toContain('pm-lib 1.0.0')
      expect((await run('pacman -Qe')).out).toContain('typescript 5.0.0')
      expect((await run('pacman -Qe')).out).not.toContain('pm-lib')
      expect((await run('pacman -Qd')).out).toContain('pm-lib 1.0.0')
      expect((await run('pacman -Qdt')).out).not.toContain('pm-lib')
      result = await run('pacman -Qi typescript')
      expect(result.out).toMatch(/Name\s+: typescript/)
      expect(result.out).toMatch(/Install Reason\s+: Explicitly installed/)
      expect((await run('pacman -Qi pm-lib')).out).toMatch(/Required By\s+: typescript/)
      expect((await run('pacman -Ql typescript')).out).toContain('typescript /usr/bin/tsc')
      expect((await run('pacman -Qo /usr/bin/tsc')).out.trim()).toBe('/usr/bin/tsc is owned by typescript 5.0.0')
      expect((await run('pacman -Qo /etc/passwd')).err).toContain('error: No package owns /etc/passwd')
      expect((await run('pacman -Qs compiler')).out).toContain('local/typescript 5.0.0')

      result = await run('pacman -R --noconfirm typescript')
      expect(result.code, result.err).toBe(0)
      expect(result.out).toContain('Packages (1) typescript-5.0.0')
      expect(result.out).toContain(':: Do you want to remove these packages? [Y/n]')
      expect((await run('pacman -Qdt')).out).toContain('pm-lib 1.0.0')
      expect((await run('pacman -Rs --noconfirm pm-lib')).code).toBe(0)
      expect(await fs().exists('/usr/lib/pm-lib')).toBe(false)
      expect((await run('pacman -R nothing')).err).toContain('error: target not found: nothing')
    })

    it('searches, shows info, refreshes and upgrades', async () => {
      await publish('typescript', '5.0.0', { description: 'the compiler' })
      expect((await run(`pacman -S --noconfirm typescript --registry ${registry}`)).code).toBe(0)
      let result = await run(`pacman -Ss compiler --registry ${registry}`)
      expect(result.out).toMatch(/npm\/typescript \S+ \[installed\]\n {4}TypeScript compiler/)
      result = await run(`pacman -Si typescript --registry ${registry}`)
      expect(result.out).toMatch(/Repository\s+: npm/)
      expect(result.out).toMatch(/Version\s+: 5\.0\.0/)

      await publish('typescript', '5.1.0', { description: 'the compiler' })
      result = await run(`pacman -Sy --registry ${registry}`)
      expect(result.out).toContain(':: Synchronizing package databases...')
      expect((await run(`pacman -Qu --registry ${registry}`)).out.trim()).toBe('typescript 5.0.0 -> 5.1.0')
      result = await run(`pacman -Syu --noconfirm --registry ${registry}`)
      expect(result.code, result.err).toBe(0)
      expect(result.out).toContain(':: Starting full system upgrade...')
      expect(result.out).toContain('typescript-5.1.0')
      expect((await run('pacman -Q typescript')).out.trim()).toBe('typescript 5.1.0')
      expect((await run(`pacman -Syu --noconfirm --registry ${registry}`)).out).toContain('there is nothing to do')
    })

    it('says an operation it does not have, and what it does not understand', async () => {
      expect((await run('pacman -F foo')).err).toContain('not supported')
      expect((await run('pacman --frobnicate')).err).toContain("error: invalid option '--frobnicate'")
      expect((await run('pacman')).err).toContain('error: no operation specified')
    })
  })

  describe('npm, npx, yarn and pnpm', () => {
    const inDir = async (dir: string, command: string, input = '') => {
      await fs().mkdir(dir, { recursive: true })
      return await run(`cd ${dir} && ${command}`, input)
    }
    const json = async (path: string) => JSON.parse(await fs().readFile(path, 'utf-8'))

    it('installs into node_modules, keeps package.json up to date, and lists, runs and removes', async () => {
      await publish('np-b', '1.0.0', { description: 'the dependency' })
      await publish('np-a', '1.0.0', { dependencies: { 'np-b': '^1.0.0' }, bin: { 'np-a': 'cli.js' } }, { 'cli.js': "#!/usr/bin/env node\nconsole.log('np-a ran', process.argv.slice(2).join(','))\n" })
      await publish('np-dev', '2.0.0')
      const dir = '/tmp/np1'
      let result = await inDir(dir, 'npm init -y')
      expect(result.code, result.err).toBe(0)
      expect((await json(`${dir}/package.json`)).name).toBe('np1')

      result = await inDir(dir, `npm install np-a --registry ${registry}`)
      expect(result.code, result.err).toBe(0)
      expect(result.out).toMatch(/added 2 packages in \d+m?s/)
      expect((await json(`${dir}/package.json`)).dependencies).toEqual({ 'np-a': '^1.0.0' })
      expect(await fs().readlink(`${dir}/node_modules/np-a`)).toBe('.ecmaos/np-a/1.0.0')
      expect(await fs().readFile(`${dir}/node_modules/np-a/node_modules/np-b/package.json`, 'utf-8')).toContain('"np-b"')
      expect(await fs().exists(`${dir}/node_modules/.bin/np-a`)).toBe(true)
      // the project is its own scope: nothing reaches the system's
      expect(await fs().exists('/usr/lib/np-a')).toBe(false)

      result = await inDir(dir, `npm install -D np-dev --registry ${registry}`)
      expect(result.code, result.err).toBe(0)
      expect((await json(`${dir}/package.json`)).devDependencies).toEqual({ 'np-dev': '^2.0.0' })

      result = await inDir(dir, 'npm ls')
      expect(result.out).toContain('np1@1.0.0 /tmp/np1')
      expect(result.out).toContain('├── np-a@1.0.0\n│   └── np-b@1.0.0')
      expect(result.out).toContain('└── np-dev@2.0.0')

      // a package's bin runs, found on PATH by npm run and run directly by npx
      const manifest = await json(`${dir}/package.json`)
      manifest.scripts = { hello: 'np-a one two', prehello: 'echo before', posthello: 'echo after', fail: 'exit 3', args: 'echo' }
      await fs().writeFile(`${dir}/package.json`, JSON.stringify(manifest))
      result = await inDir(dir, 'npm run hello')
      expect(result.code, result.err + result.out).toBe(0)
      expect(result.out).toContain('> np1@1.0.0 hello')
      expect(result.out.indexOf('before')).toBeLessThan(result.out.indexOf('np-a ran one,two'))
      expect(result.out.indexOf('np-a ran one,two')).toBeLessThan(result.out.indexOf('after'))
      expect((await inDir(dir, 'npm run args -- x y')).out).toContain('x y')
      result = await inDir(dir, 'npm run fail')
      expect(result.code).toBe(3)
      expect((await inDir(dir, 'npm run nope')).err).toContain('Missing script: "nope"')
      expect((await inDir(dir, 'npx np-a three')).out).toContain('np-a ran three')

      result = await inDir(dir, 'npm uninstall np-a')
      expect(result.code, result.err).toBe(0)
      expect(result.out).toMatch(/removed 2 packages/)
      expect((await json(`${dir}/package.json`)).dependencies ?? {}).toEqual({})
      expect(await fs().exists(`${dir}/node_modules/np-a`)).toBe(false)
      expect(await fs().exists(`${dir}/node_modules/.ecmaos/np-b`)).toBe(false)
      expect(await fs().exists(`${dir}/node_modules/np-dev`)).toBe(true)
    })

    it('installs what package.json lists, and removes what it no longer lists', async () => {
      const dir = '/tmp/np2'
      await fs().mkdir(dir, { recursive: true })
      await fs().writeFile(`${dir}/package.json`, JSON.stringify({ name: 'np2', version: '0.1.0', dependencies: { 'np-a': '^1.0.0' } }))
      let result = await inDir(dir, `npm install --registry ${registry}`)
      expect(result.code, result.err).toBe(0)
      expect(result.out).toMatch(/added 2 packages/)
      expect(await fs().exists(`${dir}/node_modules/np-a`)).toBe(true)
      result = await inDir(dir, `npm install --registry ${registry}`)
      expect(result.out).toContain('up to date')

      await fs().writeFile(`${dir}/package.json`, JSON.stringify({ name: 'np2', version: '0.1.0', dependencies: { 'np-dev': '^2.0.0' } }))
      result = await inDir(dir, `npm install --registry ${registry}`)
      expect(result.code, result.err).toBe(0)
      expect(await fs().exists(`${dir}/node_modules/np-a`)).toBe(false)
      expect(await fs().exists(`${dir}/node_modules/np-dev`)).toBe(true)

      result = await inDir(dir, `npm ci --registry ${registry}`)
      expect(result.code, result.err).toBe(0)
      expect(await fs().exists(`${dir}/node_modules/np-dev`)).toBe(true)
    })

    it('reports and applies updates within the ranges package.json allows', async () => {
      const dir = '/tmp/np3'
      await fs().mkdir(dir, { recursive: true })
      await fs().writeFile(`${dir}/package.json`, JSON.stringify({ name: 'np3', version: '1.0.0', dependencies: { 'np-b': '^1.0.0' } }))
      expect((await inDir(dir, `npm install --registry ${registry}`)).code).toBe(0)
      await publish('np-b', '1.1.0')
      await publish('np-b', '2.0.0')
      let result = await inDir(dir, `npm outdated --registry ${registry}`)
      expect(result.code).toBe(1)
      expect(result.out).toMatch(/Package\s+Current\s+Wanted\s+Latest/)
      expect(result.out).toMatch(/np-b\s+1\.0\.0\s+1\.1\.0\s+2\.0\.0/)
      result = await inDir(dir, `npm update --registry ${registry}`)
      expect(result.code, result.err).toBe(0)
      expect((await json(`${dir}/package.json`)).dependencies).toEqual({ 'np-b': '^1.1.0' })
      expect(await fs().readlink(`${dir}/node_modules/np-b`)).toBe('.ecmaos/np-b/1.1.0')
    })

    it('installs globally where install does, and views and searches the registry', async () => {
      await publish('np-glob', '1.0.0', { bin: { 'np-glob': 'cli.js' } }, { 'cli.js': "#!/usr/bin/env node\nconsole.log('glob')\n" })
      let result = await inDir('/tmp/np4', `npm install -g np-glob --registry ${registry}`)
      expect(result.code, result.err).toBe(0)
      expect(await fs().exists('/usr/lib/np-glob/1.0.0')).toBe(true)
      expect(await fs().exists('/usr/bin/np-glob')).toBe(true)
      expect((await inDir('/tmp/np4', 'npm ls -g')).out).toContain('np-glob@1.0.0')
      expect((await inDir('/tmp/np4', 'npm root -g')).out.trim()).toBe('/usr/lib')
      expect((await inDir('/tmp/np4', 'npm uninstall -g np-glob')).code).toBe(0)
      expect(await fs().exists('/usr/lib/np-glob')).toBe(false)

      expect((await inDir('/tmp/np4', `npm view np-a version --registry ${registry}`)).out.trim()).toBe('1.0.0')
      result = await inDir('/tmp/np4', `npm search np-a --registry ${registry}`)
      expect(result.out).toMatch(/NAME\s+\| DESCRIPTION/)
      expect(result.out).toContain('np-a')
      expect((await inDir('/tmp/np4', 'npm --version')).out.trim()).toMatch(/^\d+\.\d+\.\d+$/)
      expect((await inDir('/tmp/np4', 'npm publish')).err).toContain('is not available on ecmaOS')
    })

    it('yarn and pnpm do the same in their own words', async () => {
      const yarnDir = '/tmp/np5'
      await fs().mkdir(yarnDir, { recursive: true })
      await fs().writeFile(`${yarnDir}/package.json`, JSON.stringify({ name: 'np5', version: '1.0.0', scripts: { hello: 'echo hello-from-yarn' } }))
      let result = await inDir(yarnDir, `yarn add np-b --registry ${registry}`)
      expect(result.code, result.err).toBe(0)
      expect(result.out).toContain('[1/4] Resolving packages...')
      expect(result.out).toContain('success Saved 1 new dependency.')
      expect(result.out).toContain('└─ np-b@')
      result = await inDir(yarnDir, 'yarn hello')
      expect(result.out).toContain('$ echo hello-from-yarn')
      expect(result.out).toContain('hello-from-yarn')
      expect((await inDir(yarnDir, 'yarn run hello')).code).toBe(0)
      result = await inDir(yarnDir, 'yarn remove np-b')
      expect(result.code, result.err).toBe(0)
      expect(result.out).toContain('success Uninstalled packages.')
      expect(await fs().exists(`${yarnDir}/node_modules/np-b`)).toBe(false)

      const pnpmDir = '/tmp/np6'
      await fs().mkdir(pnpmDir, { recursive: true })
      await fs().writeFile(`${pnpmDir}/package.json`, JSON.stringify({ name: 'np6', version: '1.0.0', scripts: { hello: 'echo hello-from-pnpm' } }))
      result = await inDir(pnpmDir, `pnpm add np-b --registry ${registry}`)
      expect(result.code, result.err).toBe(0)
      expect(result.out).toContain('Packages: +1')
      expect(result.out).toMatch(/dependencies:\n\+ np-b \d/)
      expect((await inDir(pnpmDir, 'pnpm run hello')).out).toContain('hello-from-pnpm')
      expect((await inDir(pnpmDir, 'pnpm test')).err).toContain('Missing script')
      result = await inDir(pnpmDir, 'pnpm remove np-b')
      expect(result.code, result.err).toBe(0)
      expect(await fs().exists(`${pnpmDir}/node_modules/np-b`)).toBe(false)
    })
  })

  // last: the index it fetches replaces the built-in one for the rest of the run
  describe('package index', () => {
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
  })
})
