import path from 'path'
import type { Kernel, Shell, Terminal } from '@ecmaos/types'
import type { CommandContext, CommandIO } from '@ecmaos/types'
import { TerminalEvents } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'

function printUsage(io: CommandIO): void {
  const usage = `Usage: fold [OPTION]... [FILE]...
Wrap each input line to fit in specified width.

  -w, --width=WIDTH   use WIDTH columns instead of 80
  -s, --spaces        break at spaces when possible
  -b, --bytes         count bytes instead of columns
  --help             display this help and exit`
  io.writelnErr(usage)
}

function wrapLine(line: string, width: number, breakAtSpaces: boolean, countBytes: boolean): string[] {
  if (!line) return ['']
  
  const result: string[] = []
  
  if (countBytes) {
    const encoder = new TextEncoder()
    let current = ''
    let currentBytes = 0
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i]
      const charBytes = encoder.encode(char).length
      
      if (currentBytes + charBytes > width && current.length > 0) {
        if (breakAtSpaces) {
          const lastSpace = current.lastIndexOf(' ')
          if (lastSpace > 0) {
            result.push(current.slice(0, lastSpace))
            current = current.slice(lastSpace + 1) + char
            currentBytes = encoder.encode(current).length
            continue
          }
        }
        result.push(current)
        current = char || ''
        currentBytes = charBytes
      } else {
        current += char
        currentBytes += charBytes
      }
    }
    
    if (current.length > 0) {
      result.push(current)
    }
  } else {
    let current = ''
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i]
      
      if (current.length >= width && current.length > 0) {
        if (breakAtSpaces) {
          const lastSpace = current.lastIndexOf(' ')
          if (lastSpace > 0) {
            result.push(current.slice(0, lastSpace))
            current = current.slice(lastSpace + 1) + char
            continue
          }
        }
        result.push(current)
        current = char || ''
      } else {
        current += char
      }
    }
    
    if (current.length > 0) {
      result.push(current)
    }
  }
  
  return result.length > 0 ? result : ['']
}

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'fold',
    description: 'Wrap each input line to fit in specified width',
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

      let width = 80
      let breakAtSpaces = false
      let countBytes = false
      const files: string[] = []

      for (let i = 0; i < ctx.argv.length; i++) {
        const arg = ctx.argv[i]
        if (!arg) continue

        if (arg === '--help' || arg === '-h') {
          printUsage(io)
          return 0
        } else if (arg === '-w' || arg === '--width') {
          if (i + 1 < ctx.argv.length) {
            const widthStr = ctx.argv[++i]
            if (widthStr !== undefined) {
              const parsed = parseInt(widthStr, 10)
              if (!isNaN(parsed) && parsed > 0) {
                width = parsed
              } else {
                await io.writelnErr(`fold: invalid width: ${widthStr}`)
                return 1
              }
            }
          }
        } else if (arg.startsWith('--width=')) {
          const widthStr = arg.slice(8)
          const parsed = parseInt(widthStr, 10)
          if (!isNaN(parsed) && parsed > 0) {
            width = parsed
          } else {
            await io.writelnErr(`fold: invalid width: ${widthStr}`)
            return 1
          }
        } else if (arg.startsWith('-w')) {
          const widthStr = arg.slice(2)
          if (widthStr) {
            const parsed = parseInt(widthStr, 10)
            if (!isNaN(parsed) && parsed > 0) {
              width = parsed
            } else {
              await io.writelnErr(`fold: invalid width: ${widthStr}`)
              return 1
            }
          }
        } else if (arg === '-s' || arg === '--spaces') {
          breakAtSpaces = true
        } else if (arg === '-b' || arg === '--bytes') {
          countBytes = true
        } else if (arg.startsWith('-')) {
          const flags = arg.slice(1).split('')
          if (flags.includes('s')) breakAtSpaces = true
          if (flags.includes('b')) countBytes = true
          const invalidFlags = flags.filter(f => !['s', 'b'].includes(f))
          if (invalidFlags.length > 0) {
            await io.writelnErr(`fold: invalid option -- '${invalidFlags[0]}'`)
            await io.writelnErr("Try 'fold --help' for more information.")
            return 1
          }
        } else {
          files.push(arg)
        }
      }

      const writer = io.stdout!.getWriter()

      try {
        let lines: string[] = []

        if (files.length === 0) {
          if (!io.stdin) {
            return 0
          }

          const reader = io.stdin.getReader()
          const decoder = new TextDecoder()
          let buffer = ''

          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              if (value) {
                buffer += decoder.decode(value, { stream: true })
                const newLines = buffer.split('\n')
                buffer = newLines.pop() || ''
                lines.push(...newLines)
              }
            }
            if (buffer) {
              lines.push(buffer)
            }
          } finally {
            reader.releaseLock()
          }
        } else {
          for (const file of files) {
            const fullPath = path.resolve(shell.cwd, file)

            let interrupted = false
            const interruptHandler = () => { interrupted = true }
            kernel.terminal.events.on(TerminalEvents.INTERRUPT, interruptHandler)

            try {
              if (fullPath.startsWith('/dev')) {
                await io.writelnErr(`fold: ${file}: cannot process device files`)
                continue
              }

              const handle = await shell.context.fs.promises.open(fullPath, 'r')
              const stat = await shell.context.fs.promises.stat(fullPath)

              const decoder = new TextDecoder()
              let content = ''
              let bytesRead = 0
              const chunkSize = 1024

              while (bytesRead < stat.size) {
                if (interrupted) break
                const data = new Uint8Array(chunkSize)
                const readSize = Math.min(chunkSize, stat.size - bytesRead)
                await handle.read(data, 0, readSize, bytesRead)
                const chunk = data.subarray(0, readSize)
                content += decoder.decode(chunk, { stream: true })
                bytesRead += readSize
              }

              const fileLines = content.split('\n')
              if (fileLines[fileLines.length - 1] === '') {
                fileLines.pop()
              }
              lines.push(...fileLines)
            } catch (error) {
              await io.writelnErr(`fold: ${file}: ${error instanceof Error ? error.message : 'Unknown error'}`)
            } finally {
              kernel.terminal.events.off(TerminalEvents.INTERRUPT, interruptHandler)
            }
          }
        }

        for (const line of lines) {
          const wrapped = wrapLine(line, width, breakAtSpaces, countBytes)
          for (const wrappedLine of wrapped) {
            await writer.write(new TextEncoder().encode(wrappedLine + '\n'))
          }
        }

        return 0
      } catch (error) {
        await io.writelnErr(`fold: ${error instanceof Error ? error.message : 'Unknown error'}`)
        return 1
      } finally {
        writer.releaseLock()
      }
    }
  })
}
