/**
 * `wget`: download files over HTTP(S) with `fetch`, as GNU wget does the common things: names from the URL (`file.1`
 * and so on when one exists), `-O`, `-P`, `-c` (a `Range` request, appended to), `-N`, `-nc`, `-S`, `--spider`, `-i`,
 * headers, POST data, retries, and a progress bar on a terminal. `-r` follows the links of HTML pages on the same host,
 * `-l` levels deep, keeping the host's directory layout.
 * The browser decides what may be fetched: a site that does not allow cross-origin requests cannot be reached from a
 * page, which wget reports as a failed connection. Names are not looked up, so there is no "Resolving" line. A
 * loopback URL (`http://localhost:8000/`) is fetched over a socket, so a server running here answers.
 */

import { getopt, tryHelp } from './lib/getopt.mjs'
import { fetchAny } from './lib/socket-fetch.mjs'
import { reasonOf } from './lib/errno.mjs'
import { readTextFile } from './lib/fs-text.mjs'
import { isTty, terminalSize } from './lib/tty.mjs'

const { argv, exit, writeAll, open, close, stat, mkdir, utimes, O_WRONLY, O_CREAT, O_TRUNC } = globalThis.ecmaosSyscalls
const O_APPEND = 0x400
const encoder = new TextEncoder()

const usage = `GNU Wget 1.24.5 (ecmaOS), a non-interactive network retriever.
Usage: wget [OPTION]... [URL]...

Startup:
  -V,  --version                   display the version of Wget and exit
  -h,  --help                      print this help

Logging and input file:
  -o,  --output-file=FILE          log messages to FILE
  -a,  --append-output=FILE        append messages to FILE
  -q,  --quiet                     quiet (no output)
  -nv, --no-verbose                turn off verboseness, without being quiet
  -i,  --input-file=FILE           download URLs found in local or external FILE

Download:
  -t,  --tries=NUMBER              set number of retries to NUMBER (0 unlimits)
  -O,  --output-document=FILE      write documents to FILE
  -nc, --no-clobber                skip downloads that would download to existing files
  -c,  --continue                  resume getting a partially-downloaded file
  -N,  --timestamping              don't re-retrieve files unless newer than local
  -S,  --server-response           print server response
       --spider                    don't download anything
  -T,  --timeout=SECONDS           set all timeout values to SECONDS
  -U,  --user-agent=AGENT          identify as AGENT (the browser may not allow it)
       --header=STRING             insert STRING among the headers
       --method=HTTPMethod         use method "HTTPMethod" in the request
       --post-data=STRING          use the POST method; send STRING as the data
       --post-file=FILE            use the POST method; send contents of FILE
       --no-check-certificate      accepted; the browser checks certificates

Directories:
  -nd, --no-directories            don't create directories
  -nH, --no-host-directories       don't create host directories
  -P,  --directory-prefix=PREFIX   save files to PREFIX/..

Recursive download:
  -r,  --recursive                 specify recursive download
  -l,  --level=NUMBER              maximum recursion depth (inf or 0 for infinite)
  -np, --no-parent                 don't ascend to the parent directory
  -A,  --accept=LIST               comma-separated list of accepted extensions
  -R,  --reject=LIST               comma-separated list of rejected extensions`

const pad = n => String(n).padStart(2, '0')
const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
/** `1234 (1.2K)`, or just the number below a kilobyte, as wget writes a length */
const sized = n => n >= 1024 ? `${n} (${human(n)})` : String(n)
const human = n => n >= 1073741824 ? `${(n / 1073741824).toFixed(1)}G` : n >= 1048576 ? `${(n / 1048576).toFixed(1)}M` : n >= 1024 ? `${(n / 1024).toFixed(1)}K` : `${n}`
const rate = (bytes, seconds) => { const r = bytes / Math.max(seconds, 0.001); return r >= 1048576 ? `${(r / 1048576).toFixed(1)} MB/s` : `${(r / 1024).toFixed(1)} KB/s` }
const exists = path => { try { stat(path); return true } catch { return false } }

function mkdirs(dir) {
  let path = dir.startsWith('/') ? '' : '.'
  for (const part of dir.split('/').filter(Boolean)) {
    path += '/' + part
    if (!exists(path)) mkdir(path, 0o755)
  }
}

/** Every href and src of an HTML page, resolved against its URL */
function links(html, base) {
  const found = new Set()
  for (const match of html.matchAll(/\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? '').trim()
    if (!raw || /^(javascript|mailto|data|tel):/i.test(raw) || raw.startsWith('#')) continue
    try { const url = new URL(raw, base); url.hash = ''; found.add(url.href) } catch { /* not a URL */ }
  }
  return [...found]
}

async function main() {
  // the two-letter short options GNU wget has
  const args = argv.slice(1).map(arg => ({ '-nv': '--no-verbose', '-nc': '--no-clobber', '-nd': '--no-directories', '-nH': '--no-host-directories', '-np': '--no-parent' }[arg] ?? arg))
  const { options, operands, error } = getopt(args, {
    short: 'Vho:a:qi:t:O:cNST:U:P:rl:A:R:bk',
    long: {
      version: 'V', help: 'h', 'output-file': { key: 'o', arg: 'required' }, 'append-output': { key: 'a', arg: 'required' }, quiet: 'q', 'no-verbose': 'nv', 'input-file': { key: 'i', arg: 'required' },
      tries: { key: 't', arg: 'required' }, 'output-document': { key: 'O', arg: 'required' }, 'no-clobber': 'nc', continue: 'c', timestamping: 'N', 'server-response': 'S', spider: 'spider',
      timeout: { key: 'T', arg: 'required' }, 'user-agent': { key: 'U', arg: 'required' }, header: { key: 'header', arg: 'required' }, method: { key: 'method', arg: 'required' },
      'post-data': { key: 'post-data', arg: 'required' }, 'post-file': { key: 'post-file', arg: 'required' }, 'no-check-certificate': 'nocert', 'no-directories': 'nd', 'no-host-directories': 'nH',
      'directory-prefix': { key: 'P', arg: 'required' }, recursive: 'r', level: { key: 'l', arg: 'required' }, 'no-parent': 'np', accept: { key: 'A', arg: 'required' }, reject: { key: 'R', arg: 'required' },
      'limit-rate': { key: 'limit', arg: 'required' }, background: 'b', 'convert-links': 'k', 'content-disposition': 'cd', 'show-progress': 'progress', 'progress': { key: 'progressStyle', arg: 'required' }
    }
  })
  let logFd = 2
  const log = text => writeAll(logFd, encoder.encode(text))
  if (error) { log(`wget: ${error}\nUsage: wget [OPTION]... [URL]...\n\n${tryHelp('wget')}\n`); return 2 }
  const o = { verbosity: 2, tries: 20, output: undefined, noClobber: false, cont: false, timestamping: false, server: false, spider: false, timeout: 0, headers: {}, method: undefined, body: undefined, noDirs: false, noHost: false, prefix: '.', recursive: false, level: 5, noParent: false, accept: [], reject: [], progress: false }
  const urls = [...operands]
  for (const [key, value] of options) {
    if (key === 'h') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (key === 'V') { writeAll(1, encoder.encode('GNU Wget 1.24.5 (ecmaOS) built on fetch.\n')); return 0 }
    if (key === 'o' || key === 'a') {
      try { logFd = open(value, O_WRONLY | O_CREAT | (key === 'a' ? O_APPEND : O_TRUNC), 0o644) } catch (e) { writeAll(2, encoder.encode(`wget: ${value}: ${reasonOf(e)}\n`)); return 3 }
    } else if (key === 'q') o.verbosity = 0
    else if (key === 'nv') o.verbosity = 1
    else if (key === 'i') {
      try { urls.push(...(value === '-' ? '' : readTextFile(value)).split(/\s+/).filter(Boolean)) } catch (e) { log(`wget: ${value}: ${reasonOf(e)}\nNo URLs found in ${value}.\n`); return 3 }
    } else if (key === 't') o.tries = value === 'inf' ? Infinity : Number(value) || Infinity
    else if (key === 'O') o.output = value
    else if (key === 'nc') o.noClobber = true
    else if (key === 'c') o.cont = true
    else if (key === 'N') o.timestamping = true
    else if (key === 'S') o.server = true
    else if (key === 'spider') o.spider = true
    else if (key === 'T') o.timeout = Number(value) * 1000
    else if (key === 'U') o.headers['User-Agent'] = value
    else if (key === 'header') { const at = value.indexOf(':'); if (at > 0) o.headers[value.slice(0, at).trim()] = value.slice(at + 1).trim() }
    else if (key === 'method') o.method = value.toUpperCase()
    else if (key === 'post-data') { o.body = value; o.method ??= 'POST' }
    else if (key === 'post-file') {
      try { o.body = readTextFile(value); o.method ??= 'POST' } catch (e) { log(`wget: ${value}: ${reasonOf(e)}\n`); return 3 }
    } else if (key === 'nd') o.noDirs = true
    else if (key === 'nH') o.noHost = true
    else if (key === 'P') o.prefix = value
    else if (key === 'r') o.recursive = true
    else if (key === 'l') o.level = value === 'inf' || value === '0' ? Infinity : Number(value)
    else if (key === 'np') o.noParent = true
    else if (key === 'A') o.accept = value.split(',')
    else if (key === 'R') o.reject = value.split(',')
    else if (key === 'progress') o.progress = true
    else if (key === 'b') { log('wget: --background is not supported: run it with & instead\n'); return 2 }
  }
  if (o.body !== undefined && !o.headers['Content-Type']) o.headers['Content-Type'] = 'application/x-www-form-urlencoded'
  if (urls.length === 0) { log(`wget: missing URL\nUsage: wget [OPTION]... [URL]...\n\n${tryHelp('wget')}\n`); return 1 }

  const terminal = isTty(2) && logFd === 2
  let status = 0
  const worst = code => { status = status === 0 ? code : Math.min(status, code) }
  const seen = new Set()
  let outputOpened
  const started = Date.now()
  let downloaded = 0
  let files = 0

  /** Where a URL is saved */
  const target = url => {
    if (o.output !== undefined) return o.output
    let path = decodeURIComponent(url.pathname)
    if (path.endsWith('/') || path === '') path += 'index.html'
    if (o.recursive && !o.noDirs) return `${o.prefix}/${o.noHost ? '' : url.host + '/'}${path.replace(/^\//, '')}`.replace(/^\.\//, '')
    return `${o.prefix}/${path.slice(path.lastIndexOf('/') + 1) || 'index.html'}`.replace(/^\.\//, '')
  }

  const getOne = async (href, depth, root) => {
    if (seen.has(href)) return
    seen.add(href)
    let url
    try { url = new URL(href) } catch { log(`${href}: Invalid URL ${href}: Scheme missing.\n`); worst(1); return }
    if (!/^https?:$/.test(url.protocol)) { log(`${href}: Unsupported scheme ${url.protocol}.\n`); worst(1); return }
    let path = target(url)
    if (o.output === undefined && !o.recursive && !o.cont && !o.timestamping && !o.noClobber) {
      // as wget does, an existing file is kept and the new one numbered
      for (let n = 1, base = path; exists(path); n++) path = `${base}.${n}`
    }
    if (o.noClobber && exists(path)) { if (o.verbosity) log(`File ‘${path}’ already there; not retrieving.\n\n`); return }
    const headers = { ...o.headers }
    let have = 0
    if (o.cont && exists(path) && o.output === undefined) { have = stat(path).size; if (have) headers.Range = `bytes=${have}-` }
    if (o.timestamping && exists(path)) headers['If-Modified-Since'] = new Date(stat(path).mtimeMs).toUTCString()
    const method = o.spider ? 'HEAD' : o.method ?? 'GET'

    let response
    for (let attempt = 1; ; attempt++) {
      if (o.verbosity > 1) log(`--${stamp()}--  ${url.href}\n${attempt > 1 ? `  (try:${String(attempt).padStart(2)})  ` : ''}Connecting to ${url.host}... `)
      const controller = new AbortController()
      const timer = o.timeout ? setTimeout(() => controller.abort(), o.timeout) : undefined
      try {
        response = await fetchAny(url.href, { method, headers, body: o.body, signal: controller.signal, redirect: 'follow' })
        if (o.verbosity > 1) log('connected.\nHTTP request sent, awaiting response... ')
        break
      } catch (e) {
        if (o.verbosity > 1) log(e?.name === 'AbortError' ? 'failed: Connection timed out.\n' : 'failed: the browser could not reach it (no network, or a cross-origin request the server does not allow).\n')
        else if (o.verbosity) log(`failed: ${url.href}: the browser could not reach it.\n`)
        if (attempt >= o.tries || e?.name !== 'AbortError') { if (o.verbosity > 1) log('Giving up.\n\n'); worst(4); return }
        if (o.verbosity > 1) log('Retrying.\n\n')
      } finally { if (timer) clearTimeout(timer) }
    }

    if (o.verbosity > 1) log(`${response.status} ${response.statusText || ''}\n`.replace(' \n', '\n'))
    if (o.server) {
      const lines = [`  HTTP/1.1 ${response.status} ${response.statusText}`, ...[...response.headers].map(([key, value]) => `  ${key}: ${value}`)]
      log(lines.join('\n') + '\n')
    }
    if (response.status === 304) { if (o.verbosity) log(`File ‘${path}’ not modified on server. Omitting download.\n\n`); return }
    if (response.status === 416 && have) { if (o.verbosity) log('\n    The file is already fully retrieved; nothing to do.\n\n'); return }
    if (!response.ok) {
      if (o.verbosity) log(`${stamp()} ERROR ${response.status}: ${response.statusText || 'Error'}.\n\n`)
      worst(8)
      return
    }
    const length = Number(response.headers.get('content-length') ?? NaN)
    const type = (response.headers.get('content-type') ?? '').split(';')[0]
    if (o.spider) {
      if (o.verbosity > 1) log(`Length: ${Number.isNaN(length) ? 'unspecified' : sized(length)}${type ? ` [${type}]` : ''}\nRemote file exists.\n\n`)
      return
    }
    const append = have > 0 && response.status === 206
    if (o.verbosity > 1) {
      const total = Number.isNaN(length) ? undefined : length + (append ? have : 0)
      log(`Length: ${total === undefined ? 'unspecified' : sized(total)}${append ? `, ${sized(length)} remaining` : ''}${type ? ` [${type}]` : ''}\nSaving to: ‘${path === '-' ? 'STDOUT' : path}’\n\n`)
    }

    let fd
    try {
      if (path === '-') fd = 1
      else if (o.output !== undefined && outputOpened !== undefined) fd = outputOpened
      else {
        const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
        if (dir) mkdirs(dir)
        fd = open(path, O_WRONLY | O_CREAT | (append ? O_APPEND : O_TRUNC), 0o644)
        if (o.output !== undefined) outputOpened = fd
      }
    } catch (e) { log(`${path}: ${reasonOf(e)}\n`); worst(3); return }

    const begin = Date.now()
    let received = 0
    const page = []
    const total = Number.isNaN(length) ? undefined : length
    const draw = done => {
      if (!terminal || o.verbosity < 2 && !o.progress) return
      const name = (path === '-' ? '-' : path.slice(path.lastIndexOf('/') + 1)).slice(0, 20).padEnd(20)
      const columns = Math.min(terminalSize(2).cols, 120)
      const width = Math.max(10, columns - 60)
      const seconds = (Date.now() - begin) / 1000
      if (total) {
        const fraction = Math.min(1, received / total)
        const filled = Math.round(fraction * width)
        log(`\r${name}${String(Math.round(fraction * 100)).padStart(3)}%[${'='.repeat(Math.max(0, filled - 1))}${filled ? '>' : ''}${' '.repeat(width - filled)}] ${human(received + (append ? have : 0)).padStart(7)}  ${rate(received, seconds).padStart(10)}${done ? `    in ${seconds.toFixed(1)}s` : ''}`)
      } else log(`\r${name}    [ <=> ${' '.repeat(Math.max(0, width - 6))}] ${human(received).padStart(7)}  ${rate(received, seconds).padStart(10)}${done ? `    in ${seconds.toFixed(1)}s` : ''}`)
      if (done) log('\n\n')
    }
    try {
      const reader = response.body?.getReader()
      let lastDraw = 0
      while (reader) {
        const { value, done } = await reader.read()
        if (done) break
        writeAll(fd, value)
        received += value.length
        if (o.recursive && type === 'text/html') page.push(value)
        if (Date.now() - lastDraw > 200) { draw(false); lastDraw = Date.now() }
      }
      draw(true)
    } catch (e) {
      log(`\n${stamp()} (${rate(received, (Date.now() - begin) / 1000)}) - Read error at byte ${received}: ${reasonOf(e)}.\n\n`)
      worst(4)
      return
    } finally {
      if (fd !== 1 && fd !== outputOpened) close(fd)
    }
    downloaded += received
    files++
    const modified = response.headers.get('last-modified')
    if (modified && path !== '-' && o.output === undefined) {
      const ms = Date.parse(modified)
      if (!Number.isNaN(ms)) { try { utimes(path, ms / 1000, ms / 1000) } catch { /* the date stays */ } }
    }
    if (o.verbosity > 1) log(`${stamp()} (${rate(received, (Date.now() - begin) / 1000)}) - ‘${path === '-' ? 'written to stdout' : path}’ saved [${received + (append ? have : 0)}${total !== undefined ? `/${total + (append ? have : 0)}` : ''}]\n\n`)
    else if (o.verbosity === 1) log(`${stamp()} URL:${response.url || url.href} [${received}${total !== undefined ? `/${total}` : ''}] -> "${path}" [1]\n`)

    if (o.recursive && type === 'text/html' && depth < o.level) {
      const html = new TextDecoder().decode(Uint8Array.from(page.flatMap(chunk => [...chunk])))
      for (const link of links(html, response.url || url.href)) {
        const next = new URL(link)
        if (next.host !== root.host || !/^https?:$/.test(next.protocol)) continue
        if (o.noParent && !next.pathname.startsWith(root.pathname.slice(0, root.pathname.lastIndexOf('/') + 1))) continue
        const name = next.pathname.slice(next.pathname.lastIndexOf('/') + 1)
        const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
        const html = !extension || /^html?$/i.test(extension)
        if (!html && o.accept.length && !o.accept.some(suffix => name.endsWith(suffix.replace(/^\*?\.?/, '.')) || name.endsWith(suffix))) continue
        if (o.reject.some(suffix => name.endsWith(suffix.replace(/^\*?\.?/, '.')) || name.endsWith(suffix))) continue
        await getOne(next.href, depth + 1, root)
      }
    }
  }

  for (const raw of urls) {
    const href = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`
    let root
    try { root = new URL(href) } catch { log(`${raw}: Invalid URL.\n`); worst(1); continue }
    await getOne(href, 0, root)
  }
  if (outputOpened !== undefined) close(outputOpened)
  if ((files > 1 || o.recursive) && o.verbosity > 1) log(`FINISHED --${stamp()}--\nTotal wall clock time: ${((Date.now() - started) / 1000).toFixed(1)}s\nDownloaded: ${files} files, ${human(downloaded)} in ${((Date.now() - started) / 1000).toFixed(1)}s (${rate(downloaded, (Date.now() - started) / 1000)})\n`)
  if (logFd !== 2) close(logFd)
  return status
}

try {
  exit(await main())
} catch (error) {
  writeAll(2, encoder.encode(`wget: ${reasonOf(error)}\n`))
  exit(1)
}
