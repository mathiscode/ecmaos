import type { Server } from 'node:https'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Connection, memoryPair, NetChannel } from '@ecmaos/peer'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { adoptGatewayLink } from '#lib/remote-gateway.ts'

import { PROGRAMS_ALL, TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/**
 * Python's urllib fetching an https:// URL by name: the name is resolved by the kernel's nameserver on loopback port 53
 * through the gateway, the connection goes through it too, and the certificate is checked against the CA bundle. The
 * machine at the other end of the gateway is played here: it resolves `example.test` to a documentation address and
 * "connects" to that address by opening a real TLS server on this computer's loopback.
 */
describe('python3 reaches an https:// URL through the gateway', () => {
  let kernel: Kernel
  let server: Server
  let port = 0
  let certificate = ''
  const connections: string[] = []
  const lookups: string[] = []

  beforeAll(async () => {
    // the jsdom project stubs Node's modules; the real ones are there to be asked for
    const { execFileSync } = process.getBuiltinModule('node:child_process')
    const { mkdtempSync, readFileSync } = process.getBuiltinModule('node:fs')
    const { createServer } = process.getBuiltinModule('node:https')
    const { connect } = process.getBuiltinModule('node:net')
    const { tmpdir } = process.getBuiltinModule('node:os')
    const { join } = process.getBuiltinModule('node:path')
    const directory = mkdtempSync(join(tmpdir(), 'ecmaos-https-'))
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '30',
      '-subj', '/CN=example.test', '-addext', 'subjectAltName=DNS:example.test', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')], { stdio: 'ignore' })
    certificate = readFileSync(join(directory, 'cert.pem'), 'utf8')
    server = createServer({ key: readFileSync(join(directory, 'key.pem')), cert: certificate }, (request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end(`hello from ${request.headers.host} ${request.method} ${request.url}`)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port

    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions,
      programs: PROGRAMS_ALL
    })
    await kernel.boot()

    // the gateway's host
    const [guestEnd, hostEnd] = memoryPair()
    const guest = new Connection(guestEnd, { role: 'client' })
    const host = new Connection(hostEnd, { role: 'server' })
    host.accept(NetChannel, channel => {
      const params = channel.params as { proto: string, name?: string, family?: number, host?: string, port?: number }
      if (params.proto === 'dns') {
        lookups.push(`${params.name}/${params.family ?? 4}`)
        channel.send({ op: 'resolved', addresses: params.name === 'example.test' && (params.family ?? 4) === 4 ? ['203.0.113.9'] : [] })
        return
      }
      connections.push(`${params.host}:${params.port}`)
      const socket = connect(port, '127.0.0.1')
      socket.on('connect', () => channel.send({ op: 'connected', address: String(params.host), port: Number(params.port) }))
      socket.on('data', data => { void channel.write(new Uint8Array(data)) })
      socket.on('end', () => { try { channel.send({ op: 'eof' }) } catch { /* gone */ } })
      socket.on('error', () => channel.close())
      channel.onData = data => { socket.write(data) }
      channel.onMessage = message => { if (message && typeof message === 'object' && !(message instanceof Uint8Array) && !Array.isArray(message) && message['op'] === 'eof') socket.end() }
      void channel.done.then(() => socket.destroy())
    })
    adoptGatewayLink(kernel, guest, 'test-gateway:1', 'root')

    await kernel.filesystem.fs.writeFile('/tmp/ca.pem', certificate)
    // the program and its library are installed in the background; wait until it starts
    for (let tries = 0; tries < 100 && await kernel.shell.execute('python3 -c "import ssl, urllib.request" > /dev/null 2>&1') !== 0; tries++) await new Promise(resolve => setTimeout(resolve, 500))
  }, 300000)

  afterAll(() => { server?.close() })

  const run = async (script: string) => {
    await kernel.filesystem.fs.writeFile('/tmp/https.py', script)
    const code = await kernel.shell.execute('SSL_CERT_FILE=/tmp/ca.pem python3 /tmp/https.py > /tmp/https.out 2> /tmp/https.err')
    return { code, out: await kernel.filesystem.fs.readFile('/tmp/https.out', 'utf8'), err: (await kernel.filesystem.fs.readFile('/tmp/https.err', 'utf8')).trim() }
  }

  it('has a resolv.conf that names the kernel\'s own nameserver', async () => {
    expect(await kernel.filesystem.fs.readFile('/etc/resolv.conf', 'utf8')).toBe('nameserver 127.0.0.1\n')
  })

  it('getaddrinfo asks the gateway, and takes only the A record of a name with no AAAA', async () => {
    const result = await run(`import socket
print(sorted({a[4][0] for a in socket.getaddrinfo("example.test", 443, proto=socket.IPPROTO_TCP)}))
try:
    socket.getaddrinfo("nothing.test", 443)
except socket.gaierror as e:
    print("gaierror", e.errno == socket.EAI_NONAME)
`)
    expect(result).toEqual({ code: 0, out: "['203.0.113.9']\ngaierror True\n", err: '' })
    expect(lookups).toContain('example.test/4')
  }, 120000)

  it('urlopen of an https URL connects through the gateway, verifies the certificate by name, and reads the page', async () => {
    const result = await run(`import urllib.request
with urllib.request.urlopen("https://example.test/page?x=1", timeout=60) as r:
    print(r.status, r.headers["content-type"], r.read().decode())
`)
    expect(result).toEqual({ code: 0, out: '200 text/plain hello from example.test GET /page?x=1\n', err: '' })
    expect(connections).toContain('203.0.113.9:443')
  }, 180000)

  it('refuses a certificate that is not for the name', async () => {
    const result = await run(`import urllib.request, urllib.error, ssl
try:
    urllib.request.urlopen("https://203.0.113.9/", timeout=60)
except urllib.error.URLError as e:
    print("refused", isinstance(e.reason, ssl.SSLCertVerificationError))
`)
    expect(result).toEqual({ code: 0, out: 'refused True\n', err: '' })
  }, 180000)
})
