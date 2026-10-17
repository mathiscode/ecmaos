import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTarPacker } from 'modern-tar'
import pako from 'pako'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * `install` is a worker program whose `fetch` cannot be stubbed, so the registry is a real local HTTP server.
 * `install` extracts with the `tar` coreutil (`tar -xzf ... -C <scratch>`) and moves the result into place, stripping
 * npm's `package/` wrapper.
 */
async function buildNpmTarballGzip(files: Record<string, string>): Promise<Uint8Array> {
  const { readable, controller } = createTarPacker()
  const chunks: Uint8Array[] = []
  const readerDone = (async () => {
    const reader = readable.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
  })()

  for (const [name, content] of Object.entries(files)) {
    const bytes = new TextEncoder().encode(content)
    const entryStream = controller.add({ name: `package/${name}`, type: 'file', size: bytes.length })
    const writer = entryStream.getWriter()
    await writer.write(bytes)
    await writer.close()
  }
  controller.finalize()
  await readerDone

  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const tarBytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { tarBytes.set(chunk, offset); offset += chunk.length }

  return pako.gzip(tarBytes)
}

async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', bytes)
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
}

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
})
