/**
 * Transfer data from or to a URL. Plain text output, no ANSI coloring. A loopback URL (`http://localhost:8000/`) is
 * fetched over a socket, so a server running here answers (`lib/socket-fetch.mjs`); anything else goes through the
 * browser's `fetch`, which follows redirects by itself.
 */

import { resolve, basename } from './lib/path-utils.mjs'
import { fetchAny, isLoopbackUrl } from './lib/socket-fetch.mjs'

const { argv, exit, writeAll, getcwd, open, close, O_WRONLY, O_CREAT, O_TRUNC } = globalThis.ecmaosSyscalls

const usage = `Usage: curl [OPTION]... URL
Transfer data from or to a server.

  -o, --output=FILE        write output to FILE instead of stdout
  -O, --remote-name        write output to a file named like the remote file
  -X, --request=METHOD     HTTP method to use (default: GET)
  -d, --data=DATA          send data in POST request
  -H, --header=HEADER      add custom HTTP header (format: "Name: Value")
  -i, --include            include the response's status line and headers in the output
  -I, --head               fetch the headers only (HEAD)
  -L, --location           follow redirects
  -f, --fail               fail silently (exit 22) on an HTTP error
  -s, --silent             silent mode (don't show progress or errors)
  -S, --show-error         with -s, still show errors
  -v, --verbose            verbose mode (show request/response headers)
  --help                   display this help and exit`

async function main() {
  {
    const args = argv.slice(1)
    if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
      writeAll(1, new TextEncoder().encode(usage + '\n'))
      return 0
    }

    let url
    let outputFile
    let remoteName = false
    let method = 'GET'
    let body
    const headers = {}
    let silent = false
    let showError = false
    let verbose = false
    let include = false
    let head = false
    let follow = false
    let failOnError = false

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (!arg) continue

      if (arg === '--help' || arg === '-h') {
        writeAll(1, new TextEncoder().encode(usage + '\n'))
        return 0
      } else if (arg === '-o' || arg === '--output') {
        if (i + 1 < args.length) outputFile = args[++i]
      } else if (arg.startsWith('--output=')) {
        outputFile = arg.slice(9)
      } else if (arg.startsWith('-o')) {
        outputFile = arg.slice(2) || undefined
      } else if (arg === '-O' || arg === '--remote-name') {
        remoteName = true
      } else if (arg === '-X' || arg === '--request') {
        if (i + 1 < args.length) method = (args[++i] || 'GET').toUpperCase()
      } else if (arg.startsWith('--request=')) {
        method = arg.slice(10).toUpperCase()
      } else if (arg.startsWith('-X')) {
        method = (arg.slice(2) || 'GET').toUpperCase()
      } else if (arg === '-d' || arg === '--data') {
        if (i + 1 < args.length) body = args[++i]
      } else if (arg.startsWith('--data=')) {
        body = arg.slice(7)
      } else if (arg.startsWith('-d')) {
        body = arg.slice(2) || undefined
      } else if (arg === '-H' || arg === '--header') {
        if (i + 1 < args.length) {
          const headerArg = args[++i]
          if (headerArg) {
            const [name, ...valueParts] = headerArg.split(':')
            if (name && valueParts.length > 0) headers[name.trim()] = valueParts.join(':').trim()
          }
        }
      } else if (arg.startsWith('--header=')) {
        const headerValue = arg.slice(9)
        const [name, ...valueParts] = headerValue.split(':')
        if (name && valueParts.length > 0) headers[name.trim()] = valueParts.join(':').trim()
      } else if (arg.startsWith('-H')) {
        const headerValue = arg.slice(2)
        if (headerValue) {
          const [name, ...valueParts] = headerValue.split(':')
          if (name && valueParts.length > 0) headers[name.trim()] = valueParts.join(':').trim()
        }
      } else if (arg === '-s' || arg === '--silent') {
        silent = true
      } else if (arg === '-v' || arg === '--verbose') {
        verbose = true
      } else if (arg === '--show-error') {
        showError = true
      } else if (arg === '--include') {
        include = true
      } else if (arg === '--head') {
        head = true
      } else if (arg === '--location') {
        follow = true
      } else if (arg === '--fail') {
        failOnError = true
      } else if (arg.startsWith('-') && !arg.startsWith('--')) {
        const flags = arg.slice(1).split('')
        if (flags.includes('s')) silent = true
        if (flags.includes('S')) showError = true
        if (flags.includes('v')) verbose = true
        if (flags.includes('O')) remoteName = true
        if (flags.includes('i')) include = true
        if (flags.includes('I')) head = true
        if (flags.includes('L')) follow = true
        if (flags.includes('f')) failOnError = true
        const invalid = flags.find(f => !['s', 'S', 'v', 'O', 'i', 'I', 'L', 'f'].includes(f))
        if (invalid) {
          writeAll(2, new TextEncoder().encode(`curl: invalid option -- '${invalid}'\nTry 'curl --help' for more information.\n`))
          return 1
        }
      } else {
        if (!url) url = arg
        else { writeAll(2, new TextEncoder().encode(`curl: unexpected argument: ${arg}\n`)); return 1 }
      }
    }

    if (!url) {
      writeAll(2, new TextEncoder().encode("curl: URL is required\nTry 'curl --help' for more information.\n"))
      return 1
    }

    if (remoteName && !outputFile) {
      const urlObj = new URL(url)
      outputFile = basename(urlObj.pathname) || 'index.html'
    }

    if (head) method = 'HEAD'
    const quiet = silent && !showError
    try {
      if (verbose && !silent) {
        writeAll(2, new TextEncoder().encode(`* Connecting to ${url}\n> ${method} ${url} HTTP/1.1\n`))
      }

      const fetchOptions = { method }
      // the browser's fetch follows redirects whatever it is told; a socket's is told what curl does
      if (isLoopbackUrl(url)) fetchOptions.redirect = follow ? 'follow' : 'manual'
      if (body) {
        fetchOptions.body = body
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/x-www-form-urlencoded'
      }
      if (Object.keys(headers).length > 0) fetchOptions.headers = headers

      if (verbose && !silent) {
        for (const [name, value] of Object.entries(headers)) {
          writeAll(2, new TextEncoder().encode(`> ${name}: ${value}\n`))
        }
      }

      const response = await fetchAny(url, fetchOptions)

      if (verbose && !silent) {
        writeAll(2, new TextEncoder().encode(`< HTTP/${response.status} ${response.status} ${response.statusText}\n`))
        for (const [name, value] of response.headers.entries()) {
          writeAll(2, new TextEncoder().encode(`< ${name}: ${value}\n`))
        }
      }

      if (failOnError && response.status >= 400) {
        if (!quiet) writeAll(2, new TextEncoder().encode(`curl: (22) The requested URL returned error: ${response.status}\n`))
        await response.body?.cancel()
        return 22
      }

      const cwd = getcwd()
      let fd
      if (outputFile) fd = open(resolve(cwd, outputFile), O_WRONLY | O_CREAT | O_TRUNC, 0o644)
      const emit = bytes => { if (fd !== undefined) writeAll(fd, bytes); else writeAll(1, bytes) }
      if (include || head) {
        const lines = [`HTTP/1.1 ${response.status} ${response.statusText}`.trimEnd(), ...[...response.headers.entries()].map(([name, value]) => `${name}: ${value}`), '', '']
        emit(new TextEncoder().encode(lines.join('\r\n')))
      }
      if (head) { if (fd !== undefined) close(fd); return 0 }

      const reader = response.body?.getReader()
      try {
        while (reader) {
          const { done, value } = await reader.read()
          if (done) break
          if (value && value.length > 0) emit(value)
        }
      } finally {
        if (fd !== undefined) close(fd)
      }

      // as curl: an HTTP error status is still a transfer that worked, unless -f
      return 0
    } catch (error) {
      if (!quiet) writeAll(2, new TextEncoder().encode(`curl: (7) ${error instanceof Error ? error.message : String(error)}\n`))
      return 7
    }
  }
}

try {
  exit(await main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`curl: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
