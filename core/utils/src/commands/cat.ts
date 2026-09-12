import path from 'path'
import type { Kernel, Shell, Terminal } from '@ecmaos/types'
import type { CommandContext, CommandIO } from '@ecmaos/types'
import { TerminalEvents } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'

function printUsage(io: CommandIO): void {
  const usage = `Usage: cat [OPTION]... [FILE]...
Concatenate files and print on the standard output.

  --help  display this help and exit`
  io.writelnErr(usage)
}

export const meta = { command: 'cat', description: 'Concatenate files and print on the standard output' } as const

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

      const files: string[] = []

      for (let i = 0; i < ctx.argv.length; i++) {
        const arg = ctx.argv[i]
        if (arg === undefined) continue

        if (arg === '--help' || arg === '-h') {
          printUsage(io)
          return 0
        } else if (!arg.startsWith('-')) {
          files.push(arg)
        }
      }

      const writer = io.stdout!.getWriter()
      const isTTY = io.isTTY ?? false
      let lastByte: number | undefined

      try {
        if (files.length === 0) {
          const reader = io.stdin!.getReader()

          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              if (value.length > 0) {
                lastByte = value[value.length - 1]
              }
              await writer.write(value)
            }
          } finally {
            reader.releaseLock()
          }

          if (isTTY && lastByte !== undefined && lastByte !== 0x0A) {
            await writer.write(new Uint8Array([0x0A]))
          }

          return 0
        }

        let hadError = false

        for (const file of files) {
          const fullPath = path.resolve(shell.cwd, file)

          let interrupted = false
          const interruptHandler = () => { interrupted = true }
          kernel.terminal.events.on(TerminalEvents.INTERRUPT, interruptHandler)

          try {
            if (!fullPath.startsWith('/dev')) {
              const handle = await shell.context.fs.promises.open(fullPath, 'r')
              const stat = await shell.context.fs.promises.stat(fullPath)

              let bytesRead = 0
              const chunkSize = 1024

              while (bytesRead < stat.size) {
                if (interrupted) break
                const data = new Uint8Array(chunkSize)
                const readSize = Math.min(chunkSize, stat.size - bytesRead)
                await handle.read(data, 0, readSize, bytesRead)
                const chunk = data.subarray(0, readSize)
                if (chunk.length > 0) {
                  lastByte = chunk[chunk.length - 1]
                }
                await writer.write(chunk)
                bytesRead += readSize
              }
            } else {
              const device = await shell.context.fs.promises.open(fullPath)
              const chunkSize = 1024
              const data = new Uint8Array(chunkSize)
              let bytesRead = 0

              do {
                if (interrupted) break
                const result = await device.read(data)
                bytesRead = result.bytesRead
                if (bytesRead > 0) {
                  const chunk = data.subarray(0, bytesRead)
                  if (chunk.length > 0) {
                    lastByte = chunk[chunk.length - 1]
                  }
                  await writer.write(chunk)
                }
              } while (bytesRead > 0)
            }
          } catch (error) {
            hadError = true
            const message = error instanceof Error ? error.message : String(error)
            const reason = message.includes('ENOENT') ? 'No such file or directory'
              : message.includes('EISDIR') ? 'Is a directory'
              : message.includes('EACCES') ? 'Permission denied'
              : message
            await io.writelnErr(`cat: ${file}: ${reason}`)
          } finally {
            kernel.terminal.events.off(TerminalEvents.INTERRUPT, interruptHandler)
          }
        }

        if (isTTY && lastByte !== undefined && lastByte !== 0x0A) {
          await writer.write(new Uint8Array([0x0A]))
        }

        return hadError ? 1 : 0
      } finally {
        writer.releaseLock()
      }
    }
  })
}
