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

  const publish = async (name: string, version: string, files: Record<string, string>, integrity: 'sha512' | 'sha1-only' | 'bad-sha512' = 'sha512', dependencies?: Record<string, string>) => {
    const tarball = await buildNpmTarballGzip({ 'package.json': JSON.stringify({ name, version, dependencies, bin: files['dist/cli.js'] ? { [name.split('/').pop()!]: 'dist/cli.js' } : undefined }), ...files })
        const dist = {
      tarball: `${registry}/${name}/-/${version}.tgz`,
      shasum: await sha1Hex(tarball),
      ...(integrity === 'sha512' ? { integrity: await sha512Sri(tarball) } : integrity === 'bad-sha512' ? { integrity: `sha512-${btoa('x'.repeat(64))}` } : {})
    }
    routes.set(`/${name}/-/${version}.tgz`, () => ({ body: tarball }))
    routes.set(`/${name}`, () => ({ body: JSON.stringify({ name, 'dist-tags': { latest: version }, versions: { [version]: { dist } } }) }))
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
})
