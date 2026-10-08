import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { request } from 'node:http'
import path from 'node:path'

import { DefaultSitePort, findSite, startSite } from '../src/serve.ts'
import type { Site } from '../src/serve.ts'

const folders: string[] = []
const sites: Site[] = []

afterEach(async () => {
  await Promise.all(sites.splice(0).map(site => site.close()))
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

/** A site with an index page, a program, an archive and a file outside the folder */
async function site() {
  const outer = mkdtempSync(path.join(tmpdir(), 'ecmaos-serve-'))
  folders.push(outer)
  const root = path.join(outer, 'site')
  mkdirSync(path.join(root, 'programs'), { recursive: true })
  writeFileSync(path.join(root, 'index.html'), '<h1>ecmaOS</h1>')
  writeFileSync(path.join(root, 'initfs.tar.gz'), Buffer.from('0123456789'))
  writeFileSync(path.join(root, 'programs', 'jq.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d]))
  writeFileSync(path.join(outer, 'secret.txt'), 'not for the web')
  symlinkSync(path.join(outer, 'secret.txt'), path.join(root, 'leak.txt'))
  const started = await startSite({ root, port: 0 })
  sites.push(started)
  return started
}

/** `fetch` normalizes `..` away before sending; this sends the path as written */
function raw(port: number, target: string, headers: Record<string, string> = {}, method = 'GET') {
  return new Promise<{ status: number, headers: Record<string, string | string[] | undefined>, body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: target, method, headers }, res => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('--serve', () => {
  it('serves the index with the two headers that make the page cross-origin isolated', async () => {
    const { port } = await site()
    const res = await raw(port, '/')
    expect(res.status).toBe(200)
    expect(res.body).toBe('<h1>ecmaOS</h1>')
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin')
    expect(res.headers['cross-origin-embedder-policy']).toBe('require-corp')
  })

  it('puts the headers on errors too, since the page may be a redirect target', async () => {
    const { port } = await site()
    const res = await raw(port, '/missing')
    expect(res.status).toBe(404)
    expect(res.headers['cross-origin-embedder-policy']).toBe('require-corp')
  })

  it('serves wasm as wasm and an archive as plain bytes', async () => {
    const { port } = await site()
    expect((await raw(port, '/programs/jq.wasm')).headers['content-type']).toBe('application/wasm')
    const archive = await raw(port, '/initfs.tar.gz')
    expect(archive.headers['content-type']).toBe('application/octet-stream')
    expect(archive.headers['content-encoding']).toBeUndefined()
  })

  it('answers a range request with the bytes asked for, and refuses one past the end', async () => {
    const { port } = await site()
    const part = await raw(port, '/initfs.tar.gz', { Range: 'bytes=2-5' })
    expect(part.status).toBe(206)
    expect(part.body).toBe('2345')
    expect(part.headers['content-range']).toBe('bytes 2-5/10')
    expect((await raw(port, '/initfs.tar.gz', { Range: 'bytes=-3' })).body).toBe('789')
    expect((await raw(port, '/initfs.tar.gz', { Range: 'bytes=50-60' })).status).toBe(416)
  })

  it('answers 304 to a matching ETag and nothing but headers to HEAD', async () => {
    const { port } = await site()
    const first = await raw(port, '/')
    const etag = first.headers['etag'] as string
    expect((await raw(port, '/', { 'If-None-Match': etag })).status).toBe(304)
    const head = await raw(port, '/', {}, 'HEAD')
    expect(head.status).toBe(200)
    expect(head.body).toBe('')
  })

  it('does not serve anything outside the folder: dot-dot, encoded dot-dot, a symlink out, or a NUL', async () => {
    const { port } = await site()
    for (const target of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/leak.txt', '/index.html%00.png']) {
      const res = await raw(port, target)
      expect(res.status, target).toBeGreaterThanOrEqual(400)
      expect(res.body, target).not.toContain('not for the web')
    }
  })

  it('only answers GET and HEAD', async () => {
    const { port } = await site()
    const res = await raw(port, '/', {}, 'POST')
    expect(res.status).toBe(405)
    expect(res.headers['allow']).toBe('GET, HEAD')
  })

  it('listens on loopback by default, and refuses to listen beyond it without TLS', async () => {
    const started = await site()
    expect(started.host).toBe('127.0.0.1')
    await expect(startSite({ root: started.root, host: '0.0.0.0', port: 0 })).rejects.toThrow(/--tls-cert/)
  })

  it('refuses a folder with no index page, and the default port is 30080', async () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'ecmaos-serve-'))
    folders.push(empty)
    await expect(startSite({ root: empty, port: 0 })).rejects.toThrow(/index\.html/)
    expect(() => findSite(empty)).toThrow(/index\.html/)
    expect(DefaultSitePort).toBe(30080)
  })
})
