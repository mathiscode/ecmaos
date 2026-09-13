/**
 * Real `execve`'d `fetch` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/fetch.ts`) per `feat/1.0.0-execve-commands`. `fetch` is a standard
 * Worker global, same as main-thread. `chalk` (ANSI coloring) is dropped, matching `ls.mjs`'s
 * precedent -- color output isn't proven anywhere in this worker pipeline and isn't essential.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, getcwd, open, close, O_WRONLY, O_CREAT, O_TRUNC } = globalThis.ecmaosSyscalls

const usage = `Usage: fetch [OPTION]... URL
Fetch a resource from the network.

  -o, --output=FILE        write output to FILE instead of stdout
  -X, --method=METHOD      HTTP method to use (default: GET)
  -d, --data=DATA          request body data to send
  -H, --header=HEADER      add custom HTTP header (format: "Name: Value")
  --help                   display this help and exit

Examples:
  fetch https://example.com              fetch and output to stdout
  fetch -o file.txt https://example.com  fetch and save to file.txt
  fetch -X POST -d "data" https://api.example.com  POST request with body`

async function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    writeAll(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  let url
  let outputFile
  let method = 'GET'
  let body
  const headers = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined) continue

    if (arg === '--help' || arg === '-h') {
      writeAll(2, new TextEncoder().encode(usage + '\n'))
      return 0
    } else if (arg === '-o' || arg === '--output') {
      const fileArg = args[i + 1]
      if (!fileArg) {
        writeAll(2, new TextEncoder().encode(`fetch: option requires an argument -- '${arg === '-o' ? 'o' : 'output'}'\n`))
        return 1
      }
      outputFile = fileArg
      i++
    } else if (arg.startsWith('--output=')) {
      const outputValue = arg.split('=')[1]
      if (!outputValue) {
        writeAll(2, new TextEncoder().encode("fetch: option requires an argument -- 'output'\n"))
        return 1
      }
      outputFile = outputValue
    } else if (arg === '-X' || arg === '--method') {
      const methodArg = args[i + 1]
      if (!methodArg) {
        writeAll(2, new TextEncoder().encode(`fetch: option requires an argument -- '${arg === '-X' ? 'X' : 'method'}'\n`))
        return 1
      }
      method = methodArg.toUpperCase()
      i++
    } else if (arg.startsWith('--method=')) {
      const methodValue = arg.split('=')[1]
      if (!methodValue) {
        writeAll(2, new TextEncoder().encode("fetch: option requires an argument -- 'method'\n"))
        return 1
      }
      method = methodValue.toUpperCase()
    } else if (arg === '-d' || arg === '--data') {
      const dataArg = args[i + 1]
      if (!dataArg) {
        writeAll(2, new TextEncoder().encode(`fetch: option requires an argument -- '${arg === '-d' ? 'd' : 'data'}'\n`))
        return 1
      }
      body = dataArg
      i++
    } else if (arg.startsWith('--data=')) {
      const dataValue = arg.split('=')[1]
      if (!dataValue) {
        writeAll(2, new TextEncoder().encode("fetch: option requires an argument -- 'data'\n"))
        return 1
      }
      body = dataValue
    } else if (arg === '-H' || arg === '--header') {
      const headerArg = args[i + 1]
      if (!headerArg) {
        writeAll(2, new TextEncoder().encode(`fetch: option requires an argument -- '${arg === '-H' ? 'H' : 'header'}'\n`))
        return 1
      }
      const [name, ...valueParts] = headerArg.split(':')
      if (!name || valueParts.length === 0) {
        writeAll(2, new TextEncoder().encode('fetch: invalid header format. Expected "Name: Value"\n'))
        return 1
      }
      headers[name.trim()] = valueParts.join(':').trim()
      i++
    } else if (arg.startsWith('--header=')) {
      const headerValue = arg.split('=')[1]
      if (!headerValue) {
        writeAll(2, new TextEncoder().encode("fetch: option requires an argument -- 'header'\n"))
        return 1
      }
      const [name, ...valueParts] = headerValue.split(':')
      if (!name || valueParts.length === 0) {
        writeAll(2, new TextEncoder().encode('fetch: invalid header format. Expected "Name: Value"\n'))
        return 1
      }
      headers[name.trim()] = valueParts.join(':').trim()
    } else if (!arg.startsWith('-')) {
      if (!url) url = arg
      else { writeAll(2, new TextEncoder().encode(`fetch: unexpected argument: ${arg}\n`)); return 1 }
    } else {
      writeAll(2, new TextEncoder().encode(`fetch: invalid option -- '${arg.replace(/^-+/, '')}'\nTry 'fetch --help' for more information.\n`))
      return 1
    }
  }

  if (!url) {
    writeAll(2, new TextEncoder().encode("fetch: URL is required\nTry 'fetch --help' for more information.\n"))
    return 1
  }

  try {
    const fetchOptions = { method }
    if (body) fetchOptions.body = body
    if (Object.keys(headers).length > 0) fetchOptions.headers = headers

    const response = await fetch(url, fetchOptions)

    if (!response.ok) {
      writeAll(2, new TextEncoder().encode(`fetch: HTTP error! status: ${response.status} ${response.statusText}\n`))
      return 1
    }

    const reader = response.body?.getReader()
    if (!reader) {
      writeAll(2, new TextEncoder().encode('fetch: No response body\n'))
      return 1
    }

    const cwd = getcwd()
    let fd
    if (outputFile) fd = open(resolve(cwd, outputFile), O_WRONLY | O_CREAT | O_TRUNC, 0o644)

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value && value.length > 0) {
          if (fd !== undefined) writeAll(fd, value)
          else writeAll(1, value)
        }
      }
    } finally {
      if (fd !== undefined) close(fd)
    }

    return 0
  } catch (error) {
    writeAll(2, new TextEncoder().encode(`fetch: ${error instanceof Error ? error.message : String(error)}\n`))
    return 1
  }
}

try {
  exit(await main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`fetch: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
