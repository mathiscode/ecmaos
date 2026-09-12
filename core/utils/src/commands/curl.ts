import path from 'path'
import chalk from 'chalk'
import type { Kernel, Shell, Terminal } from '@ecmaos/types'
import type { CommandContext, CommandIO } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'

function printUsage(io: CommandIO): void {
  const usage = `Usage: curl [OPTION]... URL
Transfer data from or to a server.

  -o, --output=FILE        write output to FILE instead of stdout
  -O, --remote-name        write output to a file named like the remote file
  -X, --request=METHOD     HTTP method to use (default: GET)
  -d, --data=DATA          send data in POST request
  -H, --header=HEADER      add custom HTTP header (format: "Name: Value")
  -s, --silent             silent mode (don't show progress)
  -v, --verbose            verbose mode (show request/response headers)
  --help                   display this help and exit`
  io.writelnErr(usage)
}

export const meta = { command: 'curl', description: 'Transfer data from or to a server' } as const

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    ...meta,
    kernel,
    shell,
    terminal,
    run: async (ctx: CommandContext, io: CommandIO) => {
      const process = ctx.process

      if (!process) return 1

      if (ctx.argv.length > 0 && (ctx.argv[0] === '--help' || ctx.argv[0] === '-h')) {
        printUsage(io)
        return 0
      }

      let url: string | undefined
      let outputFile: string | undefined
      let remoteName = false
      let method = 'GET'
      let body: string | undefined
      const headers: Record<string, string> = {}
      let silent = false
      let verbose = false

      for (let i = 0; i < ctx.argv.length; i++) {
        const arg = ctx.argv[i]
        if (!arg) continue

        if (arg === '--help' || arg === '-h') {
          printUsage(io)
          return 0
        } else if (arg === '-o' || arg === '--output') {
          if (i + 1 < ctx.argv.length) {
            outputFile = ctx.argv[++i]
          }
        } else if (arg.startsWith('--output=')) {
          outputFile = arg.slice(9)
        } else if (arg.startsWith('-o')) {
          outputFile = arg.slice(2) || undefined
        } else if (arg === '-O' || arg === '--remote-name') {
          remoteName = true
        } else if (arg === '-X' || arg === '--request') {
          if (i + 1 < ctx.argv.length) {
            method = (ctx.argv[++i] || 'GET').toUpperCase()
          }
        } else if (arg.startsWith('--request=')) {
          method = arg.slice(10).toUpperCase()
        } else if (arg.startsWith('-X')) {
          method = (arg.slice(2) || 'GET').toUpperCase()
        } else if (arg === '-d' || arg === '--data') {
          if (i + 1 < ctx.argv.length) {
            body = ctx.argv[++i]
          }
        } else if (arg.startsWith('--data=')) {
          body = arg.slice(7)
        } else if (arg.startsWith('-d')) {
          body = arg.slice(2) || undefined
        } else if (arg === '-H' || arg === '--header') {
          if (i + 1 < ctx.argv.length) {
            const headerArg = ctx.argv[++i]
            if (headerArg) {
              const [name, ...valueParts] = headerArg.split(':')
              if (name && valueParts.length > 0) {
                headers[name.trim()] = valueParts.join(':').trim()
              }
            }
          }
        } else if (arg.startsWith('--header=')) {
          const headerValue = arg.slice(9)
          const [name, ...valueParts] = headerValue.split(':')
          if (name && valueParts.length > 0) {
            headers[name.trim()] = valueParts.join(':').trim()
          }
        } else if (arg.startsWith('-H')) {
          const headerValue = arg.slice(2)
          if (headerValue) {
            const [name, ...valueParts] = headerValue.split(':')
            if (name && valueParts.length > 0) {
              headers[name.trim()] = valueParts.join(':').trim()
            }
          }
        } else if (arg === '-s' || arg === '--silent') {
          silent = true
        } else if (arg === '-v' || arg === '--verbose') {
          verbose = true
        } else if (arg.startsWith('-')) {
          const flags = arg.slice(1).split('')
          if (flags.includes('s')) silent = true
          if (flags.includes('v')) verbose = true
          if (flags.includes('O')) remoteName = true
          const invalidFlags = flags.filter(f => !['s', 'v', 'O'].includes(f))
          if (invalidFlags.length > 0) {
            await io.writelnErr(`curl: invalid option -- '${invalidFlags[0]}'`)
            await io.writelnErr("Try 'curl --help' for more information.")
            return 1
          }
        } else {
          if (!url) {
            url = arg
          } else {
            await io.writelnErr(`curl: unexpected argument: ${arg}`)
            return 1
          }
        }
      }

      if (!url) {
        await io.writelnErr('curl: URL is required')
        await io.writelnErr("Try 'curl --help' for more information.")
        return 1
      }

      if (remoteName && !outputFile) {
        const urlObj = new URL(url)
        const pathname = urlObj.pathname
        outputFile = path.basename(pathname) || 'index.html'
      }

      try {
        if (verbose && !silent) {
          await io.writelnErr(`* Connecting to ${url}`)
          await io.writelnErr(`> ${method} ${url} HTTP/1.1`)
        }

        const fetchOptions: RequestInit = { method }
        if (body) {
          fetchOptions.body = body
          if (!headers['Content-Type']) {
            headers['Content-Type'] = 'application/x-www-form-urlencoded'
          }
        }
        if (Object.keys(headers).length > 0) {
          fetchOptions.headers = headers
        }

        if (verbose && !silent) {
          for (const [name, value] of Object.entries(headers)) {
            await io.writelnErr(`> ${name}: ${value}`)
          }
        }

        const response = await globalThis.fetch(url, fetchOptions)

        if (verbose && !silent) {
          await io.writelnErr(`< HTTP/${response.status} ${response.status} ${response.statusText}`)
          for (const [name, value] of response.headers.entries()) {
            await io.writelnErr(`< ${name}: ${value}`)
          }
        }

        if (!response.ok && !silent) {
          await io.writelnErr(chalk.red(`curl: HTTP error! status: ${response.status}`))
        }

        const reader = response.body?.getReader()
        if (!reader) {
          if (!silent) {
            await io.writelnErr(chalk.red('curl: No response body'))
          }
          return response.ok ? 0 : 1
        }

        let writer: WritableStreamDefaultWriter<Uint8Array> | { write: (chunk: Uint8Array) => Promise<void>, releaseLock: () => Promise<void> } | undefined

        if (outputFile) {
          const fullPath = path.resolve(shell.cwd, outputFile)
          const fileHandle = await shell.context.fs.promises.open(fullPath, 'w')
          writer = {
            write: async (chunk: Uint8Array) => {
              await fileHandle.write(chunk)
            },
            releaseLock: async () => {
              await fileHandle.close()
            }
          }
        } else {
          if (!io.stdout) {
            await io.writelnErr(chalk.red('curl: No stdout available'))
            return 1
          }
          writer = io.stdout.getWriter()
        }

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            if (value && value.length > 0) {
              await writer.write(value)
            }
          }
        } finally {
          reader.releaseLock()
          if (writer && 'releaseLock' in writer) {
            await writer.releaseLock()
          }
        }

        return response.ok ? 0 : 1
      } catch (error) {
        if (!silent) {
          await io.writelnErr(chalk.red(`curl: ${error instanceof Error ? error.message : 'Unknown error'}`))
        }
        return 1
      }
    }
  })
}
