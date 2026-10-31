import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { stagePrograms } from '#lib/programs.ts'
import { programCatalog } from '../../vite-plugin-bin-node'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { buildNpmTarballGzip, sha512Sri } from './fixtures/npm-tarball'
import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

// @ts-expect-error - a script, not a module with types
import { indexEntries, semverOf, versionOf } from '../../../../utils/apps-packages.mjs'

/**
 * The WebAssembly programs as npm packages (`@ecmaos-apps/NAME`, written by `utils/apps-packages.mjs`): the package
 * `figlet` and `lolcat` really become, installed from a registry like any other, linked as bins, with the runtime files a
 * program needs linked into `/usr`.
 */
const script = process.getBuiltinModule('node:path').resolve(process.cwd(), '../../utils/apps-packages.mjs')

describe('wasm programs as packages', () => {
  let kernel: Kernel
  let server: Server
  let registry = ''
  const routes = new Map<string, Uint8Array | string>()
  const fs = () => kernel.filesystem.fs
  const run = async (command: string) => {
    await fs().unlink('/tmp/wa-out').catch(() => {})
    await fs().unlink('/tmp/wa-err').catch(() => {})
    const code = await kernel.shell.execute(`${command} > /tmp/wa-out 2> /tmp/wa-err`)
    const read = (name: string) => fs().readFile(`/tmp/wa-${name}`, 'utf-8').catch(() => '')
    return { code, out: await read('out'), err: await read('err') }
  }

  /** Writes `name`'s package as the generator does (and its source package, for a copyleft program) and serves them from the registry */
  const publishProgram = async (name: string) => {
    const { mkdtempSync, readdirSync, readFileSync, statSync, existsSync } = process.getBuiltinModule('node:fs')
    const { join } = process.getBuiltinModule('node:path')
    const { tmpdir } = process.getBuiltinModule('node:os')
    const { execFileSync } = process.getBuiltinModule('node:child_process')
    const out = mkdtempSync(join(tmpdir(), 'wa-'))
    execFileSync('node', [script, 'build', out, name])
    let result!: { manifest: Record<string, any>, files: Record<string, Uint8Array | string> }
    for (const folder of [name, `${name}-src`].filter(candidate => existsSync(join(out, candidate)))) {
      const directory = join(out, folder)
      const files: Record<string, Uint8Array | string> = {}
      const visit = (path: string, prefix: string) => {
        for (const child of readdirSync(path)) {
          const full = join(path, child)
          if (statSync(full).isDirectory()) visit(full, `${prefix}${child}/`)
          else files[`${prefix}${child}`] = new Uint8Array(readFileSync(full))
        }
      }
      visit(directory, '')
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
      const tarball = await buildNpmTarballGzip(files)
      const dist = { tarball: `${registry}/${manifest.name}/-/${manifest.version}.tgz`, integrity: await sha512Sri(tarball) }
      routes.set(`/${manifest.name}/-/${manifest.version}.tgz`, tarball)
      routes.set(`/${manifest.name}`, JSON.stringify({ name: manifest.name, 'dist-tags': { latest: manifest.version }, versions: { [manifest.version]: { ...manifest, dist } } }))
      if (folder === name) result = { manifest, files }
    }
    return result
  }

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
    const { createServer } = process.getBuiltinModule('node:http')
    server = createServer((req, res) => {
      const body = routes.get((req.url ?? '').replace(/%40/g, '@').replace(/%2f/gi, '/'))
      if (body === undefined) { res.statusCode = 404; res.end('not found'); return }
      res.end(body)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
  }, 60000)

  afterAll(() => { server?.close() })

  it('names a package for each program, with the upstream version as semver', () => {
    expect(semverOf('1.22')).toBe('1.22.0')
    expect(semverOf('3.5a')).toBe('3.5.0')
    expect(semverOf('5.02')).toBe('5.2.0')
    expect(semverOf('20260719')).toBe('20260719.0.0')
    expect(versionOf({ version: '3.5a' })).toBe('3.5.0-ecmaos.1')
    expect(versionOf({ version: '9.1.0', revision: 3 })).toBe('9.1.0-ecmaos.3')
    const listed = process.getBuiltinModule('node:child_process').execFileSync('node', [script, 'list'], { encoding: 'utf8' }).trim().split('\n')
    expect(listed).toContain('@ecmaos-apps/jq@1.8.2-ecmaos.1')
    expect(new Set(listed).size).toBe(listed.length)
  }, 60_000)

  // the script reads the file system, which the test runner's shim does not serve: run it as a real process
  const node = (code: string) => JSON.parse(process.getBuiltinModule('node:child_process').execFileSync('node', ['--input-type=module', '-e', `import * as m from ${JSON.stringify(script)}; ${code}`], { encoding: 'utf8' }))

  it('lists the aliases the kernel links as extra bins, and what a program needs of the kernel', () => {
    const { aliases, manifest } = node(`const xz = m.programs().find(entry => entry.name === 'xz'); console.log(JSON.stringify({ aliases: m.aliasesOf().xz, manifest: m.manifestFor(xz) }))`)
    expect(aliases).toContain('unxz')
    expect(manifest.bin).toMatchObject({ xz: 'xz.wasm', unxz: 'xz.wasm', xzcat: 'xz.wasm' })
    expect(manifest.ecmaos.requires.features).toEqual(['wasm', 'wali'])
  }, 60_000)

  it('writes a meta-package per group and profile, on latest, with every program in Everything', () => {
    const result = node(`
      const { groups, profiles } = m.groupsOf()
      const fs = await import('node:fs'); const os = await import('node:os')
      const out = fs.mkdtempSync(os.tmpdir() + '/groups-')
      const read = name => JSON.parse(fs.readFileSync(out + '/' + name + '/package.json', 'utf8'))
      const written = m.buildGroups(out)
      const result = {
        groups: Object.keys(groups), written: written.length, expected: Object.keys(groups).length + Object.keys(profiles).length,
        everything: profiles.everything.groups.flatMap(group => groups[group].members).sort(), programs: [...m.programs().map(entry => entry.name), ...m.scripts().map(entry => entry.name)].sort(),
        editors: read('group-editors'), standard: read('profile-standard'), minimal: read('profile-minimal')
      }
      fs.rmSync(out, { recursive: true, force: true })
      console.log(JSON.stringify(result))`)
    expect(result.groups).toContain('editors')
    expect(result.everything).toEqual(result.programs)
    expect(result.written).toBe(result.expected)
    expect(result.editors.dependencies).toEqual({ '@ecmaos-apps/vim': 'latest' })
    expect(result.editors.ecmaos.meta).toBe(true)
    expect(result.standard.dependencies['@ecmaos-apps/group-editors']).toBe('latest')
    expect(result.minimal.dependencies['@ecmaos-apps/bash']).toBe('latest')
    expect(result.minimal.dependencies['@ecmaos-apps/group-shells']).toBeUndefined()
  }, 60_000)

  it('packages pip as one file that depends on python3 and links its commands', () => {
    const result = node(`
      const fs = await import('node:fs'); const os = await import('node:os')
      const out = fs.mkdtempSync(os.tmpdir() + '/pip-')
      m.buildScript(m.scripts()[0], out)
      const manifest = JSON.parse(fs.readFileSync(out + '/pip/package.json', 'utf8'))
      const code = fs.readFileSync(out + '/pip/pip.mjs', 'utf8')
      const files = fs.readdirSync(out + '/pip').sort()
      fs.rmSync(out, { recursive: true, force: true })
      console.log(JSON.stringify({ manifest, files, imports: /^import .* from ['"]\\./m.test(code) }))`)
    expect(result.manifest.name).toBe('@ecmaos-apps/pip')
    expect(result.manifest.dependencies).toEqual({ '@ecmaos-apps/python3': 'latest' })
    expect(result.manifest.ecmaos.link).toEqual(['@ecmaos-apps/python3'])
    expect(result.manifest.bin).toEqual({ pip: 'pip.mjs', pip3: 'pip.mjs' })
    expect(result.files).toEqual(['README.md', 'package.json', 'pip.mjs'])
    expect(result.imports).toBe(false)
  }, 60_000)

  it('describes a program as a package: its bin, its runtime and where the license texts go', async () => {
    const { manifest, files } = await publishProgram('figlet')
    expect(manifest.name).toBe('@ecmaos-apps/figlet')
    expect(manifest.bin).toEqual({ figlet: 'figlet.wasm' })
    expect(manifest.ecmaos.runtime).toBe('runtime')
    expect(Object.keys(files).some(file => file.startsWith('runtime/usr/'))).toBe(true)
    expect(Object.keys(files).some(file => file.startsWith('share/licenses/figlet/'))).toBe(true)
  }, 60_000)

  it('keeps an empty directory of the runtime, which npm would drop and CPython warns of', async () => {
    const { files } = await publishProgram('python3')
    expect(Object.keys(files)).toContain('runtime/usr/lib/python3.14/lib-dynload/.keep')
  }, 60_000)

  it('installs a program: the bin links the .wasm, the runtime and licenses are linked into /usr, and it runs', async () => {
    await publishProgram('figlet')
    const result = await run(`install -g @ecmaos-apps/figlet --registry ${registry} --ignore-signatures --allow-unsigned`)
    expect(result.code, result.err).toBe(0)
    expect(await fs().readlink('/usr/bin/figlet')).toMatch(/\/figlet\/[\w.-]+\/figlet\.wasm$/)
    const manifest = JSON.parse(await fs().readFile('/usr/lib/@ecmaos-apps/figlet/' + (await fs().readdir('/usr/lib/@ecmaos-apps/figlet'))[0] + '/package.json', 'utf-8'))
    const runtimeFile = Object.keys((await publishProgram('figlet')).files).find(file => file.startsWith('runtime/usr/'))!.slice('runtime'.length)
    expect((await fs().lstat(runtimeFile)).isSymbolicLink()).toBe(true)
    expect(manifest.ecmaos.runtime).toBe('runtime')
    expect((await fs().readdir('/usr/share/licenses/figlet')).length).toBeGreaterThan(0)
    const ran = await run('/usr/bin/figlet hi')
    expect(ran.code, ran.err).toBe(0)
    expect(ran.out).toContain('_')
  }, 60_000)

  it('removes the bin, the runtime links and the files with the package', async () => {
    const runtimeFile = Object.keys((await publishProgram('figlet')).files).find(file => file.startsWith('runtime/usr/'))!.slice('runtime'.length)
    const result = await run('uninstall -g @ecmaos-apps/figlet')
    expect(result.code, result.err).toBe(0)
    expect(await fs().exists('/usr/bin/figlet')).toBe(false)
    expect(await fs().exists(runtimeFile)).toBe(false)
    expect(await fs().exists('/usr/lib/@ecmaos-apps/figlet')).toBe(false)
  }, 60_000)

  it('leaves a user install without the /usr runtime, saying why', async () => {
    await publishProgram('figlet')
    const result = await run(`install --user @ecmaos-apps/figlet --registry ${registry} --ignore-signatures --allow-unsigned`)
    expect(result.err).toContain('needs files under /usr')
  }, 60_000)

  it('offers to move only permissive programs that Standard does not boot with', () => {
    const names = node('console.log(JSON.stringify(m.candidates(m.programs().map(entry => ({ ...entry, program: { ...entry.program, package: undefined } })))))') as string[]
    expect(names).toContain('rg')
    for (const kept of ['jq', 'vim', 'bash', 'tmux', 'xz']) expect(names).not.toContain(kept)
  })

  it('reports a package that is not on the registry, and one whose latest is another version', () => {
    const results = node(`globalThis.fetch = async url => String(url).includes('figlet')
      ? new Response(JSON.stringify({ versions: { '2.2.5-ecmaos.1': {} }, 'dist-tags': { latest: '0.0.1' } }))
      : new Response('{}', { status: 404 })
      console.log(JSON.stringify([...await m.readiness('http://registry.test/', ['figlet']), ...await m.readiness('http://registry.test', ['rg'])]))`) as { problem: string }[]
    expect(results[0].problem).toContain('latest is 0.0.1')
    expect(results[1].problem).toBe('not published')
  })

  it('writes index entries only for programs a manifest marks as moved', () => {
    const entries = indexEntries([
      { name: 'jq', program: { description: 'jq', package: '@ecmaos-apps/jq' } },
      { name: 'vim', program: { description: 'vim' } }
    ])
    expect(entries).toEqual({ jq: { package: '@ecmaos-apps/jq', description: 'jq' } })
  }, 60_000)

  it('takes a moved program out of the boot catalog, and keeps the working copy an earlier boot wrote', async () => {
    const programEntry = { file: 'x.wasm', size: 1, sha256: 'x', version: '1', license: 'MIT', description: 'x' }
    const catalog = programCatalog([{ name: 'p', path: 'p', dir: '/nowhere', programs: { kept: programEntry }, moved: { jq: '@ecmaos-apps/jq', ghost: '@ecmaos-apps/ghost' } }])
    expect(catalog.packages[0]?.programs).not.toHaveProperty('jq')
    await fs().writeFile('/bin/jq', 'old', { mode: 0o755 })
    const stamps: Record<string, string> = { jq: 'old', 'jq:runtime': 'old' }
    const staged = await stagePrograms(fs(), {
      catalogUrl: 'http://catalog.test/programs/index.json',
      fetcher: async () => new Response(JSON.stringify(catalog)),
      stamps: { read: () => stamps, write: () => {} }
    })
    const result = await staged.start()
    expect(result.moved).toEqual({ jq: '@ecmaos-apps/jq' })
    // nothing is deleted: the copy works, it is just no longer updated, and the package replaces it when installed
    expect(await fs().readFile('/bin/jq', 'utf8')).toBe('old')
    expect(stamps).toEqual({ jq: 'old', 'jq:runtime': 'old' })
  }, 60_000)

  // @ecmaos-apps is a signed scope: a package the signed index lacks cannot be installed, so news, code and the rest must be in it
  it('signs the apps of the workspace along with the programs, groups and profiles', () => {
    const sign = process.getBuiltinModule('node:path').resolve(process.cwd(), '../../utils/apps-sign.mjs')
    const names = JSON.parse(process.getBuiltinModule('node:child_process').execFileSync('node', ['--input-type=module', '-e', `import { publishedNames } from ${JSON.stringify(sign)}; console.log(JSON.stringify(publishedNames()))`], { encoding: 'utf8' })) as string[]
    for (const app of ['news', 'code', 'webamp', 'software']) expect(names).toContain(`@ecmaos-apps/${app}`)
    expect(names).toContain('@ecmaos-apps/python3')
    expect(names).toContain('@ecmaos-apps/profile-standard')
    expect(new Set(names).size).toBe(names.length)
  })

  it('names the source package of a copyleft program, and fetches it with apt source', async () => {
    const { manifest } = await publishProgram('make')
    expect(manifest.ecmaos.source).toBe(`@ecmaos-apps/make-src@${manifest.version}`)
    await fs().mkdir('/var/lib/install', { recursive: true })
    const index = { schema: 1, common: { make: { package: '@ecmaos-apps/make', description: 'make' }, lolcat: { package: '@ecmaos-apps/lolcat', description: 'lolcat' } } }
    await fs().writeFile('/var/lib/install/package-index.json', JSON.stringify({ version: '9.9.9', index }))
    const installed = await run(`install -g @ecmaos-apps/make --registry ${registry} --ignore-signatures --allow-unsigned`)
    expect(installed.out).toContain('Corresponding source: install @ecmaos-apps/make-src')
    await fs().mkdir('/tmp/work', { recursive: true })
    const fetched = await run(`cd /tmp/work && apt source make --registry ${registry} --allow-unsigned`)
    expect(fetched.code, fetched.err).toBe(0)
    const directory = `/tmp/work/make-${manifest.version}`
    expect(await fs().exists(`${directory}/sources/make-4.4.1.tar.gz`)).toBe(true)
    expect(await fs().exists(`${directory}/build/build.sh`)).toBe(true)
    await publishProgram('lolcat')
    const none = await run(`cd /tmp/work && apt source lolcat --registry ${registry} --allow-unsigned`)
    expect(none.code).toBe(100)
    expect(none.err).toContain('Unable to find a source package for lolcat')
  }, 60_000)
})
