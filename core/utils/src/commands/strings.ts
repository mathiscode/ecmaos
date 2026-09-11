import path from 'path'
import type { Kernel, Shell, Terminal } from '@ecmaos/types'
import type { CommandContext, CommandIO } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'

function printUsage(io: CommandIO): void {
  const usage = `Usage: strings [OPTION]... [FILE]...
Print the sequences of printable characters in files.

  -n, --bytes=MIN_LEN    print sequences of at least MIN_LEN characters (default: 4)
  --help                 display this help and exit`
  io.writelnErr(usage)
}

function extractStrings(data: Uint8Array, minLen: number): string[] {
  const strings: string[] = []
  let currentString = ''
  
  for (let i = 0; i < data.length; i++) {
    const byte = data[i]
    if (byte === undefined) continue
    
    if (byte >= 32 && byte <= 126) {
      currentString += String.fromCharCode(byte)
    } else {
      if (currentString.length >= minLen) {
        strings.push(currentString)
      }
      currentString = ''
    }
  }
  
  if (currentString.length >= minLen) {
    strings.push(currentString)
  }
  
  return strings
}

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'strings',
    description: 'Print the sequences of printable characters in files',
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

      let minLen = 4
      const files: string[] = []

      for (let i = 0; i < ctx.argv.length; i++) {
        const arg = ctx.argv[i]
        if (!arg) continue

        if (arg === '--help' || arg === '-h') {
          printUsage(io)
          return 0
        } else if (arg === '-n' || arg === '--bytes') {
          if (i + 1 < ctx.argv.length) {
            const lenStr = ctx.argv[++i]
            if (lenStr !== undefined) {
              const parsed = parseInt(lenStr, 10)
              if (!isNaN(parsed) && parsed > 0) {
                minLen = parsed
              } else {
                await io.writelnErr(`strings: invalid minimum length: ${lenStr}`)
                return 1
              }
            }
          }
        } else if (arg.startsWith('--bytes=')) {
          const lenStr = arg.slice(8)
          const parsed = parseInt(lenStr, 10)
          if (!isNaN(parsed) && parsed > 0) {
            minLen = parsed
          } else {
            await io.writelnErr(`strings: invalid minimum length: ${lenStr}`)
            return 1
          }
        } else if (arg.startsWith('-n')) {
          const lenStr = arg.slice(2)
          if (lenStr) {
            const parsed = parseInt(lenStr, 10)
            if (!isNaN(parsed) && parsed > 0) {
              minLen = parsed
            } else {
              await io.writelnErr(`strings: invalid minimum length: ${lenStr}`)
              return 1
            }
          }
        } else if (!arg.startsWith('-')) {
          files.push(arg)
        } else {
          await io.writelnErr(`strings: invalid option -- '${arg.slice(1)}'`)
          await io.writelnErr("Try 'strings --help' for more information.")
          return 1
        }
      }

      const writer = io.stdout!.getWriter()

      try {
        if (files.length === 0) {
          if (!io.stdin) {
            return 0
          }

          const reader = io.stdin.getReader()
          const chunks: Uint8Array[] = []

          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              if (value) {
                chunks.push(value)
              }
            }
          } finally {
            reader.releaseLock()
          }

          const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
          const data = new Uint8Array(totalLength)
          let offset = 0
          for (const chunk of chunks) {
            data.set(chunk, offset)
            offset += chunk.length
          }

          const extractedStrings = extractStrings(data, minLen)
          for (const str of extractedStrings) {
            await writer.write(new TextEncoder().encode(str + '\n'))
          }

          return 0
        }

        for (const file of files) {
          const fullPath = path.resolve(shell.cwd, file)

          try {
            if (fullPath.startsWith('/dev')) {
              await io.writelnErr(`strings: ${file}: cannot process device files`)
              continue
            }

            const data = await shell.context.fs.promises.readFile(fullPath)
            const extractedStrings = extractStrings(new Uint8Array(data), minLen)
            for (const str of extractedStrings) {
              await writer.write(new TextEncoder().encode(str + '\n'))
            }
          } catch (error) {
            await io.writelnErr(`strings: ${file}: ${error instanceof Error ? error.message : 'Unknown error'}`)
          }
        }

        return 0
      } catch (error) {
        await io.writelnErr(`strings: ${error instanceof Error ? error.message : 'Unknown error'}`)
        return 1
      } finally {
        writer.releaseLock()
      }
    }
  })
}
