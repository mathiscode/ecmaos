import path from 'path'
import type { Kernel, Shell, Terminal } from '@ecmaos/types'
import type { CommandContext, CommandIO } from '@ecmaos/types'
import { TerminalEvents } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'

function printUsage(io: CommandIO): void {
  const usage = `Usage: join [OPTION]... FILE1 FILE2
Join lines of two files on a common field.

  -1 FIELD    join on this FIELD of file 1
  -2 FIELD    join on this FIELD of file 2
  -t CHAR     use CHAR as input and output field separator
  --help      display this help and exit`
  io.writelnErr(usage)
}

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'join',
    description: 'Join lines of two files on a common field',
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
      let field1 = 1
      let field2 = 1
      let delimiter = ' '

      for (let i = 0; i < ctx.argv.length; i++) {
        const arg = ctx.argv[i]
        if (!arg) continue

        if (arg === '--help' || arg === '-h') {
          printUsage(io)
          return 0
        } else if (arg === '-1' && i + 1 < ctx.argv.length) {
          const nextArg = ctx.argv[++i]
          if (nextArg !== undefined) {
            field1 = parseInt(nextArg, 10) || 1
          }
        } else if (arg === '-2' && i + 1 < ctx.argv.length) {
          const nextArg = ctx.argv[++i]
          if (nextArg !== undefined) {
            field2 = parseInt(nextArg, 10) || 1
          }
        } else if (arg.startsWith('-t')) {
          delimiter = arg.slice(2) || ' '
        } else if (arg === '-t' && i + 1 < ctx.argv.length) {
          const nextArg = ctx.argv[++i]
          if (nextArg !== undefined) {
            delimiter = nextArg
          }
        } else if (!arg.startsWith('-')) {
          if (files.length < 2) {
            files.push(arg)
          }
        }
      }

      if (files.length !== 2) {
        await io.writelnErr('join: exactly two files must be specified')
        return 1
      }

      const file1 = files[0]
      const file2 = files[1]
      if (!file1 || !file2) {
        await io.writelnErr('join: exactly two files must be specified')
        return 1
      }

      const writer = io.stdout!.getWriter()

      const readFileLines = async (filePath: string): Promise<string[]> => {
        if (filePath.startsWith('/dev')) {
          throw new Error('cannot join device files')
        }

        let interrupted = false
        const interruptHandler = () => { interrupted = true }
        kernel.terminal.events.on(TerminalEvents.INTERRUPT, interruptHandler)

        try {
          const handle = await shell.context.fs.promises.open(filePath, 'r')
          const stat = await shell.context.fs.promises.stat(filePath)

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

          const lines = content.split('\n')
          if (lines[lines.length - 1] === '') {
            lines.pop()
          }
          return lines
        } finally {
          kernel.terminal.events.off(TerminalEvents.INTERRUPT, interruptHandler)
        }
      }

      try {
        const fullPath1 = path.resolve(shell.cwd || '/', file1)
        const fullPath2 = path.resolve(shell.cwd || '/', file2)

        const lines1 = await readFileLines(fullPath1)
        const lines2 = await readFileLines(fullPath2)

        const map1 = new Map<string, string[]>()
        for (const line of lines1) {
          const parts = line.split(delimiter)
          const key = parts[field1 - 1] || ''
          if (!map1.has(key)) {
            map1.set(key, [])
          }
          map1.get(key)!.push(line)
        }

        for (const line of lines2) {
          const parts = line.split(delimiter)
          const key = parts[field2 - 1] || ''
          const matches = map1.get(key)
          if (matches) {
            for (const match of matches) {
              const matchParts = match.split(delimiter)
              const output = [...matchParts, ...parts.slice(field2)].join(delimiter)
              await writer.write(new TextEncoder().encode(output + '\n'))
            }
          }
        }

        return 0
      } catch (error) {
        await io.writelnErr(`join: ${error instanceof Error ? error.message : 'Unknown error'}`)
        return 1
      } finally {
        writer.releaseLock()
      }
    }
  })
}
