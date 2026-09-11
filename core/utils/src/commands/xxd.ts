import path from 'path'
import type { Kernel, Shell, Terminal } from '@ecmaos/types'
import type { CommandContext, CommandIO } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'

function printUsage(io: CommandIO): void {
  const usage = `Usage: xxd [FILE]
Display file contents or stdin in hexadecimal format.

  FILE    the file to display (if omitted, reads from stdin)
  --help  display this help and exit`
  io.writelnErr(usage)
}

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'xxd',
    description: 'Display file contents or stdin in hexadecimal format',
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

      const firstArg = ctx.argv.length > 0 ? ctx.argv[0] : undefined
      const filePath = firstArg !== undefined && !firstArg.startsWith('-') ? firstArg : undefined
      let data: Uint8Array

      try {
        if (!filePath) {
          if (!io.stdin) {
            await io.writelnErr('Usage: xxd <file>')
            await io.writelnErr('   or: <command> | xxd')
            return 1
          }

          if (ctx.process?.stdinIsTTY) {
            await io.writelnErr('Usage: xxd <file>')
            await io.writelnErr('   or: <command> | xxd')
            return 1
          }

          const reader = io.stdin.getReader()
          const chunks: Uint8Array[] = []

          try {
            const first = await reader.read()
            
            if (first.done && !first.value) {
              await io.writelnErr('Usage: xxd <file>')
              await io.writelnErr('   or: <command> | xxd')
              return 1
            }
            
            if (first.value) {
              chunks.push(first.value)
            }
            
            if (!first.done) {
              while (true) {
                const { done, value } = await reader.read()
                if (done) break
                if (value) {
                  chunks.push(value)
                }
              }
            }
          } finally {
            reader.releaseLock()
          }

          const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
          if (totalLength === 0) {
            await io.writelnErr('Usage: xxd <file>')
            await io.writelnErr('   or: <command> | xxd')
            return 1
          }

          data = new Uint8Array(totalLength)
          let offset = 0
          for (const chunk of chunks) {
            data.set(chunk, offset)
            offset += chunk.length
          }
        } else {
          const fullPath = path.resolve(shell.cwd, filePath)

          const exists = await shell.context.fs.promises.exists(fullPath)
          if (!exists) {
            await io.writelnErr(`xxd: ${filePath}: No such file or directory`)
            return 1
          }

          const stats = await shell.context.fs.promises.stat(fullPath)
          if (stats.isDirectory()) {
            await io.writelnErr(`xxd: ${filePath}: Is a directory`)
            return 1
          }

          data = await shell.context.fs.promises.readFile(fullPath)
        }
        const bytesPerLine = 16

        for (let offset = 0; offset < data.length; offset += bytesPerLine) {
          const lineBytes = data.slice(offset, offset + bytesPerLine)
          const offsetHex = offset.toString(16).padStart(8, '0')
          
          const hexGroups: string[] = []
          const asciiChars: string[] = []
          
          for (let i = 0; i < bytesPerLine; i++) {
            if (i < lineBytes.length) {
              const byte = lineBytes[i]
              if (byte === undefined) continue
              
              const hex = byte.toString(16).padStart(2, '0')
              
              if (i % 2 === 0) {
                hexGroups.push(hex)
              } else {
                hexGroups[hexGroups.length - 1] += hex
              }
              
              if (byte >= 32 && byte <= 126) {
                asciiChars.push(String.fromCharCode(byte))
              } else {
                asciiChars.push('.')
              }
            } else {
              if (i % 2 === 0) {
                hexGroups.push('  ')
              } else {
                hexGroups[hexGroups.length - 1] += '  '
              }
              asciiChars.push(' ')
            }
          }
          
          const hexString = hexGroups.join(' ').padEnd(47, ' ')
          const asciiString = asciiChars.join('')
          
          try {
            await io.writeln(`${offsetHex}: ${hexString}  ${asciiString}`)
          } catch {
            // Ignore write errors (e.g. pipe closed) and exit
            return 0
          }
        }

        return 0
      } catch (error) {
        const errorPath = filePath || 'stdin'
        await io.writelnErr(`xxd: ${errorPath}: ${error instanceof Error ? error.message : 'Unknown error'}`)
        return 1
      }
    }
  })
}
