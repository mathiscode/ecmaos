import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createRequire } from 'node:module'
import path from 'node:path'

/** ecmaOS only runs on a page that is cross-origin isolated, which these two headers make it. */
export const IsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp'
} as const

export const DefaultSitePort = 30080

const Types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json', '.toml': 'text/plain; charset=utf-8', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4'
}

/** Already-compressed archives are handed over as bytes: the kernel unpacks them itself. */
const typeOf = (file: string) => Types[path.extname(file).toLowerCase()] ?? 'application/octet-stream'

export interface SiteOptions {
  /** The folder to serve; it must hold an `index.html` */
  root: string
  host?: string
  port?: number
  /** Required to listen beyond loopback, since a page is only a secure context there over https */
  tls?: { cert: Buffer, key: Buffer }
  log?: (text: string) => void
}

export interface Site {
  host: string
  port: number
  root: string
  close(): Promise<void>
}

const loopback = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '::1'

/** Where the built kernel site is, when the user did not say: beside this package in the repository, or installed. */
export function findSite(explicit?: string): string {
  const candidates: string[] = []
  if (explicit) candidates.push(path.resolve(explicit))
  else {
    if (process.env['ECMAOS_SITE']) candidates.push(path.resolve(process.env['ECMAOS_SITE']))
    candidates.push(path.resolve(import.meta.dirname, '../../kernel/dist'))
    try { candidates.push(path.join(path.dirname(createRequire(import.meta.url).resolve('@ecmaos/kernel')), '.')) } catch { /* not installed */ }
  }
  const found = candidates.find(dir => existsSync(path.join(dir, 'index.html')))
  if (!found) throw new Error(explicit
    ? `${path.resolve(explicit)} has no index.html`
    : 'no built site found: build it (pnpm build --filter @ecmaos/kernel) or name the folder with --site DIR')
  return found
}

/** The request path as a file under `root`, or `undefined` when it would leave `root` */
function resolveFile(root: string, url: string): string | undefined {
  let pathname: string
  try { pathname = decodeURIComponent(new URL(url, 'http://localhost').pathname) } catch { return undefined }
  if (pathname.includes('\0')) return undefined
  const target = path.join(root, path.posix.normalize(pathname))
  if (target !== root && !target.startsWith(root + path.sep)) return undefined
  return target
}

function parseRange(header: string, size: number): { start: number, end: number } | 'invalid' | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return undefined
  const [, from, to] = match
  let start: number
  let end: number
  if (from === '' && to === '') return 'invalid'
  if (from === '') { start = Math.max(0, size - Number(to)); end = size - 1 } else {
    start = Number(from)
    end = to === '' ? size - 1 : Math.min(Number(to), size - 1)
  }
  return start > end || start >= size ? 'invalid' : { start, end }
}

export async function startSite(options: SiteOptions): Promise<Site> {
  const host = options.host ?? '127.0.0.1'
  if (!loopback(host) && !options.tls) throw new Error('serving beyond loopback needs --tls-cert and --tls-key: a page is only a secure context over https')
  const root = realpathSync(options.root)
  if (!existsSync(path.join(root, 'index.html'))) throw new Error(`${root} has no index.html`)

  const reply = (res: ServerResponse, status: number, text: string) => {
    res.writeHead(status, { ...IsolationHeaders, 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' })
    res.end(text + '\n')
  }

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD'); return reply(res, 405, 'method not allowed') }
    const requested = resolveFile(root, req.url ?? '/')
    if (!requested) return reply(res, 400, 'bad request')
    let file = requested
    let stats: Stats
    try {
      stats = statSync(file)
      if (stats.isDirectory()) { file = path.join(file, 'index.html'); stats = statSync(file) }
      // A symlink pointing out of the folder is a way out of it
      const real = realpathSync(file)
      if (real !== root && !real.startsWith(root + path.sep)) return reply(res, 404, 'not found')
    } catch { return reply(res, 404, 'not found') }
    if (!stats.isFile()) return reply(res, 404, 'not found')

    const etag = `"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`
    const headers: Record<string, string | number> = {
      ...IsolationHeaders,
      'Content-Type': typeOf(file),
      'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
      'ETag': etag,
      'Last-Modified': stats.mtime.toUTCString()
    }
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end() }

    let status = 200
    let range: { start: number, end: number } | undefined
    if (req.headers.range) {
      const parsed = parseRange(req.headers.range, stats.size)
      if (parsed === 'invalid') { res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stats.size}` }); return res.end() }
      if (parsed) { range = parsed; status = 206; headers['Content-Range'] = `bytes ${parsed.start}-${parsed.end}/${stats.size}` }
    }
    headers['Content-Length'] = range ? range.end - range.start + 1 : stats.size
    res.writeHead(status, headers)
    if (req.method === 'HEAD') return res.end()
    const stream = createReadStream(file, range)
    stream.on('error', () => res.destroy())
    stream.pipe(res)
  }

  const server: Server = options.tls ? createHttpsServer(options.tls, handle) : createHttpServer(handle)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? DefaultSitePort, host === 'localhost' ? '127.0.0.1' : host, () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : options.port ?? DefaultSitePort
  options.log?.(`serving ${root} on ${options.tls ? 'https' : 'http'}://${host}:${port}`)

  return {
    host, port, root,
    async close() {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }
}
