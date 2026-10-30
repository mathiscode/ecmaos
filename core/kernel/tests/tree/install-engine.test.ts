import type { IncomingMessage, Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bindContext } from '@zenfs/core'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { buildNpmTarballGzip, sha512Sri } from './fixtures/npm-tarball'
import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * The package engine behind `install` (`src/bin/commands/lib/install/`): its database of what was asked for by name and
 * what came in as a dependency, removing and `autoremove`, upgrades, the metadata and tarball cache, registry signatures,
 * the script policy, local tarballs and the `~/.local` scope. The registry is a real local HTTP server.
 */
describe('install engine', () => {
  let kernel: Kernel
  let server: Server
  let registry = ''
  const routes = new Map<string, () => { body: string | Uint8Array, status?: number }>()
  const requests: IncomingMessage[] = []
  /** Every version published, by package: what the registry's metadata lists */
  const published = new Map<string, Record<string, Record<string, unknown>>>()
  const latest = new Map<string, string>()

  const fs = () => kernel.filesystem.fs
  const run = async (command: string) => {
    await fs().unlink('/tmp/ie-out').catch(() => {})
    await fs().unlink('/tmp/ie-err').catch(() => {})
    const code = await kernel.shell.execute(`${command} > /tmp/ie-out 2> /tmp/ie-err`)
    const read = (name: string) => fs().readFile(`/tmp/ie-${name}`, 'utf-8').catch(() => '')
    return { code, out: await read('out'), err: await read('err') }
  }
  const db = async (path = '/var/lib/install/db.json') => JSON.parse(await fs().readFile(path, 'utf-8')).packages as Record<string, { explicit: boolean, dependencies: Record<string, string> }>

  /** Publishes `name@version` with `manifest` (dependencies, bin, scripts...) and makes it the latest unless `tag` is false */
  const publish = async (name: string, version: string, manifest: Record<string, unknown> = {}, files: Record<string, string> = {}, options: { latest?: boolean, sign?: (name: string, version: string, integrity: string) => Promise<unknown> } = {}) => {
    const full = { name, version, ...manifest }
    const tarball = await buildNpmTarballGzip({ 'package.json': JSON.stringify(full), 'index.js': `// ${name}@${version}\n`, ...files })
    const integrity = await sha512Sri(tarball)
    const dist: Record<string, unknown> = { tarball: `${registry}/${name}/-/${version}.tgz`, integrity, unpackedSize: tarball.length }
    if (options.sign) dist.signatures = [await options.sign(name, version, integrity)]
    routes.set(`/${name}/-/${version}.tgz`, () => ({ body: tarball }))
    const versions = published.get(name) ?? {}
    versions[version] = { ...full, dist }
    published.set(name, versions)
    if (options.latest !== false) latest.set(name, version)
    routes.set(`/${name}`, () => ({ body: JSON.stringify({ name, 'dist-tags': { latest: latest.get(name) }, versions: published.get(name), description: `the ${name} package`, maintainers: [{ name: 'someone' }] }) }))
  }
  const fetchedTarballs = () => requests.filter(request => request.url?.endsWith('.tgz')).map(request => request.url)

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
    const { createServer } = process.getBuiltinModule('node:http')
    server = createServer((req, res) => {
      requests.push(req)
      const route = routes.get(req.url ?? '')
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

  it('asks a registry that is not npm\'s for the whole document (it carries ecmaos), and records what was named apart from what came in as a dependency', async () => {
    await publish('ie-lib', '1.0.0', {}, { 'dist/cli.js': '//\n' })
    await publish('ie-app', '1.0.0', { dependencies: { 'ie-lib': '^1.0.0' }, bin: { 'ie-app': 'index.js' } })
    const result = await run(`install ie-app --registry ${registry}`)
    expect(result.code, result.err).toBe(0)
    expect(result.out).toContain('The following NEW packages will be installed:')
    expect(result.out).toContain('ie-lib@1.0.0 (dependency)')
    expect(requests.find(request => request.url === '/ie-app')?.headers.accept).toBe('application/json')

    const packages = await db()
    expect(packages['ie-app@1.0.0']).toMatchObject({ explicit: true, dependencies: { 'ie-lib': '1.0.0' } })
    expect(packages['ie-lib@1.0.0']).toMatchObject({ explicit: false })

    expect((await run('install list')).out).toContain('ie-app@1.0.0')
    expect((await run('install list')).out).not.toContain('ie-lib')
    expect((await run('install list --all')).out).toContain('ie-lib@1.0.0 [dependency]')
  })

  it('gives a dependency the version already installed when its range takes it, without fetching it again', async () => {
    await publish('ie-lib', '1.1.0')
    await publish('ie-app2', '1.0.0', { dependencies: { 'ie-lib': '^1.0.0' } })
    const before = fetchedTarballs().length
    expect((await run(`install ie-app2 --registry ${registry}`)).code).toBe(0)
    expect(fetchedTarballs().slice(before)).toEqual(['/ie-app2/-/1.0.0.tgz'])
    expect((await db())['ie-app2@1.0.0'].dependencies).toEqual({ 'ie-lib': '1.0.0' })
  })

  it('lays out node_modules as links to the dependencies, and removing a package leaves what they point at', async () => {
    await publish('ie-leaf', '1.0.0', {}, { 'data.txt': 'leaf\n' })
    await publish('@ie/scoped', '1.0.0', {}, { 'data.txt': 'scoped\n' })
    await publish('ie-root', '1.0.0', { dependencies: { 'ie-leaf': '^1', '@ie/scoped': '^1' } })
    expect((await run(`install ie-root --registry ${registry}`)).code).toBe(0)
    expect(await fs().readlink('/usr/lib/ie-root/1.0.0/node_modules/ie-leaf')).toBe('../../../ie-leaf/1.0.0')
    expect(await fs().readlink('/usr/lib/ie-root/1.0.0/node_modules/@ie/scoped')).toBe('../../../../@ie/scoped/1.0.0')
    expect(await fs().readFile('/usr/lib/ie-root/1.0.0/node_modules/ie-leaf/data.txt', 'utf-8')).toBe('leaf\n')
    expect(await fs().readFile('/usr/lib/ie-root/1.0.0/node_modules/@ie/scoped/data.txt', 'utf-8')).toBe('scoped\n')

    // the links are not followed: removing the root keeps nothing alive, but a dependency removed by hand keeps its files
    expect((await run('install remove ie-root')).code).toBe(0)
    expect(await fs().exists('/usr/lib/ie-root')).toBe(false)
    expect(await fs().readFile('/usr/lib/ie-leaf/1.0.0/data.txt', 'utf-8')).toBe('leaf\n')
    expect((await run('install autoremove')).code).toBe(0)
    expect(await fs().exists('/usr/lib/ie-leaf')).toBe(false)
  })

  it('keeps a package another still needs as a dependency, and autoremove takes what nothing needs', async () => {
    let result = await run('install remove ie-app')
    expect(result.code, result.err).toBe(0)
    expect(await fs().exists('/usr/lib/ie-app')).toBe(false)
    expect(await fs().exists('/usr/bin/ie-app')).toBe(false)
    // ie-app2 still depends on it
    expect(await fs().exists('/usr/lib/ie-lib/1.0.0/package.json')).toBe(true)

    result = await run('uninstall ie-app2')
    expect(result.code, result.err).toBe(0)
    expect(result.out).toContain("Use 'install autoremove' to remove them.")
    expect(result.out).toContain('ie-lib@1.0.0')

    result = await run('install autoremove')
    expect(result.code, result.err).toBe(0)
    expect(result.out).toContain('Uninstalled ie-lib@1.0.0')
    expect(await fs().exists('/usr/lib/ie-lib')).toBe(false)
    expect((await run('install autoremove')).out).toContain('0 packages to remove.')
  })

  it('removing a dependency that is still needed keeps its files', async () => {
    await publish('ie-dep', '1.0.0', { bin: { 'ie-dep': 'index.js' } })
    await publish('ie-top', '1.0.0', { dependencies: { 'ie-dep': '1.0.0' } })
    expect((await run(`install ie-top ie-dep --registry ${registry}`)).code).toBe(0)
    expect(await fs().readlink('/usr/bin/ie-dep')).toBe('/usr/lib/ie-dep/1.0.0/index.js')
    const result = await run('install remove ie-dep')
    expect(result.code).toBe(0)
    expect(result.out).toContain('is still needed by ie-top@1.0.0')
    expect(await fs().exists('/usr/bin/ie-dep')).toBe(false)
    expect(await fs().exists('/usr/lib/ie-dep/1.0.0/package.json')).toBe(true)
    expect((await db())['ie-dep@1.0.0'].explicit).toBe(false)
    expect((await run('install remove --autoremove ie-top')).code).toBe(0)
    expect(await fs().exists('/usr/lib/ie-dep')).toBe(false)
  })

  it('outdated lists a newer version, update counts it, and upgrade replaces the old version', async () => {
    await publish('ie-up', '1.0.0', { bin: { 'ie-up': 'index.js' } })
    expect((await run(`install ie-up --registry ${registry}`)).code).toBe(0)
    await publish('ie-up', '2.0.0', { bin: { 'ie-up': 'index.js' } })

    let result = await run(`install outdated --registry ${registry}`)
    expect(result.code).toBe(1)
    expect(result.out).toMatch(/ie-up\s+1\.0\.0\s+2\.0\.0\s+2\.0\.0/)
    expect((await run(`install update --registry ${registry}`)).out).toContain('can be upgraded')

    result = await run(`install upgrade --registry ${registry}`)
    expect(result.code, result.err).toBe(0)
    expect(result.out).toContain('ie-up (1.0.0 => 2.0.0)')
    expect(await fs().readlink('/usr/bin/ie-up')).toBe('/usr/lib/ie-up/2.0.0/index.js')
    // the version replaced stays for one rollback
    expect(await fs().exists('/usr/lib/ie-up/1.0.0')).toBe(true)
    expect((await run(`install outdated --registry ${registry}`)).code).toBe(0)
    expect((await run(`install upgrade --registry ${registry}`)).out).toContain('All packages are up to date.')
  })

  it('reinstalls from the cache with --offline, and refuses what the cache does not have', async () => {
    const before = fetchedTarballs().length
    const result = await run(`install --reinstall --offline ie-up --registry ${registry}`)
    expect(result.code, result.err).toBe(0)
    expect(fetchedTarballs().length).toBe(before)
    const missing = await run(`install --offline ie-never --registry ${registry}`)
    expect(missing.code).toBe(1)
    expect(missing.err).toContain('--offline')
  })

  it('takes a dist-tag, a range and an exact version', async () => {
    await publish('ie-tags', '1.0.0')
    await publish('ie-tags', '1.5.0')
    await publish('ie-tags', '2.0.0-beta.1', {}, {}, { latest: false })
    const document = JSON.parse(routes.get('/ie-tags')!().body as string)
    document['dist-tags'].next = '2.0.0-beta.1'
    routes.set('/ie-tags', () => ({ body: JSON.stringify(document) }))
    expect((await run(`install -n ie-tags@~1.0 --registry ${registry}`)).out).toContain('ie-tags@1.0.0')
    expect((await run(`install -n ie-tags@next --registry ${registry}`)).out).toContain('ie-tags@2.0.0-beta.1')
    expect((await run(`install -n ie-tags --registry ${registry}`)).out).toContain('ie-tags@1.5.0')
    expect(await fs().exists('/usr/lib/ie-tags')).toBe(false)
    const none = await run(`install ie-tags@^9 --registry ${registry}`)
    expect(none.code).toBe(1)
    expect(none.err).toContain('No version of ie-tags matches ^9')
  })

  it('installs a peer dependency, and skips an optional one built for another platform', async () => {
    await publish('ie-peer', '1.0.0')
    await publish('ie-native', '1.0.0', { os: ['linux'], cpu: ['x64'] })
    await publish('ie-host', '1.0.0', { peerDependencies: { 'ie-peer': '1' }, optionalDependencies: { 'ie-native': '1.0.0' } })
    const result = await run(`install ie-host --registry ${registry}`)
    expect(result.code, result.err).toBe(0)
    expect(await fs().exists('/usr/lib/ie-peer/1.0.0/package.json')).toBe(true)
    expect(await fs().exists('/usr/lib/ie-native')).toBe(false)
  })

  it('verifies the registry signature when it knows the registry\'s keys, and refuses a bad or missing one', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))
    await fs().mkdir('/etc/install', { recursive: true })
    await fs().writeFile('/etc/install/keys.json', JSON.stringify({ [registry]: [{ keyid: 'SHA256:test', key: btoa(String.fromCharCode(...spki)) }] }))
    const sign = async (name: string, version: string, integrity: string) => {
      const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(`${name}@${version}:${integrity}`)))
      return { keyid: 'SHA256:test', sig: btoa(String.fromCharCode(...derOf(raw))) }
    }
    try {
      await publish('ie-signed', '1.0.0', {}, {}, { sign })
      let result = await run(`install ie-signed --registry ${registry}`)
      expect(result.code, result.err).toBe(0)

      await publish('ie-forged', '1.0.0', {}, {}, { sign: (name, version) => sign(name, version, 'sha512-something-else') })
      result = await run(`install ie-forged --registry ${registry}`)
      expect(result.code).toBe(1)
      expect(result.err).toContain('does not verify')
      expect(await fs().exists('/usr/lib/ie-forged')).toBe(false)

      await publish('ie-unsigned', '1.0.0')
      result = await run(`install ie-unsigned --registry ${registry}`)
      expect(result.code).toBe(1)
      expect(result.err).toContain('has no registry signature')
      expect((await run(`install --ignore-signatures ie-unsigned --registry ${registry}`)).code).toBe(0)

      expect((await run(`install info ie-signed --registry ${registry}`)).out).toContain('verified')
    } finally {
      await fs().unlink('/etc/install/keys.json')
    }
  })

  it('runs install scripts only for trusted packages', async () => {
    const scripts = { scripts: { 'ecmaos:postinstall': 'echo ran > /tmp/ie-script-$npm_package_name' } }
    await publish('ie-script', '1.0.0', scripts)
    let result = await run(`install ie-script --registry ${registry}`)
    expect(result.code, result.err).toBe(0)
    expect(result.err).toContain('Skipped ecmaos:postinstall of ie-script@1.0.0')
    expect(await fs().exists('/tmp/ie-script-ie-script')).toBe(false)

    result = await run(`install --reinstall --allow-scripts ie-script --registry ${registry}`)
    expect(result.code, result.err).toBe(0)
    expect(await fs().readFile('/tmp/ie-script-ie-script', 'utf-8')).toBe('ran\n')

    await publish('ie-script2', '1.0.0', scripts)
    await fs().writeFile('/etc/install/allow-scripts', '# trusted\nie-script2\n')
    try {
      expect((await run(`install ie-script2 --registry ${registry}`)).code).toBe(0)
      expect(await fs().readFile('/tmp/ie-script-ie-script2', 'utf-8')).toBe('ran\n')
    } finally {
      await fs().unlink('/etc/install/allow-scripts')
    }
  })

  it('installs a local tarball, fetching its dependencies from the registry', async () => {
    await publish('ie-remote-dep', '1.0.0')
    const tarball = await buildNpmTarballGzip({ 'package.json': JSON.stringify({ name: 'ie-local', version: '0.1.0', dependencies: { 'ie-remote-dep': '1' }, bin: { 'ie-local': 'cli.js' } }), 'cli.js': '//\n' })
    await fs().writeFile('/tmp/ie-local-0.1.0.tgz', tarball)
    const result = await run(`install /tmp/ie-local-0.1.0.tgz --registry ${registry}`)
    expect(result.code, result.err).toBe(0)
    expect(await fs().readlink('/usr/bin/ie-local')).toBe('/usr/lib/ie-local/0.1.0/cli.js')
    expect(await fs().exists('/usr/lib/ie-remote-dep/1.0.0/package.json')).toBe(true)
    expect((await db())['ie-local@0.1.0']).toMatchObject({ explicit: true, source: 'file:/tmp/ie-local-0.1.0.tgz' })
  })

  it('installs into ~/.local with --user', async () => {
    await publish('ie-mine', '1.0.0', { bin: { 'ie-mine': 'index.js' } })
    const result = await run(`install --user ie-mine --registry ${registry}`)
    expect(result.code, result.err).toBe(0)
    expect(await fs().readlink('/root/.local/bin/ie-mine')).toBe('/root/.local/lib/ie-mine/1.0.0/index.js')
    expect((await db('/root/.local/state/install/db.json'))['ie-mine@1.0.0'].explicit).toBe(true)
    expect(await fs().exists('/usr/lib/ie-mine')).toBe(false)
    expect((await run('install list --user')).out).toContain('ie-mine@1.0.0')
    expect((await run('install remove --user ie-mine')).code).toBe(0)
    expect(await fs().exists('/root/.local/lib/ie-mine')).toBe(false)
  })

  it('installs into the home of an ordinary user, and refuses a system install', async () => {
    await kernel.users.add({ username: 'ieuser', password: 'wonder', home: '/home/ieuser', shell: '/bin/ecmash' })
    const user = [...(kernel.users.all as Map<number, { uid: number, gid: number, username: string }>).values()].find(u => u.username === 'ieuser')!
    await publish('ie-home', '1.0.0', { bin: { 'ie-home': 'index.js' } })
    const rootCredentials = { ...kernel.shell.credentials }
    const rootContext = kernel.shell.context
    const credentials = { uid: user.uid, gid: user.gid, suid: user.uid, sgid: user.gid, euid: user.uid, egid: user.gid, groups: [user.gid] }
    kernel.shell.credentials = credentials
    kernel.shell.context = bindContext({ root: '/', pwd: '/', credentials })
    kernel.shell.cwd = '/home/ieuser'
    // a login sets HOME; this shell is still root's
    try {
      // each user has files of their own: /tmp/ie-out is root's
      await kernel.shell.execute('export HOME=/home/ieuser')
      const code = await kernel.shell.execute(`install ie-home --registry ${registry} > /tmp/ie-user-out 2> /tmp/ie-user-err`)
      const err = await fs().readFile('/tmp/ie-user-err', 'utf-8').catch(() => '')
      expect(code, err).toBe(0)
      expect(await kernel.shell.execute(`install -g ie-home --registry ${registry} 2> /tmp/ie-user-err`)).toBe(1)
      expect(await fs().readFile('/tmp/ie-user-err', 'utf-8')).toContain('needs root')
    } finally {
      kernel.shell.credentials = rootCredentials
      kernel.shell.context = rootContext
      kernel.shell.cwd = '/'
      await kernel.shell.execute('export HOME=/root')
    }
    expect(await fs().readlink('/home/ieuser/.local/bin/ie-home')).toBe('/home/ieuser/.local/lib/ie-home/1.0.0/index.js')
    expect((await fs().stat('/home/ieuser/.local/lib/ie-home/1.0.0/package.json')).uid).toBe(user.uid)
    expect(await fs().exists('/usr/lib/ie-home')).toBe(false)
  })

  it('adopts a package installed before there was a database', async () => {
    await fs().mkdir('/usr/lib/@ie/old/3.0.0', { recursive: true })
    await fs().writeFile('/usr/lib/@ie/old/3.0.0/package.json', JSON.stringify({ name: '@ie/old', version: '3.0.0' }))
    expect((await run('install list')).out).toContain('@ie/old@3.0.0')
    expect((await run('install remove @ie/old')).code).toBe(0)
    expect(await fs().exists('/usr/lib/@ie')).toBe(false)
  })

  it('searches the registry and shows a package\'s details', async () => {
    routes.set('/-/v1/search?text=ie%20up&size=20', () => ({ body: JSON.stringify({ objects: [{ package: { name: 'ie-up', version: '2.0.0', description: 'upgrades' } }] }) }))
    let result = await run(`install search ie up --registry ${registry}`)
    expect(result.code, result.err).toBe(0)
    expect(result.out).toContain('ie-up')
    expect(result.out).toContain('[installed]')
    expect(result.out).toContain('upgrades')

    result = await run(`install info ie-up --registry ${registry}`)
    expect(result.code, result.err).toBe(0)
    expect(result.out).toContain('ie-up@2.0.0')
    expect(result.out).toContain('the ie-up package')
    expect(result.out).toContain('installed: 2.0.0')
  })
})

/** An ECDSA P-256 signature in DER, as npm lists it, from WebCrypto's `r || s` */
function derOf(raw: Uint8Array) {
  const integer = (bytes: Uint8Array) => {
    let start = 0
    while (start < bytes.length - 1 && bytes[start] === 0) start++
    const trimmed = bytes.subarray(start)
    const value = trimmed[0]! & 0x80 ? new Uint8Array([0, ...trimmed]) : trimmed
    return [0x02, value.length, ...value]
  }
  const body = [...integer(raw.subarray(0, 32)), ...integer(raw.subarray(32))]
  return new Uint8Array([0x30, body.length, ...body])
}
