import type { IncomingMessage, Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { crc32 } from '../../src/bin/commands/lib/pip/zip.mjs'
import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

const encoder = new TextEncoder()

/** A wheel: a zip of `files` (name to text), the first `deflated` of them compressed */
async function buildZip(files: Record<string, string | Uint8Array>, deflated: string[] = []): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const data = typeof content === 'string' ? encoder.encode(content) : content
    const compress = deflated.includes(name)
    const body = compress ? new Uint8Array(process.getBuiltinModule('node:zlib').deflateRawSync(data)) : data
    const nameBytes = encoder.encode(name)
    const crc = crc32(data)
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(8, compress ? 8 : 0, true)
    local.setUint32(14, crc, true); local.setUint32(18, body.length, true); local.setUint32(22, data.length, true); local.setUint16(26, nameBytes.length, true)
    const entry = new DataView(new ArrayBuffer(46))
    entry.setUint32(0, 0x02014b50, true); entry.setUint16(4, 0x031e, true); entry.setUint16(6, 20, true); entry.setUint16(10, compress ? 8 : 0, true)
    entry.setUint32(16, crc, true); entry.setUint32(20, body.length, true); entry.setUint32(24, data.length, true); entry.setUint16(28, nameBytes.length, true)
    entry.setUint32(38, ((name.includes('.data/scripts/') ? 0o100755 : 0o100644) << 16) >>> 0, true); entry.setUint32(42, offset, true)
    parts.push(new Uint8Array(local.buffer), nameBytes, body)
    central.push(new Uint8Array(entry.buffer), nameBytes)
    offset += 30 + nameBytes.length + body.length
  }
  const directory = central.reduce((sum, chunk) => sum + chunk.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, Object.keys(files).length, true); end.setUint16(10, Object.keys(files).length, true)
  end.setUint32(12, directory, true); end.setUint32(16, offset, true)
  const all = [...parts, ...central, new Uint8Array(end.buffer)]
  const bytes = new Uint8Array(all.reduce((sum, chunk) => sum + chunk.length, 0))
  let at = 0
  for (const chunk of all) { bytes.set(chunk, at); at += chunk.length }
  return bytes
}

const sha256 = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('')

/**
 * `pip`: PyPI's JSON API, served by a local HTTP server, and wheels built here. It installs into CPython's site-packages
 * (the dist-info records are Python's own convention), follows `Requires-Dist` with markers, picks the right release, and
 * refuses what cannot run.
 */
describe('pip', () => {
  let kernel: Kernel
  let server: Server
  let base = ''
  const bodies = new Map<string, Uint8Array | string>()
  const requests: IncomingMessage[] = []
  const projects = new Map<string, { info: Record<string, unknown>, releases: Record<string, Record<string, unknown>[]> }>()

  const fs = () => kernel.filesystem.fs
  const run = async (command: string, input = '') => {
    await fs().unlink('/tmp/pip-out').catch(() => {})
    await fs().unlink('/tmp/pip-err').catch(() => {})
    await fs().writeFile('/tmp/pip-in', input)
    const code = await kernel.shell.execute(`${command} < /tmp/pip-in > /tmp/pip-out 2> /tmp/pip-err`)
    const read = (name: string) => fs().readFile(`/tmp/pip-${name}`, 'utf-8').catch(() => '')
    return { code, out: await read('out'), err: await read('err') }
  }
  const pip = (args: string) => run(`pip ${args} --index-url ${base}`)

  /** Publishes a wheel of `name` at `version`; `requires` are its Requires-Dist lines */
  const publish = async (name: string, version: string, options: { requires?: string[], files?: Record<string, string>, tag?: string, requiresPython?: string, yanked?: boolean, scripts?: string, deflated?: string[], digest?: string, kind?: 'wheel' | 'sdist' } = {}) => {
    const tag = options.tag ?? 'py3-none-any'
    const stem = `${name.replace(/-/g, '_')}-${version}`
    const info = `${stem}.dist-info`
    const files: Record<string, string> = {
      [`${name.replace(/-/g, '_')}/__init__.py`]: `VERSION = '${version}'\n`,
      ...options.files,
      [`${info}/METADATA`]: `Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\nSummary: the ${name} project\nHome-page: https://example.com/${name}\nAuthor: someone\nLicense: MIT\n${(options.requires ?? []).map(requirement => `Requires-Dist: ${requirement}`).join('\n')}\n\nDescription\n`,
      [`${info}/WHEEL`]: `Wheel-Version: 1.0\nGenerator: test\nRoot-Is-Purelib: true\nTag: ${tag}\n`,
      ...(options.scripts ? { [`${info}/entry_points.txt`]: options.scripts } : {})
    }
    const filename = options.kind === 'sdist' ? `${stem}.tar.gz` : `${stem}-${tag}.whl`
    const bytes = await buildZip(files, options.deflated)
    bodies.set(`/files/${filename}`, bytes)
    const project = projects.get(name) ?? { info: {}, releases: {} }
    project.releases[version] = [...(project.releases[version] ?? []), {
      filename, url: `${base}/files/${filename}`, packagetype: options.kind === 'sdist' ? 'sdist' : 'bdist_wheel', yanked: options.yanked ?? false,
      requires_python: options.requiresPython ?? null, digests: { sha256: options.digest ?? await sha256(bytes) }, size: bytes.length
    }]
    projects.set(name, project)
    const releases = Object.keys(project.releases)
    project.info = { name, version: releases.sort().pop(), summary: `the ${name} project`, requires_dist: options.requires ?? null }
    // the document of a single release answers with that release's metadata
    bodies.set(`/pypi/${name}/${version}/json`, JSON.stringify({ info: { name, version, requires_dist: options.requires ?? null }, urls: project.releases[version] }))
    bodies.set(`/pypi/${name}/json`, '')
  }
  const jsonOf = (name: string) => JSON.stringify({ info: projects.get(name)!.info, releases: projects.get(name)!.releases })

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
    // pip is a package, not a kernel command: build it as the registry gets it and link it as an install does
    const { mkdtempSync, readFileSync, rmSync } = process.getBuiltinModule('node:fs')
    const { join, resolve } = process.getBuiltinModule('node:path')
    const { tmpdir } = process.getBuiltinModule('node:os')
    const { execFileSync } = process.getBuiltinModule('node:child_process')
    const out = mkdtempSync(join(tmpdir(), 'pip-'))
    execFileSync('node', [resolve(process.cwd(), '../../utils/apps-packages.mjs'), 'build', out, 'pip'])
    const code = readFileSync(join(out, 'pip', 'pip.mjs'), 'utf8')
    rmSync(out, { recursive: true, force: true })
    await fs().mkdir('/usr/lib/pip', { recursive: true })
    await fs().writeFile('/usr/lib/pip/pip.mjs', code, { mode: 0o755 })
    for (const name of ['pip', 'pip3']) await fs().symlink('/usr/lib/pip/pip.mjs', `/usr/bin/${name}`)
    const { createServer } = process.getBuiltinModule('node:http')
    server = createServer((req, res) => {
      requests.push(req)
      const match = /^\/pypi\/([^/]+)\/json$/.exec(req.url ?? '')
      if (match && projects.has(match[1]!)) { res.setHeader('content-type', 'application/json'); res.end(jsonOf(match[1]!)); return }
      const body = bodies.get(req.url ?? '')
      if (body === undefined) { res.statusCode = 404; res.end('not found'); return }
      res.end(body)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
  }, 60000)

  afterAll(() => { server?.close() })

  const site = '/usr/lib/python3.14/site-packages'

  it('installs a wheel and what it needs for this machine, writes the dist-info records, and lists and shows it', async () => {
    await publish('pp-lib', '1.2.0', { files: { 'pp_lib/data.txt': 'data\n' }, deflated: ['pp_lib/data.txt', 'pp_lib/__init__.py'] })
    await publish('pp-extra', '1.0.0')
    await publish('pp-app', '2.0.0', {
      requires: ['pp-lib>=1.0', 'pp-win; sys_platform == "win32"', 'pp-old; python_version < "3.0"', 'pp-extra; extra == "more"', 'pp-new; python_version >= "3.8" and sys_platform == "linux"'],
      scripts: '[console_scripts]\npp-app = pp_app:main\n',
      files: { 'pp_app/__init__.py': 'def main():\n    print("pp-app")\n' }
    })
    await publish('pp-new', '0.5.0')
    const result = await pip('install pp-app')
    expect(result.code, result.err).toBe(0)
    expect(result.out).toContain('Collecting pp-app')
    expect(result.out).toContain('Downloading pp_app-2.0.0-py3-none-any.whl')
    expect(result.out).toMatch(/Installing collected packages: pp-lib, pp-new, pp-app|Installing collected packages: pp-new, pp-lib, pp-app/)
    expect(result.out).toMatch(/Successfully installed pp-app-2\.0\.0 .*pp-lib-1\.2\.0|Successfully installed pp-lib-1\.2\.0.*pp-app-2\.0\.0/)
    // the markers kept the Windows, old-Python and extra requirements out
    expect(await fs().exists(`${site}/pp_win`)).toBe(false)
    expect(await fs().exists(`${site}/pp_extra`)).toBe(false)
    expect(await fs().exists(`${site}/pp_new/__init__.py`)).toBe(true)

    // the files, the compressed ones inflated and checked
    expect(await fs().readFile(`${site}/pp_lib/data.txt`, 'utf-8')).toBe('data\n')
    expect(await fs().readFile(`${site}/pp_lib/__init__.py`, 'utf-8')).toBe("VERSION = '1.2.0'\n")
    // the console script
    const script = await fs().readFile('/usr/bin/pp-app', 'utf-8')
    expect(script.startsWith('#!/usr/bin/env python3\n')).toBe(true)
    expect(script).toContain('from pp_app import main')
    expect(script).toContain('sys.exit(main())')
    expect((await fs().stat('/usr/bin/pp-app')).mode & 0o111).not.toBe(0)
    // dist-info
    const info = `${site}/pp_app-2.0.0.dist-info`
    expect(await fs().readFile(`${info}/INSTALLER`, 'utf-8')).toBe('pip\n')
    expect(await fs().exists(`${info}/REQUESTED`)).toBe(true)
    expect(await fs().exists(`${site}/pp_lib-1.2.0.dist-info/REQUESTED`)).toBe(false)
    const record = await fs().readFile(`${info}/RECORD`, 'utf-8')
    expect(record).toContain('pp_app/__init__.py,sha256=')
    expect(record).toContain('../../../bin/pp-app,sha256=')
    expect(record).toContain('pp_app-2.0.0.dist-info/RECORD,,')
    // a recorded hash is the file's
    const line = record.split('\n').find(entry => entry.startsWith('pp_app/__init__.py,'))!
    const digest = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', await fs().readFile(`${site}/pp_app/__init__.py`))))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(line.split(',')[1]).toBe(`sha256=${digest}`)

    let listed = await pip('list')
    expect(listed.out).toMatch(/Package\s+Version\n-+\s+-+\npp-app\s+2\.0\.0\npp-lib\s+1\.2\.0\npp-new\s+0\.5\.0/)
    listed = await pip('freeze')
    expect(listed.out).toContain('pp-app==2.0.0\n')
    expect(JSON.parse((await pip('list --format=json')).out)).toContainEqual({ name: 'pp-app', version: '2.0.0' })
    const shown = await pip('show pp-lib pp-app')
    expect(shown.out).toContain('Name: pp-lib\nVersion: 1.2.0\nSummary: the pp-lib project')
    expect(shown.out).toMatch(/Name: pp-lib[\s\S]*Required-by: pp-app/)
    expect(shown.out).toMatch(/Name: pp-app[\s\S]*Requires: pp-lib, pp-new/)
    expect((await pip('check')).out).toContain('No broken requirements found.')
  })

  it('knows what is installed already, and installs a version again only when asked', async () => {
    let result = await pip('install pp-lib')
    expect(result.code, result.err).toBe(0)
    expect(result.out).toContain(`Requirement already satisfied: pp-lib in ${site} (1.2.0)`)
    await publish('pp-lib', '1.3.0')
    result = await pip("install 'pp-lib>=1.0'")
    expect(result.out).toContain('Requirement already satisfied')
    result = await pip('install --upgrade pp-lib')
    expect(result.code, result.err).toBe(0)
    expect(result.out).toContain('Found existing installation: pp-lib 1.2.0')
    expect(result.out).toContain('Successfully installed pp-lib-1.3.0')
    expect(await fs().exists(`${site}/pp_lib-1.2.0.dist-info`)).toBe(false)
    expect(await fs().exists(`${site}/pp_lib/data.txt`)).toBe(false)
    result = await pip('install pp-lib==1.2.0')
    expect(result.code, result.err).toBe(0)
    expect(result.out).toContain('Successfully installed pp-lib-1.2.0')
    expect((await pip('freeze')).out).toContain('pp-lib==1.2.0')
  })

  it('picks the highest release that fits, passing over yanked, pre-release and incompatible ones', async () => {
    await publish('pp-pick', '1.0.0')
    await publish('pp-pick', '1.5.0')
    await publish('pp-pick', '2.0.0')
    await publish('pp-pick', '2.1.0', { yanked: true })
    await publish('pp-pick', '3.0.0a1')
    await publish('pp-pick', '4.0.0', { requiresPython: '>=3.99' })
    await publish('pp-pick', '5.0.0', { tag: 'cp314-cp314-linux_x86_64' })
    let result = await pip('install pp-pick')
    expect(result.out).toContain('Successfully installed pp-pick-2.0.0')
    await run('pip uninstall -y pp-pick')
    result = await pip("install 'pp-pick<2'")
    expect(result.out).toContain('Successfully installed pp-pick-1.5.0')
    await run('pip uninstall -y pp-pick')
    result = await pip('install --pre pp-pick')
    expect(result.out).toContain('Successfully installed pp-pick-3.0.0a1')
    await run('pip uninstall -y pp-pick')
    result = await pip("install 'pp-pick==9'")
    expect(result.code).toBe(1)
    expect(result.err).toContain('Could not find a version that satisfies the requirement pp-pick==9 (from versions: 1.0.0, 1.5.0, 2.0.0, 2.1.0, 3.0.0a1, 4.0.0, 5.0.0)')
    expect(result.err).toContain('No matching distribution found')
  })

  it('refuses a project that only has native wheels or source distributions, and says why', async () => {
    await publish('pp-native', '1.0.0', { tag: 'cp314-cp314-manylinux_2_17_x86_64' })
    let result = await pip('install pp-native')
    expect(result.code).toBe(1)
    expect(result.err).toContain('native wheels, which cannot run on ecmaOS')
    await publish('pp-source', '1.0.0', { kind: 'sdist' })
    result = await pip('install pp-source')
    expect(result.code).toBe(1)
    expect(result.err).toContain('source distributions, which are not built here')
    expect(await fs().exists(`${site}/pp_native`)).toBe(false)
    result = await pip('install ./pkg-1.0.tar.gz')
    expect(result.err).toContain('only wheels can be installed on ecmaOS')
    expect((await pip('install pp-nowhere')).err).toContain('no such project')
  })

  it('refuses a wheel whose SHA-256 is not the one the index published', async () => {
    await publish('pp-bad', '1.0.0', { digest: '0'.repeat(64) })
    const result = await pip('install pp-bad')
    expect(result.code).toBe(1)
    expect(result.err).toContain('the SHA-256 does not match')
    expect(await fs().exists(`${site}/pp_bad`)).toBe(false)
  })

  it('puts a wheel\'s scripts and data where pip does, and fixes the shebang', async () => {
    const stem = 'pp_data-1.0.0'
    const wheel = await buildZip({
      'pp_data/__init__.py': '',
      [`${stem}.data/scripts/pp-tool`]: '#!python\nprint("tool")\n',
      [`${stem}.data/purelib/pp_extra_mod.py`]: 'X = 1\n',
      [`${stem}.data/data/share/pp-data/hello.txt`]: 'hello\n',
      [`${stem}.dist-info/METADATA`]: 'Metadata-Version: 2.1\nName: pp-data\nVersion: 1.0.0\n\n',
      [`${stem}.dist-info/WHEEL`]: 'Wheel-Version: 1.0\n'
    })
    await fs().writeFile('/tmp/pp_data-1.0.0-py3-none-any.whl', wheel)
    const result = await run('pip install /tmp/pp_data-1.0.0-py3-none-any.whl')
    expect(result.code, result.err).toBe(0)
    expect(await fs().readFile('/usr/bin/pp-tool', 'utf-8')).toBe('#!/usr/bin/env python3\nprint("tool")\n')
    expect((await fs().stat('/usr/bin/pp-tool')).mode & 0o111).not.toBe(0)
    expect(await fs().exists(`${site}/pp_extra_mod.py`)).toBe(true)
    expect(await fs().readFile('/usr/share/pp-data/hello.txt', 'utf-8')).toBe('hello\n')
    const removed = await run('pip uninstall -y pp-data')
    expect(removed.code, removed.err).toBe(0)
    expect(removed.out).toContain('Successfully uninstalled pp-data-1.0.0')
    expect(await fs().exists('/usr/bin/pp-tool')).toBe(false)
    expect(await fs().exists(`${site}/pp_data`)).toBe(false)
    expect(await fs().exists(`${site}/pp_extra_mod.py`)).toBe(false)
  })

  it('uninstalls what the RECORD lists, the compiled bytecode too, and asks first', async () => {
    await fs().mkdir(`${site}/pp_app/__pycache__`, { recursive: true })
    await fs().writeFile(`${site}/pp_app/__pycache__/__init__.cpython-314.pyc`, 'x')
    let result = await run('pip uninstall pp-app', 'n\n')
    expect(result.out).toContain('Found existing installation: pp-app 2.0.0')
    expect(result.out).toContain('Proceed (Y/n)?')
    expect(await fs().exists(`${site}/pp_app`)).toBe(true)
    result = await run('pip uninstall -y pp-app pp-missing')
    expect(result.code, result.err).toBe(0)
    expect(result.out).toContain('Successfully uninstalled pp-app-2.0.0')
    expect(result.err).toContain('WARNING: Skipping pp-missing as it is not installed.')
    expect(await fs().exists(`${site}/pp_app`)).toBe(false)
    expect(await fs().exists('/usr/bin/pp-app')).toBe(false)
    expect(await fs().exists(`${site}/pp_app-2.0.0.dist-info`)).toBe(false)
    // pp-lib and pp-new stay: pip does not remove dependencies
    expect(await fs().exists(`${site}/pp_new`)).toBe(true)
    expect((await pip('check')).out).toContain('No broken requirements found.')
  })

  it('reports a broken requirement, versions of a project, and what pip does not do', async () => {
    await publish('pp-needs', '1.0.0', { requires: ['pp-lib>=5'] })
    expect((await pip('install --no-deps pp-needs')).code).toBe(0)
    const checked = await pip('check')
    expect(checked.code).toBe(1)
    expect(checked.out).toContain('pp-needs 1.0.0 has requirement pp-lib>=5, but you have pp-lib 1.2.0.')
    const versions = await pip('index versions pp-pick')
    expect(versions.out).toContain('pp-pick (5.0.0)')
    expect(versions.out).toContain('Available versions: 5.0.0, 4.0.0, 3.0.0a1, 2.1.0, 2.0.0, 1.5.0, 1.0.0')
    expect((await pip('search anything')).err).toContain("PyPI no longer supports 'pip search'")
    expect((await run('pip --version')).out).toMatch(/^pip \d+\.\d+ from \/usr\/lib\/python3\.14\/site-packages\/pip \(python 3\.14\)/)
    expect((await run('pip frobnicate')).err).toContain('unknown command "frobnicate"')
    expect((await run('pip install')).err).toContain('You must give at least one requirement')
  })

  it('installs for the user with --user, into the user site', async () => {
    await publish('pp-user', '1.0.0', { scripts: '[console_scripts]\npp-user = pp_user:main\n' })
    const result = await pip('install --user pp-user')
    expect(result.code, result.err).toBe(0)
    const home = (await fs().readFile('/etc/passwd', 'utf-8')).split('\n').find(line => line.startsWith('root:'))?.split(':')[5] ?? '/root'
    expect(await fs().exists(`${home}/.local/lib/python3.14/site-packages/pp_user/__init__.py`)).toBe(true)
    expect(await fs().exists(`${home}/.local/bin/pp-user`)).toBe(true)
    expect((await pip('list')).out).toContain('pp-user')
    expect((await run('pip uninstall -y pp-user')).code).toBe(0)
    expect(await fs().exists(`${home}/.local/lib/python3.14/site-packages/pp_user`)).toBe(false)
  })
})
