import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { buildNpmTarballGzip, sha1Hex, sha512Sri } from './fixtures/npm-tarball'
import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * `install` is a worker program whose `fetch` cannot be stubbed, so the registry is a real local HTTP server.
 * `install` extracts with the `tar` coreutil (`tar -xzf ... -C <scratch>`) and moves the result into place, stripping
 * npm's `package/` wrapper.
 */
describe('install command: real tar extraction via shell.execute, not extractTarball directly', () => {
  let kernel: Kernel
  let server: Server
  let registry = ''
  const routes = new Map<string, () => { body: string | Uint8Array }>()

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()

    // The real `node:http` (the test bundler swaps the static import for a browser polyfill)
    const { createServer } = process.getBuiltinModule('node:http')
    server = createServer((req, res) => {
      const route = routes.get(req.url ?? '')
      if (!route) { res.statusCode = 404; res.end('not found'); return }
      res.end(route().body)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
  })

  afterAll(() => { server?.close() })

  it('extracts a real npm-shaped tarball, stripping the package/ wrapper directory', async () => {
    const tarballBytes = await buildNpmTarballGzip({
      'package.json': JSON.stringify({ name: 'fake-pkg', version: '1.2.3' }),
      'index.js': 'module.exports = 42\n'
    })
    const checksum = await sha1Hex(tarballBytes)

    const registryData = {
      name: 'fake-pkg',
      'dist-tags': { latest: '1.2.3' },
      versions: {
        '1.2.3': { dist: { tarball: `${registry}/fake-pkg/-/fake-pkg-1.2.3.tgz`, shasum: checksum } }
      }
    }
    routes.set('/fake-pkg', () => ({ body: JSON.stringify(registryData) }))
    routes.set('/fake-pkg/-/fake-pkg-1.2.3.tgz', () => ({ body: tarballBytes }))

    const code = await kernel.shell.execute(`install fake-pkg --registry ${registry}`)
    expect(code).toBe(0)

    const extractPath = '/usr/lib/fake-pkg/1.2.3'
    const packageJson = JSON.parse(await kernel.filesystem.fs.readFile(`${extractPath}/package.json`, 'utf-8'))
    expect(packageJson.name).toBe('fake-pkg')
    const indexJs = await kernel.filesystem.fs.readFile(`${extractPath}/index.js`, 'utf-8')
    expect(indexJs).toBe('module.exports = 42\n')

    // No leftover scratch directory or tarball
    const tmpEntries = await kernel.filesystem.fs.readdir('/tmp')
    expect(tmpEntries.some(name => name.startsWith('fake-pkg-'))).toBe(false)
    const usrLibEntries = await kernel.filesystem.fs.readdir('/usr/lib')
    expect(usrLibEntries.some(name => name.startsWith('.install-'))).toBe(false)
  })

  it('links bins and desktop entries, and an upgrade moves the links to the new version', async () => {
    const versions: Record<string, { tarball: Uint8Array, checksum: string }> = {}
    for (const version of ['1.0.0', '2.0.0']) {
      const tarball = await buildNpmTarballGzip({
        'package.json': JSON.stringify({ name: 'tool-pkg', version, bin: { tool: 'dist/tool.js' } }),
        'dist/tool.js': `// ${version}\n`,
        'share/applications/tool.desktop': `[Desktop Entry]\nType=Application\nName=Tool ${version}\nExec=tool\n`
      })
      versions[version] = { tarball, checksum: await sha1Hex(tarball) }
      routes.set(`/tool-pkg/-/tool-pkg-${version}.tgz`, () => ({ body: tarball }))
    }
    routes.set('/tool-pkg', () => ({
      body: JSON.stringify({
        name: 'tool-pkg',
        'dist-tags': { latest: '2.0.0' },
        versions: Object.fromEntries(Object.entries(versions).map(([version, { checksum }]) => [version, { dist: { tarball: `${registry}/tool-pkg/-/tool-pkg-${version}.tgz`, shasum: checksum } }]))
      })
    }))
    const { fs } = kernel.filesystem

    expect(await kernel.shell.execute(`install tool-pkg@1.0.0 --registry ${registry}`)).toBe(0)
    expect(await fs.readlink('/usr/bin/tool')).toBe('/usr/lib/tool-pkg/1.0.0/dist/tool.js')
    expect(await fs.readFile('/usr/share/applications/tool.desktop', 'utf-8')).toContain('Tool 1.0.0')

    expect(await kernel.shell.execute(`install tool-pkg --registry ${registry}`)).toBe(0)
    expect(await fs.readlink('/usr/bin/tool')).toBe('/usr/lib/tool-pkg/2.0.0/dist/tool.js')
    expect(await fs.readFile('/usr/share/applications/tool.desktop', 'utf-8')).toContain('Tool 2.0.0')
  })

  const publish = async (name: string, version: string, files: Record<string, string>, integrity: 'sha512' | 'sha1-only' | 'bad-sha512' = 'sha512', dependencies?: Record<string, string>, manifest: Record<string, unknown> = {}) => {
    const tarball = await buildNpmTarballGzip({ 'package.json': JSON.stringify({ name, version, dependencies, ...manifest, bin: files['dist/cli.js'] ? { [name.split('/').pop()!]: 'dist/cli.js' } : undefined }), ...files })
    const dist = {
      tarball: `${registry}/${name}/-/${version}.tgz`,
      shasum: await sha1Hex(tarball),
      ...(integrity === 'sha512' ? { integrity: await sha512Sri(tarball) } : integrity === 'bad-sha512' ? { integrity: `sha512-${btoa('x'.repeat(64))}` } : {})
    }
    routes.set(`/${name}/-/${version}.tgz`, () => ({ body: tarball }))
    // a registry's metadata carries each version's manifest, dependencies included
    routes.set(`/${name}`, () => ({ body: JSON.stringify({ name, 'dist-tags': { latest: version }, versions: { [version]: { name, version, dependencies, ...manifest, dist } } }) }))
  }

  it('verifies the SHA-512 integrity the registry gives, and refuses a package that does not match it even when the SHA-1 does', async () => {
    await publish('sri-pkg', '1.0.0', { 'dist/cli.js': '// sri\n' })
    expect(await kernel.shell.execute(`install sri-pkg --registry ${registry}`)).toBe(0)

    await publish('sri-bad', '1.0.0', { 'dist/cli.js': '// bad\n' }, 'bad-sha512')
    expect(await kernel.shell.execute(`install sri-bad --registry ${registry} 2> /tmp/sri.err`)).toBe(1)
    expect(await kernel.filesystem.fs.readFile('/tmp/sri.err', 'utf-8')).toContain('Integrity verification failed')
    expect(await kernel.filesystem.fs.exists('/usr/lib/sri-bad')).toBe(false)
  })

  it('falls back to the SHA-1 shasum when the registry gives no integrity', async () => {
    await publish('sha1-pkg', '1.0.0', { 'dist/cli.js': '// sha1\n' }, 'sha1-only')
    expect(await kernel.shell.execute(`install sha1-pkg --registry ${registry}`)).toBe(0)
  })

  it('makes a bin executable, as npm does, when the tarball has it as a plain file', async () => {
    await publish('exec-pkg', '1.0.0', { 'dist/cli.js': '// exec\n' })
    expect(await kernel.shell.execute(`install exec-pkg --registry ${registry}`)).toBe(0)
    expect((await kernel.filesystem.fs.stat('/usr/lib/exec-pkg/1.0.0/dist/cli.js')).mode & 0o111).not.toBe(0)
  })

  it('does not link the bins of a dependency, and links them if the dependency is installed on its own afterwards', async () => {
    await publish('dep-lib', '1.0.0', { 'dist/cli.js': '// dep\n' })
    await publish('dep-app', '1.0.0', { 'dist/cli.js': '// app\n' }, 'sha512', { 'dep-lib': '1.0.0' })
    const { fs } = kernel.filesystem

    expect(await kernel.shell.execute(`install dep-app --registry ${registry}`)).toBe(0)
    expect(await fs.readlink('/usr/bin/dep-app')).toBe('/usr/lib/dep-app/1.0.0/dist/cli.js')
    expect(await fs.exists('/usr/lib/dep-lib/1.0.0/package.json')).toBe(true)
    expect(await fs.exists('/usr/bin/dep-lib')).toBe(false)

    expect(await kernel.shell.execute(`install dep-lib --registry ${registry}`)).toBe(0)
    expect(await fs.readlink('/usr/bin/dep-lib')).toBe('/usr/lib/dep-lib/1.0.0/dist/cli.js')
  })

  it('links share/docs, share/licenses and share/man file by file, beside what other packages put there, and uninstall takes only its own', async () => {
    await publish('share-a', '1.0.0', { 'share/man/man1/a.1': '.TH A 1\n', 'share/docs/@ecmaos/a/a.md': '# a\n', 'share/licenses/@ecmaos/a/LICENSE': 'a\n' })
    await publish('share-b', '1.0.0', { 'share/man/man1/b.1': '.TH B 1\n' })
    const { fs } = kernel.filesystem

    expect(await kernel.shell.execute(`install share-a --registry ${registry}`)).toBe(0)
    expect(await kernel.shell.execute(`install share-b --registry ${registry}`)).toBe(0)
    expect(await fs.readFile('/usr/share/man/man1/a.1', 'utf-8')).toBe('.TH A 1\n')
    expect(await fs.readFile('/usr/share/man/man1/b.1', 'utf-8')).toBe('.TH B 1\n')
    expect(await fs.readFile('/usr/share/docs/@ecmaos/a/a.md', 'utf-8')).toBe('# a\n')
    expect(await fs.readFile('/usr/share/licenses/@ecmaos/a/LICENSE', 'utf-8')).toBe('a\n')

    expect(await kernel.shell.execute('uninstall share-a')).toBe(0)
    expect(await fs.exists('/usr/share/man/man1/a.1')).toBe(false)
    expect(await fs.exists('/usr/share/docs/@ecmaos/a/a.md')).toBe(false)
    expect(await fs.readFile('/usr/share/man/man1/b.1', 'utf-8')).toBe('.TH B 1\n')
  })

  it('puts the kernel modules a package lists in /lib/modules/RELEASE, indexes them, and uninstall takes them away', async () => {
    const module = (name: string) => `/* ecmaos-module\n * name=${name}\n * license=MIT\n */\nexport default { init(ctx) { ctx.log.info('${name} is here') } }\n`
    await publish('mod-pkg', '1.0.0', { 'dist/pkgmod.ko.mjs': module('pkgmod') }, 'sha512', undefined, { ecmaos: { modules: ['dist/pkgmod.ko.mjs'] } })
    const { fs } = kernel.filesystem
    const release = kernel.version

    expect(await kernel.shell.execute(`install mod-pkg --registry ${registry}`)).toBe(0)
    expect(await fs.exists(`/lib/modules/${release}/pkgmod.ko.mjs`)).toBe(true)
    expect(await fs.readFile(`/lib/modules/${release}/modules.dep`, 'utf-8')).toContain('pkgmod')
    expect(await kernel.shell.execute('modprobe pkgmod')).toBe(0)
    expect(await fs.exists('/sys/module/pkgmod')).toBe(true)
    expect(await kernel.shell.execute('modprobe -r pkgmod')).toBe(0)

    expect(await kernel.shell.execute('uninstall mod-pkg')).toBe(0)
    expect(await fs.exists(`/lib/modules/${release}/pkgmod.ko.mjs`)).toBe(false)

    await publish('mod-bad', '1.0.0', { 'dist/x.js': '//\n' }, 'sha512', undefined, { ecmaos: { modules: ['dist/x.js'] } })
    expect(await kernel.shell.execute(`install mod-bad --registry ${registry} 2> /tmp/mod.err`)).toBe(1)
    expect(await fs.readFile('/tmp/mod.err', 'utf-8')).toContain('is not a NAME.ko.mjs')
  })
  describe('relations in ecmaos: recommends, suggests, requires, conflicts, replaces', () => {
    it('installs the recommended packages, skips them with --no-install-recommends, and lists the suggested ones', async () => {
      await publish('rec-extra', '1.0.0', { 'dist/cli.js': '// extra\n' })
      await publish('rec-main', '1.0.0', { 'dist/cli.js': '// main\n' }, 'sha512', undefined, { ecmaos: { recommends: ['rec-extra'], suggests: ['rec-maybe'] } })
      expect(await kernel.shell.execute(`install rec-main --registry ${registry} --no-install-recommends > /tmp/rec.out 2>&1`)).toBe(0)
      expect(await kernel.filesystem.fs.exists('/usr/lib/rec-extra')).toBe(false)
      expect(await kernel.filesystem.fs.readFile('/tmp/rec.out', 'utf-8')).toContain('rec-maybe')
      expect(await kernel.shell.execute(`install rec-main --reinstall --registry ${registry}`)).toBe(0)
      expect(await kernel.filesystem.fs.exists('/usr/lib/rec-extra/1.0.0/package.json')).toBe(true)
    })

    it('a recommendation that cannot be had is skipped, not an error', async () => {
      await publish('rec-lonely', '1.0.0', { 'dist/cli.js': '// l\n' }, 'sha512', undefined, { ecmaos: { recommends: ['rec-nowhere'] } })
      expect(await kernel.shell.execute(`install rec-lonely --registry ${registry}`)).toBe(0)
    })

    it('refuses a package that needs a newer kernel or a feature this kernel lacks, unless --force', async () => {
      await publish('req-future', '1.0.0', { 'dist/cli.js': '// f\n' }, 'sha512', undefined, { ecmaos: { requires: { kernel: '>=999.0.0' } } })
      expect(await kernel.shell.execute(`install req-future --registry ${registry} 2> /tmp/req.err`)).toBe(1)
      expect(await kernel.filesystem.fs.readFile('/tmp/req.err', 'utf-8')).toContain('needs kernel >=999.0.0')
      await publish('req-feature', '1.0.0', { 'dist/cli.js': '// f\n' }, 'sha512', undefined, { ecmaos: { requires: { features: ['warp-drive'] } } })
      expect(await kernel.shell.execute(`install req-feature --registry ${registry} 2> /tmp/req.err`)).toBe(1)
      expect(await kernel.filesystem.fs.readFile('/tmp/req.err', 'utf-8')).toContain('warp-drive')
      expect(await kernel.shell.execute(`install req-feature --force --registry ${registry}`)).toBe(0)
    })

    it('refuses to install beside a package it conflicts with', async () => {
      await publish('con-a', '1.0.0', { 'dist/cli.js': '// a\n' })
      await publish('con-b', '1.0.0', { 'dist/cli.js': '// b\n' }, 'sha512', undefined, { ecmaos: { conflicts: ['con-a'] } })
      expect(await kernel.shell.execute(`install con-a --registry ${registry}`)).toBe(0)
      expect(await kernel.shell.execute(`install con-b --registry ${registry} 2> /tmp/con.err`)).toBe(1)
      expect(await kernel.filesystem.fs.readFile('/tmp/con.err', 'utf-8')).toContain('conflicts with con-a')
    })

    it('replaces an installed package it names in replaces', async () => {
      await publish('old-name', '1.0.0', { 'dist/cli.js': '// o\n' })
      expect(await kernel.shell.execute(`install old-name --registry ${registry}`)).toBe(0)
      await publish('new-name', '1.0.0', { 'dist/cli.js': '// n\n' }, 'sha512', undefined, { ecmaos: { replaces: ['old-name'] } })
      expect(await kernel.shell.execute(`install new-name --registry ${registry}`)).toBe(0)
      expect(await kernel.filesystem.fs.exists('/usr/lib/old-name')).toBe(false)
      expect(await kernel.filesystem.fs.exists('/usr/lib/new-name/1.0.0/package.json')).toBe(true)
    })
  })
  describe('holds and rollback', () => {
    it('an upgrade keeps the old version for one rollback, which swaps them back and forth', async () => {
      const fs = kernel.filesystem.fs
      await publish('gen-pkg', '1.0.0', { 'dist/cli.js': '// 1\n' })
      expect(await kernel.shell.execute(`install gen-pkg --registry ${registry}`)).toBe(0)
      await publish('gen-pkg', '2.0.0', { 'dist/cli.js': '// 2\n' })
      expect(await kernel.shell.execute(`install upgrade gen-pkg --registry ${registry}`)).toBe(0)
      expect(await fs.readlink('/usr/bin/gen-pkg')).toBe('/usr/lib/gen-pkg/2.0.0/dist/cli.js')
      expect(await fs.exists('/usr/lib/gen-pkg/1.0.0/package.json')).toBe(true)

      expect(await kernel.shell.execute('install rollback gen-pkg')).toBe(0)
      expect(await fs.readlink('/usr/bin/gen-pkg')).toBe('/usr/lib/gen-pkg/1.0.0/dist/cli.js')
      expect(await kernel.shell.execute('install --rollback gen-pkg')).toBe(0)
      expect(await fs.readlink('/usr/bin/gen-pkg')).toBe('/usr/lib/gen-pkg/2.0.0/dist/cli.js')
      expect(await kernel.shell.execute('install autoremove')).toBe(0)
      expect(await fs.exists('/usr/lib/gen-pkg/1.0.0/package.json')).toBe(true)
    })

    it('a package with no earlier version cannot be rolled back', async () => {
      await publish('gen-solo', '1.0.0', { 'dist/cli.js': '// 1\n' })
      expect(await kernel.shell.execute(`install gen-solo --registry ${registry}`)).toBe(0)
      expect(await kernel.shell.execute('install rollback gen-solo 2> /dev/null')).toBe(1)
    })

    it('a held package is not upgraded until it is unheld', async () => {
      const fs = kernel.filesystem.fs
      await publish('hold-pkg', '1.0.0', { 'dist/cli.js': '// 1\n' })
      expect(await kernel.shell.execute(`install hold-pkg --registry ${registry}`)).toBe(0)
      expect(await kernel.shell.execute('install hold hold-pkg')).toBe(0)
      await publish('hold-pkg', '2.0.0', { 'dist/cli.js': '// 2\n' })
      expect(await kernel.shell.execute(`install upgrade --registry ${registry}`)).toBe(0)
      expect(await fs.readlink('/usr/bin/hold-pkg')).toBe('/usr/lib/hold-pkg/1.0.0/dist/cli.js')
      expect(await kernel.shell.execute(`install hold-pkg --registry ${registry}`)).toBe(0)
      expect(await fs.readlink('/usr/bin/hold-pkg')).toBe('/usr/lib/hold-pkg/1.0.0/dist/cli.js')
      expect(await kernel.shell.execute('install unhold hold-pkg')).toBe(0)
      expect(await kernel.shell.execute(`install upgrade hold-pkg --registry ${registry}`)).toBe(0)
      expect(await fs.readlink('/usr/bin/hold-pkg')).toBe('/usr/lib/hold-pkg/2.0.0/dist/cli.js')
    })
  })
  describe('groups (ecmaos.meta)', () => {
    const group = async (name: string, members: string[]) => publish(name, '1.0.0', {}, 'sha512', Object.fromEntries(members.map(member => [member, 'latest'])), { ecmaos: { meta: true } })

    it('removing a member leaves the group installed, keeps the member out, and installing it by name brings it back', async () => {
      const fs = kernel.filesystem.fs
      await publish('grp-a', '1.0.0', { 'dist/cli.js': '// a\n' })
      await publish('grp-b', '1.0.0', { 'dist/cli.js': '// b\n' })
      await group('grp-all', ['grp-a', 'grp-b'])
      // the group's members are dependencies; publish() holds one route per name, so the group is last
      expect(await kernel.shell.execute(`install grp-all --registry ${registry}`)).toBe(0)
      expect(await fs.exists('/usr/lib/grp-a/1.0.0/package.json')).toBe(true)

      expect(await kernel.shell.execute('install remove grp-a')).toBe(0)
      expect(await fs.exists('/usr/lib/grp-a')).toBe(false)
      expect(await fs.exists('/usr/lib/grp-all/1.0.0/package.json')).toBe(true)
      expect(JSON.parse(await fs.readFile('/etc/ecmaos/profile.d/excluded.json', 'utf-8'))).toEqual(['grp-a'])
      expect(await kernel.shell.execute('install autoremove')).toBe(0)
      expect(await fs.exists('/usr/lib/grp-b/1.0.0/package.json')).toBe(true)

      // reinstalling the group does not bring the member back
      expect(await kernel.shell.execute(`install grp-all --reinstall --registry ${registry}`)).toBe(0)
      expect(await fs.exists('/usr/lib/grp-a')).toBe(false)

      expect(await kernel.shell.execute(`install grp-a --registry ${registry}`)).toBe(0)
      expect(await fs.exists('/usr/lib/grp-a/1.0.0/package.json')).toBe(true)
      expect(JSON.parse(await fs.readFile('/etc/ecmaos/profile.d/excluded.json', 'utf-8'))).toEqual([])
    })

    it('a group installs from a registry that holds only prerelease builds, ranged on latest', async () => {
      await publish('pre-a', '1.0.0-ecmaos.1', { 'dist/cli.js': '// a\n' })
      await group('pre-all', ['pre-a'])
      expect(await kernel.shell.execute(`install pre-all --registry ${registry}`)).toBe(0)
      expect(await kernel.filesystem.fs.exists('/usr/lib/pre-a/1.0.0-ecmaos.1/package.json')).toBe(true)
    })
  })
  describe('sources', () => {
    it('sends a scope to the registry /etc/ecmaos/sources.d lists for it, and everything else to the default', async () => {
      const fs = kernel.filesystem.fs
      const put = async (base: string, name: string, version: string) => {
        const tarball = await buildNpmTarballGzip({ 'package.json': JSON.stringify({ name, version, bin: { [name.split('/').pop()!]: 'cli.js' } }), 'cli.js': `// ${name}\n` })
        const dist = { tarball: `${registry}${base}/${name}/-/${version}.tgz`, shasum: await sha1Hex(tarball), integrity: await sha512Sri(tarball) }
        routes.set(`${base}/${name}/-/${version}.tgz`, () => ({ body: tarball }))
        routes.set(`${base}/${name}`, () => ({ body: JSON.stringify({ name, 'dist-tags': { latest: version }, versions: { [version]: { name, version, bin: { [name.split('/').pop()!]: 'cli.js' }, dist } } }) }))
      }
      await put('', 'src-plain', '1.0.0')
      await put('/alt', '@alt-scope/src-scoped', '1.0.0')
      await fs.mkdir('/etc/ecmaos/sources.d', { recursive: true })
      await fs.writeFile('/etc/ecmaos/sources.d/alt.json', JSON.stringify({ name: 'alt', registry: `${registry}/alt`, scopes: ['@alt-scope'], priority: 10 }))
      try {
        expect(await kernel.shell.execute(`REGISTRY=${registry} install src-plain @alt-scope/src-scoped`)).toBe(0)
        expect(await fs.exists('/usr/lib/src-plain/1.0.0/package.json')).toBe(true)
        expect(await fs.exists('/usr/lib/@alt-scope/src-scoped/1.0.0/package.json')).toBe(true)
        const db = JSON.parse(await fs.readFile('/var/lib/install/db.json', 'utf-8'))
        expect(db.packages['@alt-scope/src-scoped@1.0.0'].source).toBe(`${registry}/alt`)
        expect(db.packages['src-plain@1.0.0'].source).toBe(registry)
      } finally {
        await fs.unlink('/etc/ecmaos/sources.d/alt.json')
      }
    })
  })
  describe('the signed index', () => {
    const crypto = process.getBuiltinModule('node:crypto')
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
    const keyId = 'ed25519:test'
    const key = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')
    const sign = (text: string, withKey = privateKey) => crypto.sign(null, Buffer.from(text), withKey).toString('base64')
    const integrityOf = (name: string, version: string) => JSON.parse(String(routes.get(`/${name}`)!().body)).versions[version].dist.integrity as string

    const trustFiles = async (packages: Record<string, { latest: string, versions: Record<string, string> }>, options: { keyId?: string, notAfter?: string, text?: string, signature?: string } = {}) => {
      const fs = kernel.filesystem.fs
      const text = options.text ?? JSON.stringify({ schema: 1, packages })
      await fs.mkdir('/etc/ecmaos', { recursive: true })
      await fs.mkdir('/var/lib/install', { recursive: true })
      await fs.writeFile('/etc/ecmaos/trusted-keys.json', JSON.stringify([{ keyId, key, ...(options.notAfter ? { notAfter: options.notAfter } : {}) }]))
      await fs.writeFile('/var/lib/install/package-index.json', JSON.stringify({ version: '9.9.9', index: { schema: 2, common: {} }, trust: { text, signature: options.signature ?? sign(text), keyId: options.keyId ?? keyId } }))
    }
    const clean = async () => {
      for (const file of ['/etc/ecmaos/trusted-keys.json', '/var/lib/install/package-index.json']) await kernel.filesystem.fs.unlink(file).catch(() => {})
    }

    it('installs a package of ecmaOS\'s scope that is in the signed index, and refuses one that is not, changed, or newer than it', async () => {
      const fs = kernel.filesystem.fs
      await publish('@ecmaos-apps/sig-ok', '1.0.0', { 'dist/cli.js': '// ok\n' })
      await publish('@ecmaos-apps/sig-other', '1.0.0', { 'dist/cli.js': '// other\n' })
      await publish('@ecmaos-apps/sig-tampered', '1.0.0', { 'dist/cli.js': '// t\n' })
      try {
        await trustFiles({
          '@ecmaos-apps/sig-ok': { latest: '1.0.0', versions: { '1.0.0': integrityOf('@ecmaos-apps/sig-ok', '1.0.0') } },
          '@ecmaos-apps/sig-tampered': { latest: '1.0.0', versions: { '1.0.0': `sha512-${btoa('y'.repeat(64))}` } }
        })
        expect(await kernel.shell.execute(`install @ecmaos-apps/sig-ok --registry ${registry}`)).toBe(0)
        expect(await fs.exists('/usr/lib/@ecmaos-apps/sig-ok/1.0.0/package.json')).toBe(true)
        expect(await kernel.shell.execute(`install @ecmaos-apps/sig-other --registry ${registry} 2> /tmp/sig.err`)).toBe(1)
        expect(await fs.readFile('/tmp/sig.err', 'utf-8')).toContain('is not in the signed index')
        expect(await kernel.shell.execute(`install @ecmaos-apps/sig-tampered --registry ${registry} 2> /tmp/sig.err`)).toBe(1)
        expect(await fs.readFile('/tmp/sig.err', 'utf-8')).toContain('does not match the signed index')
        expect(await kernel.shell.execute(`install @ecmaos-apps/sig-other --allow-unsigned --registry ${registry}`)).toBe(0)
      } finally { await clean() }
    })

    it('refuses a latest the signed index does not name', async () => {
      await publish('@ecmaos-apps/sig-moved', '2.0.0', { 'dist/cli.js': '// 2\n' })
      try {
        await trustFiles({ '@ecmaos-apps/sig-moved': { latest: '1.0.0', versions: { '1.0.0': 'sha512-x', '2.0.0': integrityOf('@ecmaos-apps/sig-moved', '2.0.0') } } })
        expect(await kernel.shell.execute(`install @ecmaos-apps/sig-moved --registry ${registry} 2> /tmp/sig.err`)).toBe(1)
        expect(await kernel.filesystem.fs.readFile('/tmp/sig.err', 'utf-8')).toContain('the signed index says 1.0.0')
        expect(await kernel.shell.execute(`install @ecmaos-apps/sig-moved@2.0.0 --registry ${registry}`)).toBe(0)
      } finally { await clean() }
    })

    it('refuses a signed index with a bad signature, a key it does not trust, an expired key, and no signed index at all', async () => {
      const fs = kernel.filesystem.fs
      await publish('@ecmaos-apps/sig-bad', '1.0.0', { 'dist/cli.js': '// b\n' })
      const packages = { '@ecmaos-apps/sig-bad': { latest: '1.0.0', versions: { '1.0.0': integrityOf('@ecmaos-apps/sig-bad', '1.0.0') } } }
      const text = JSON.stringify({ schema: 1, packages })
      const attempts: [Parameters<typeof trustFiles>[1], string][] = [
        [{ signature: sign(text, crypto.generateKeyPairSync('ed25519').privateKey) }, 'does not verify'],
        [{ keyId: 'ed25519:other' }, 'does not trust'],
        [{ notAfter: '2000-01-01T00:00:00Z' }, 'does not trust'],
        [{ text: text + ' ', signature: sign(text) }, 'does not verify']
      ]
      try {
        for (const [options, message] of attempts) {
          await trustFiles(packages, options)
          expect(await kernel.shell.execute(`install @ecmaos-apps/sig-bad --registry ${registry} 2> /tmp/sig.err`)).toBe(1)
          expect(await fs.readFile('/tmp/sig.err', 'utf-8')).toContain(message)
        }
        await clean()
        expect(await kernel.shell.execute(`install @ecmaos-apps/sig-bad --registry ${registry} 2> /tmp/sig.err`)).toBe(1)
        expect(await fs.readFile('/tmp/sig.err', 'utf-8')).toContain('there is no signed index')
      } finally { await clean() }
    })

    it('does not check a package outside the signed scope', async () => {
      await publish('sig-free', '1.0.0', { 'dist/cli.js': '// f\n' })
      expect(await kernel.shell.execute(`install sig-free --registry ${registry}`)).toBe(0)
    })
  })
})
