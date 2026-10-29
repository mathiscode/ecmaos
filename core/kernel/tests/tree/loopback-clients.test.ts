import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { PROGRAMS_COREUTILS, TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** curl, wget and nc reach a server running on this machine over loopback, as they would on Linux */
describe('HTTP clients on loopback', () => {
  let kernel: Kernel
  const fs = () => kernel.filesystem.fs
  const read = (path: string) => fs().readFile(path, 'utf-8').catch(() => '')
  const run = async (command: string) => {
    const code = await kernel.shell.execute(`${command} > /tmp/out 2> /tmp/err < /dev/null`)
    return { code, out: await read('/tmp/out'), err: await read('/tmp/err') }
  }

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions, programs: PROGRAMS_COREUTILS })
    await kernel.boot()
    await kernel.whenProgramsReady()
    await fs().mkdir('/srv/www/sub', { recursive: true })
    await fs().writeFile('/srv/www/index.html', '<h1>hello from ecmaOS</h1>\n')
    await fs().writeFile('/srv/www/sub/index.html', 'in sub\n')
    // CPython's own server, the way a person would start it (-u so its log line is not held back)
    await kernel.shell.execute('cd /srv/www && python3 -u -m http.server 8000 > /tmp/httpd.log 2>&1 &')
    for (let i = 0; i < 60 && !(await read('/tmp/httpd.log')).includes('Serving HTTP'); i++) await new Promise(resolve => setTimeout(resolve, 500))
  }, 90_000)

  afterAll(async () => { await kernel.shell.execute('pkill -f http.server') })

  it('curl fetches a page, shows headers with -i and -I, and follows a redirect only with -L', async () => {
    // the server's log says why, should it not have started
    const log = await read('/tmp/httpd.log')
    expect(log, log).toContain('Serving HTTP on 0.0.0.0 port 8000')
    const page = await run('curl -sS http://localhost:8000/')
    expect(page.code).toBe(0)
    expect(page.out).toBe('<h1>hello from ecmaOS</h1>\n')
    const included = await run('curl -si http://127.0.0.1:8000/')
    expect(included.out).toMatch(/^HTTP\/1\.1 200 OK\r\n/)
    expect(included.out).toMatch(/content-type: text\/html/i)
    expect(included.out.endsWith('\r\n\r\n<h1>hello from ecmaOS</h1>\n')).toBe(true)
    const head = await run('curl -sI http://localhost:8000/')
    expect(head.out).toMatch(/^HTTP\/1\.1 200 OK\r\n/)
    expect(head.out).not.toContain('hello')
    // the server answers /sub with a redirect to /sub/
    expect((await run('curl -si http://localhost:8000/sub')).out).toMatch(/^HTTP\/1\.1 301 /)
    expect((await run('curl -sL http://localhost:8000/sub')).out).toBe('in sub\n')
  }, 60_000)

  it('curl -f fails on an error status, and a port nobody listens on is refused', async () => {
    const missing = await run('curl -sS http://localhost:8000/nothing')
    expect(missing.code).toBe(0)
    expect(missing.out).toContain('404')
    const failed = await run('curl -fsS http://localhost:8000/nothing')
    expect(failed.code).toBe(22)
    expect(failed.err).toContain('The requested URL returned error: 404')
    const refused = await run('curl -sS http://localhost:8999/')
    expect(refused.code).toBe(7)
    expect(refused.err).toMatch(/ECONNREFUSED|refused/i)
  }, 60_000)

  it('wget downloads from it', async () => {
    const got = await run('wget -q -O - http://localhost:8000/sub/')
    expect(got.code).toBe(0)
    expect(got.out).toBe('in sub\n')
  }, 60_000)

  it('nc talks plain TCP to it', async () => {
    // the request comes down the pipe, so this one is not given /dev/null
    const code = await kernel.shell.execute("printf 'GET / HTTP/1.0\\r\\n\\r\\n' | nc localhost 8000 > /tmp/out 2> /tmp/err")
    const answer = { code, out: await read('/tmp/out') }
    expect(answer.code).toBe(0)
    expect(answer.out).toMatch(/^HTTP\/1\.0 200 OK\r\n/)
    expect(answer.out).toContain('hello from ecmaOS')
    const refused = await run('nc 127.0.0.1 8999')
    expect(refused.code).toBe(1)
    expect(refused.err).toContain('connect to 127.0.0.1 port 8999 (tcp) failed: Connection refused')
  }, 60_000)
})
