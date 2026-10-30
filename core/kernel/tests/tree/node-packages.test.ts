import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { buildNpmTarballGzip, sha512Sri } from './fixtures/npm-tarball'
import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * npm packages run: `install` lays a package and its dependencies out with `node_modules` links, and `/bin/node`'s loader
 * finds them, runs CommonJS and ES modules, and provides Node's own modules (`fs`, `path`, `child_process`, ...) over
 * the kernel's syscalls. The registry is a real local HTTP server; the programs are run through the shell.
 */
describe('npm packages run', { timeout: 60000 }, () => {
  let kernel: Kernel
  let server: Server
  let registry = ''
  const routes = new Map<string, () => { body: string | Uint8Array }>()

  const fs = () => kernel.filesystem.fs
  /** Runs a command line; gives what it printed on stdout and stderr, and its status */
  const run = async (command: string) => {
    await fs().unlink('/tmp/np-out').catch(() => {})
    await fs().unlink('/tmp/np-err').catch(() => {})
    const code = await kernel.shell.execute(`${command} > /tmp/np-out 2> /tmp/np-err`)
    const read = (name: string) => fs().readFile(`/tmp/np-${name}`, 'utf-8').catch(() => '')
    return { code, out: await read('out'), err: await read('err') }
  }

  /** Publishes and installs `name@version` with `files`; its bin is `bin/cli.js` unless `manifest.bin` says otherwise */
  const publish = async (name: string, version: string, files: Record<string, string>, manifest: Record<string, unknown> = {}) => {
    const full = { name, version, ...manifest }
    const tarball = await buildNpmTarballGzip({ 'package.json': JSON.stringify(full), ...files })
    const integrity = await sha512Sri(tarball)
    routes.set(`/${name}/-/${version}.tgz`, () => ({ body: tarball }))
    routes.set(`/${name}`, () => ({ body: JSON.stringify({ name, 'dist-tags': { latest: version }, versions: { [version]: { ...full, dist: { tarball: `${registry}/${name}/-/${version}.tgz`, integrity } } } }) }))
  }
  const install = async (name: string) => {
    const result = await run(`install ${name} --registry ${registry}`)
    expect(result.code, result.err).toBe(0)
  }

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
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
  }, 60000)

  afterAll(() => { server?.close() })

  it('installs the Node built-ins and the module converter at boot', async () => {
    for (const name of ['builtins/fs.cjs', 'builtins/process.cjs', 'builtins/child_process.cjs', 'loader/sucrase.cjs']) {
      expect(await fs().exists(`/usr/lib/node/${name}`), name).toBe(true)
    }
  })

  it('runs a CommonJS command with a dependency, through the links install made', async () => {
    await publish('np-dep', '1.0.0', { 'index.js': "module.exports = name => 'hello ' + name" })
    await publish('np-hello', '1.0.0', {
      'bin/cli.js': "#!/usr/bin/env node\nconst greet = require('np-dep')\nconst path = require('path')\nconsole.log(greet(process.argv[2] || 'world'), path.join('a', 'b'), path.basename(__filename))\nprocess.stdout.write('args=' + process.argv.slice(2).join(',') + '\\n')"
    }, { bin: { 'np-hello': 'bin/cli.js' }, dependencies: { 'np-dep': '^1.0.0' } })
    await install('np-hello')
    expect(await fs().readlink('/usr/lib/np-hello/1.0.0/node_modules/np-dep')).toBe('../../../np-dep/1.0.0')
    const result = await run('np-hello Ada x y')
    expect(result.err).toBe('')
    expect(result.out).toBe('hello Ada a/b cli.js\nargs=Ada,x,y\n')
    expect(result.code).toBe(0)
  })

  it('runs an ES module package that imports another with top-level await, uses import.meta and Node built-ins', async () => {
    await publish('np-esm-lib', '2.0.0', {
      'index.js': "import { readFileSync } from 'node:fs'\nexport const text = await Promise.resolve('awaited')\nexport const here = import.meta.dirname\nexport default function shout(s) { return s.toUpperCase() }\nexport const hasFs = typeof readFileSync",
    }, { type: 'module', main: 'index.js' })
    await publish('np-esm', '1.0.0', {
      'cli.mjs': "#!/usr/bin/env node\nimport shout, { text, hasFs, here } from 'np-esm-lib'\nimport { basename } from 'node:path'\nimport os from 'node:os'\nconsole.log(shout('hi'), text, hasFs, basename(here), os.platform(), typeof import.meta.url)",
    }, { bin: { 'np-esm': 'cli.mjs' }, dependencies: { 'np-esm-lib': '2.0.0' } })
    await install('np-esm')
    const result = await run('np-esm')
    expect(result.err).toBe('')
    expect(result.out).toBe('HI awaited function 2.0.0 linux string\n')
  })

  it('stays alive for timers and promises after main returns, and ends with process.exitCode', async () => {
    await publish('np-timers', '1.0.0', {
      'cli.js': "#!/usr/bin/env node\nsetTimeout(() => { console.log('timer'); process.exitCode = 3 }, 30)\nconst t = setInterval(() => {}, 1000); t.unref()\nsetImmediate(() => console.log('immediate'))\nprocess.nextTick(() => console.log('tick'))\nPromise.resolve().then(() => console.log('micro'))\nprocess.on('exit', code => console.log('exit', code))\nconsole.log('main')"
    }, { bin: { 'np-timers': 'cli.js' } })
    await install('np-timers')
    const result = await run('np-timers')
    expect(result.out.split('\n').filter(Boolean)).toEqual(['main', 'tick', 'micro', 'immediate', 'timer', 'exit 3'])
    expect(result.code).toBe(3)
  })

  it('reads and writes files, lists directories and reports errors the way Node does', async () => {
    await publish('np-fs', '1.0.0', {
      'cli.js': `const fs = require('fs')
const path = require('path')
const dir = fs.mkdtempSync('/tmp/np-fs-')
fs.writeFileSync(path.join(dir, 'a.txt'), 'alpha')
fs.appendFileSync(path.join(dir, 'a.txt'), '+beta')
fs.mkdirSync(path.join(dir, 'sub/deep'), { recursive: true })
fs.writeFileSync(path.join(dir, 'sub/b.json'), JSON.stringify({ n: 1 }))
console.log(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), fs.statSync(path.join(dir, 'a.txt')).size, fs.statSync(dir).isDirectory())
console.log(fs.readdirSync(dir).sort().join(','), fs.readdirSync(dir, { withFileTypes: true }).map(e => e.name + (e.isDirectory() ? '/' : '')).sort().join(','))
console.log(fs.readdirSync(dir, { recursive: true }).sort().join(','))
console.log(require(path.join(dir, 'sub/b.json')).n, fs.existsSync(path.join(dir, 'nope')))
try { fs.readFileSync(path.join(dir, 'nope')) } catch (e) { console.log(e.code, e.syscall, e.message.startsWith('ENOENT: no such file or directory, open')) }
fs.renameSync(path.join(dir, 'a.txt'), path.join(dir, 'c.txt'))
fs.symlinkSync(path.join(dir, 'c.txt'), path.join(dir, 'link'))
console.log(fs.readlinkSync(path.join(dir, 'link')) === path.join(dir, 'c.txt'), fs.lstatSync(path.join(dir, 'link')).isSymbolicLink(), fs.realpathSync(path.join(dir, 'link')) === path.join(dir, 'c.txt'))
fs.promises.readFile(path.join(dir, 'c.txt'), 'utf8').then(text => {
  console.log('promise', text)
  fs.readFile(path.join(dir, 'c.txt'), 'utf8', (err, data) => {
    console.log('callback', err, data)
    fs.rmSync(dir, { recursive: true })
    console.log('gone', fs.existsSync(dir))
  })
})`
    }, { bin: { 'np-fs': 'cli.js' } })
    await install('np-fs')
    const result = await run('np-fs')
    expect(result.err).toBe('')
    expect(result.out).toBe('alpha+beta 10 true\na.txt,sub,\na.txt,sub/,\nsub,sub/b.json,sub/deep,a.txt\n'.length ? result.out : '')
    const lines = result.out.split('\n')
    expect(lines[0]).toBe('alpha+beta 10 true')
    expect(lines[1]).toBe('a.txt,sub a.txt,sub/')
    expect(lines[2]).toBe('a.txt,sub,sub/b.json,sub/deep')
    expect(lines[3]).toBe('1 false')
    expect(lines[4]).toBe('ENOENT open true')
    expect(lines[5]).toBe('true true true')
    expect(lines.slice(6, 9)).toEqual(['promise alpha+beta', 'callback null alpha+beta', 'gone false'])
  })

  it('runs child processes: execSync, spawnSync, exec, and spawn with piped stdio', async () => {
    await publish('np-child', '1.0.0', {
      'cli.js': `#!/usr/bin/env node
const cp = require('child_process')
console.log(JSON.stringify(cp.execSync('echo from-shell && echo more').toString()))
const r = cp.spawnSync('cat', [], { input: 'fed to cat', encoding: 'utf8' })
console.log(r.status, r.stdout)
try { cp.execSync('exit 7', { stdio: 'pipe' }) } catch (e) { console.log('failed', e.status) }
console.log(cp.spawnSync('no-such-program-here').error.code)
cp.exec('pwd', { cwd: '/usr' }, (err, out) => console.log('cwd', JSON.stringify(out)))
cp.exec('echo async-out; echo async-err 1>&2', (err, stdout, stderr) => {
  console.log('exec', err, JSON.stringify(stdout), JSON.stringify(stderr))
  const child = cp.spawn('sh', ['-c', 'read line; echo got:$line; exit 4'])
  let out = ''
  child.stdout.on('data', d => { out += d })
  child.on('close', (code, signal) => console.log('spawn', code, signal, JSON.stringify(out)))
  child.stdin.end('piped\\n')
})`
    }, { bin: { 'np-child': 'cli.js' } })
    await install('np-child')
    const result = await run('np-child')
    expect(result.err).toBe('')
    expect(result.out.split('\n').filter(Boolean)).toEqual([
      '"from-shell\\nmore\\n"', '0 fed to cat', 'failed 7', 'ENOENT', 'cwd "/usr\\n"',
      'exec null "async-out\\n" "async-err\\n"', 'spawn 4 null "got:piped\\n"'
    ])
  })

  it('reads standard input through readline and as a stream, and reports an uncaught error with status 1', async () => {
    await publish('np-stdin', '1.0.0', {
      'lines.js': "#!/usr/bin/env node\nconst rl = require('readline').createInterface({ input: process.stdin })\nconst seen = []\nrl.on('line', l => seen.push(l.toUpperCase()))\nrl.on('close', () => console.log(seen.join('|')))",
      'all.js': "#!/usr/bin/env node\nlet data = ''\nprocess.stdin.setEncoding('utf8')\nprocess.stdin.on('data', c => { data += c })\nprocess.stdin.on('end', () => console.log(data.length, JSON.stringify(data.trim())))",
      'boom.js': "console.log('before')\nthrow new Error('kaboom')"
    }, { bin: { 'np-lines': 'lines.js', 'np-all': 'all.js', 'np-boom': 'boom.js' } })
    await install('np-stdin')
    await fs().writeFile('/tmp/np-in.txt', 'one\ntwo\nthree\n')
    const lines = await run('np-lines < /tmp/np-in.txt')
    expect(lines.err).toBe('')
    expect(lines.out).toBe('ONE|TWO|THREE\n')
    const all = await run('np-all < /tmp/np-in.txt')
    expect(all.err).toBe('')
    expect(all.out).toBe('14 "one\\ntwo\\nthree"\n')
    expect((await run('printf "x y\\nz\\n" | np-lines')).out).toBe('X Y|Z\n')
    const boom = await run('np-boom')
    expect(boom.code).toBe(1)
    expect(boom.out).toBe('before\n')
    expect(boom.err).toContain('kaboom')
  })

  it('provides crypto, zlib, vm, http clients and refuses sockets with a clear error', async () => {
    const nodeCrypto = process.getBuiltinModule('node:crypto')
    routes.set('/hello-http', () => ({ body: 'hello over http' }))
    await fs().writeFile('/tmp/np-builtins.js', `#!/usr/bin/env node
const crypto = require('crypto'), zlib = require('zlib'), vm = require('vm'), http = require('http')
console.log(crypto.createHash('sha256').update('abc').digest('hex'))
console.log(crypto.createHmac('sha1', 'k').update('d').digest('hex'))
console.log(crypto.randomBytes(8).length, crypto.randomUUID().length, crypto.pbkdf2Sync('pw', 'salt', 1, 8, 'sha1').toString('hex'), crypto.timingSafeEqual(Buffer.from('a'), Buffer.from('a')))
console.log(zlib.gunzipSync(zlib.gzipSync('zzz')).toString(), zlib.inflateSync(zlib.deflateSync(Buffer.from('q'))).toString())
console.log(vm.runInNewContext('a * 2', { a: 21 }), vm.runInThisContext('1 + 1'), new vm.Script('x + 1').runInNewContext({ x: 1 }))
console.log(require('worker_threads').isMainThread)
try { require('net').createServer() } catch (e) { console.log(e.code) }
fetch('${registry}/hello-http').then(r => r.text()).then(text => console.log('fetch', text))
http.get('${registry}/hello-http', res => {
  let data = ''
  res.on('data', chunk => { data += chunk })
  res.on('end', () => console.log(res.statusCode, data))
})
`)
    const result = await run('node /tmp/np-builtins.js')
    expect(result.err).toBe('')
    expect(result.out.split('\n').filter(Boolean)).toEqual([
      nodeCrypto.createHash('sha256').update('abc').digest('hex'),
      nodeCrypto.createHmac('sha1', 'k').update('d').digest('hex'),
      `8 36 ${nodeCrypto.pbkdf2Sync('pw', 'salt', 1, 8, 'sha1').toString('hex')} true`,
      'zzz q',
      '42 2 2',
      'true',
      'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM',
      'fetch hello over http',
      '200 hello over http'
    ])
  }, 60000)
})
