#!/usr/bin/env node
/**
 * Checks that every hosting config sends what ecmaOS needs:
 *
 * - COOP `same-origin` and COEP `require-corp` on every response
 * - `application/wasm` for `.wasm`
 * - `application/octet-stream` and no `Content-Encoding` for `.gz`
 *
 * Without flags it reads each file. With `--serve` it also starts nginx, Caddy and Apache in Docker over a small
 * fixture site and checks the real response headers (needs Docker and the images).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const read = file => readFileSync(join(here, file), 'utf8')
const failures = []
const check = (target, ok, what) => { if (!ok) failures.push(`${target}: ${what}`) }

const COOP = /same-origin/
const COEP = /require-corp/

// Static: the text of each file
const nginx = read('nginx.conf')
check('nginx.conf', /add_header\s+Cross-Origin-Opener-Policy\s+"same-origin"\s+always/.test(nginx), 'no COOP')
check('nginx.conf', /add_header\s+Cross-Origin-Embedder-Policy\s+"require-corp"\s+always/.test(nginx), 'no COEP')
check('nginx.conf', /application\/wasm\s+wasm/.test(nginx), 'no wasm type')
const nginxGz = nginx.match(/location\s+~\s+\\\.gz\$\s*{([^}]*)}/)?.[1] ?? ''
check('nginx.conf', /default_type\s+application\/octet-stream/.test(nginxGz), 'no octet-stream for .gz')
check('nginx.conf', /gzip\s+off/.test(nginxGz), 'gzip is not off for .gz')
// nginx drops the server-level add_header in a location that has its own, so the .gz block repeats them
check('nginx.conf', /Cross-Origin-Opener-Policy/.test(nginxGz) && /Cross-Origin-Embedder-Policy/.test(nginxGz), 'the .gz location lacks the isolation headers')
check('nginx.conf', !/Content-Encoding/i.test(nginx), 'sets Content-Encoding')

const caddy = read('Caddyfile')
check('Caddyfile', /Cross-Origin-Opener-Policy\s+same-origin/.test(caddy), 'no COOP')
check('Caddyfile', /Cross-Origin-Embedder-Policy\s+require-corp/.test(caddy), 'no COEP')
check('Caddyfile', /path\s+\*\.gz/.test(caddy) && /Content-Type\s+application\/octet-stream/.test(caddy), 'no octet-stream for .gz')
check('Caddyfile', !/Content-Encoding/i.test(caddy.replace(/^\s*encode .*$/m, '')), 'sets Content-Encoding')

const apache = read('apache.conf')
check('apache.conf', /Header always set Cross-Origin-Opener-Policy "same-origin"/.test(apache), 'no COOP')
check('apache.conf', /Header always set Cross-Origin-Embedder-Policy "require-corp"/.test(apache), 'no COEP')
check('apache.conf', /AddType application\/wasm \.wasm/.test(apache), 'no wasm type')
check('apache.conf', /ForceType application\/octet-stream/.test(apache) && /RemoveEncoding \.gz/.test(apache), 'no raw .gz')

const dockerfile = read('Dockerfile')
check('Dockerfile', /COPY hosting\/nginx\.conf/.test(dockerfile), 'does not use nginx.conf')

const headers = read('_headers')
check('_headers', COOP.test(headers) && COEP.test(headers), 'no COOP/COEP')
check('_headers', /\/\*\.gz\s+Content-Type: application\/octet-stream/.test(headers), 'no octet-stream for .gz')
check('_headers', /\/\*\.wasm\s+Content-Type: application\/wasm/.test(headers), 'no wasm type')
check('_headers', !/Content-Encoding/i.test(headers), 'sets Content-Encoding')

// Netlify and Vercel: the same rules in their own formats
const netlify = read('netlify.toml')
check('netlify.toml', /Cross-Origin-Opener-Policy = "same-origin"/.test(netlify) && /Cross-Origin-Embedder-Policy = "require-corp"/.test(netlify), 'no COOP/COEP')
check('netlify.toml', /for = "\/\*\.gz"[\s\S]*?Content-Type = "application\/octet-stream"/.test(netlify), 'no octet-stream for .gz')
check('netlify.toml', /for = "\/\*\.wasm"[\s\S]*?Content-Type = "application\/wasm"/.test(netlify), 'no wasm type')
check('netlify.toml', !/Content-Encoding/i.test(netlify), 'sets Content-Encoding')

const vercel = JSON.parse(read('vercel.json'))
const vercelHeaders = (source) => Object.fromEntries((vercel.headers.find(rule => rule.source === source)?.headers ?? []).map(({ key, value }) => [key, value]))
check('vercel.json', vercelHeaders('/(.*)')['Cross-Origin-Opener-Policy'] === 'same-origin' && vercelHeaders('/(.*)')['Cross-Origin-Embedder-Policy'] === 'require-corp', 'no COOP/COEP')
check('vercel.json', vercelHeaders('/(.*).gz')['Content-Type'] === 'application/octet-stream', 'no octet-stream for .gz')
check('vercel.json', vercelHeaders('/(.*).wasm')['Content-Type'] === 'application/wasm', 'no wasm type')
check('vercel.json', !JSON.stringify(vercel).includes('Content-Encoding'), 'sets Content-Encoding')

// The Cloudflare config serves core/kernel/dist and gets its headers from _headers (see cloudflare/package.json)
const cloudflare = read('cloudflare/wrangler.config.ts')
check('cloudflare', /assetsDirectory: '\.\.\/\.\.\/core\/kernel\/dist'/.test(cloudflare), 'does not serve core/kernel/dist')
check('cloudflare', /cp \.\.\/_headers \.\.\/\.\.\/core\/kernel\/dist\/_headers/.test(read('cloudflare/package.json')), 'does not stage _headers')

// Live: the real servers over a fixture
if (process.argv.includes('--serve')) {
  const docker = spawnSync('docker', ['version'], { stdio: 'ignore' })
  if (docker.status !== 0) {
    console.error('--serve needs Docker')
    process.exit(2)
  }

  const site = mkdtempSync(join(tmpdir(), 'ecmaos-hosting-'))
  mkdirSync(join(site, 'programs'))
  writeFileSync(join(site, 'index.html'), '<!doctype html><title>ecmaOS</title>')
  writeFileSync(join(site, 'programs', 'a.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]))
  writeFileSync(join(site, 'initfs.tar.gz'), Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
  // Apache serves from its own docroot with the config appended
  writeFileSync(join(site, 'httpd.conf'), `${read('apache.conf')}\n`)

  // The containers' users are not ours
  for (const path of ['', 'programs']) chmodSync(join(site, path), 0o755)
  for (const path of ['index.html', 'programs/a.wasm', 'initfs.tar.gz', 'httpd.conf']) chmodSync(join(site, path), 0o644)

  const servers = [
    { name: 'nginx', image: 'nginx:alpine', port: 80, args: ['-v', `${join(here, 'nginx.conf')}:/etc/nginx/conf.d/default.conf:ro`, '-v', `${site}:/usr/share/nginx/html:ro`] },
    { name: 'caddy', image: 'caddy:alpine', port: 80, args: ['-v', `${join(here, 'Caddyfile')}:/etc/caddy/Caddyfile:ro`, '-v', `${site}:/srv:ro`] },
    { name: 'apache', image: 'httpd:alpine', port: 80, args: ['-v', `${site}:/usr/local/apache2/htdocs:ro`, '-v', `${site}/httpd.conf:/usr/local/apache2/conf/extra/ecmaos.conf:ro`], command: ['sh', '-c', 'echo "LoadModule headers_module modules/mod_headers.so" >> /usr/local/apache2/conf/httpd.conf && echo "Include conf/extra/ecmaos.conf" >> /usr/local/apache2/conf/httpd.conf && httpd-foreground'] }
  ]

  const headersOf = async (url) => {
    const response = await fetch(url, { headers: { 'Accept-Encoding': 'gzip, br' } })
    return { status: response.status, headers: response.headers }
  }

  for (const server of servers) {
    const id = execFileSync('docker', ['run', '-d', '--rm', '-p', '127.0.0.1::80', ...server.args, server.image, ...(server.command ?? [])], { encoding: 'utf8' }).trim()
    try {
      const mapped = execFileSync('docker', ['port', id, '80/tcp'], { encoding: 'utf8' }).trim().split('\n')[0]
      const base = `http://${mapped}`
      for (let attempt = 0; attempt < 50; attempt++) {
        if (await fetch(`${base}/`).then(() => true, () => false)) break
        await new Promise(resolve => setTimeout(resolve, 200))
      }

      for (const path of ['/', '/programs/a.wasm', '/initfs.tar.gz']) {
        const { status, headers } = await headersOf(`${base}${path}`)
        check(`${server.name} ${path}`, status === 200, `status ${status}`)
        check(`${server.name} ${path}`, headers.get('cross-origin-opener-policy') === 'same-origin', 'no COOP')
        check(`${server.name} ${path}`, headers.get('cross-origin-embedder-policy') === 'require-corp', 'no COEP')
      }

      check(`${server.name} .wasm`, (await headersOf(`${base}/programs/a.wasm`)).headers.get('content-type') === 'application/wasm', 'wrong type')
      const gz = (await headersOf(`${base}/initfs.tar.gz`)).headers
      check(`${server.name} .gz`, gz.get('content-type') === 'application/octet-stream', `type ${gz.get('content-type')}`)
      check(`${server.name} .gz`, !gz.get('content-encoding'), `Content-Encoding ${gz.get('content-encoding')}`)
    } finally {
      spawnSync('docker', ['stop', '-t', '1', id], { stdio: 'ignore' })
    }
  }

  rmSync(site, { recursive: true, force: true })
}

if (failures.length) {
  console.error(failures.map(failure => `FAIL ${failure}`).join('\n'))
  process.exit(1)
}

console.log(`hosting configs ok${process.argv.includes('--serve') ? ' (served)' : ''}`)
