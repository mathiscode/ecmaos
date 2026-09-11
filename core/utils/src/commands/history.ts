import path from 'path'
import type { Kernel, Shell, Terminal } from '@ecmaos/types'
import type { CommandContext, CommandIO } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'

function printUsage(io: CommandIO): void {
  const usage = `Usage: history [OPTION]... [N]
Display or manipulate the command history.

  N              display the last N entries
  -c             clear the history list
  -d N           delete the history entry at position N
  -r             reload the history file (useful after manual edits)
  --help         display this help and exit

If N is provided without options, display the last N entries.
If no arguments are provided, display all history entries.

Note: History is automatically saved on each command execution.`
  io.writelnErr(usage)
}

async function readHistoryFile(shell: Shell, kernel: Kernel): Promise<string[]> {
  const home = shell.env.get('HOME') || '/root'
  const historyPath = path.join(home, '.history')

  try {
    if (!kernel.filesystem?.fs) {
      return []
    }

    const exists = await kernel.filesystem.fs.exists(historyPath)
    if (!exists) {
      return []
    }

    const content = await kernel.filesystem.fs.readFile(historyPath, 'utf-8')
    const lines = content.split('\n').filter(line => line.length > 0)
    return lines
  } catch {
    return []
  }
}

async function writeHistoryFile(shell: Shell, kernel: Kernel, lines: string[]): Promise<void> {
  const home = shell.env.get('HOME') || '/root'
  const historyPath = path.join(home, '.history')

  if (!kernel.filesystem?.fs) {
    throw new Error('Filesystem not available')
  }

  const content = lines.join('\n')
  await kernel.filesystem.fs.writeFile(historyPath, content, 'utf-8')
}

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'history',
    description: 'Display or manipulate the command history',
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

      const writer = io.stdout!.getWriter()

      try {
        let clearHistory = false
        let deleteIndex: number | null = null
        let readHistory = false
        let numEntries: number | null = null

        for (let i = 0; i < ctx.argv.length; i++) {
          const arg = ctx.argv[i]
          if (!arg) continue

          if (arg === '-c') {
            clearHistory = true
          } else if (arg === '-r') {
            readHistory = true
          } else if (arg === '-d') {
            if (i + 1 < ctx.argv.length) {
              i++
              const nextArg = ctx.argv[i]
              if (nextArg !== undefined) {
                const index = parseInt(nextArg, 10)
                if (!isNaN(index)) {
                  deleteIndex = index
                } else {
                  await io.writelnErr(`history: invalid history number '${nextArg}'`)
                  return 1
                }
              }
            } else {
              await io.writelnErr('history: -d requires a history number')
              return 1
            }
          } else if (!arg.startsWith('-')) {
            const num = parseInt(arg, 10)
            if (!isNaN(num)) {
              numEntries = num
            }
          }
        }

        if (clearHistory) {
          const uid = shell.credentials.uid
          await terminal.clearHistory(uid)
          return 0
        }

        if (deleteIndex !== null) {
          const lines = await readHistoryFile(shell, kernel)
          if (deleteIndex < 1 || deleteIndex > lines.length) {
            await io.writelnErr(`history: history number '${deleteIndex}' out of range`)
            return 1
          }
          const newLines = lines.filter((_, index) => index !== deleteIndex - 1)
          await writeHistoryFile(shell, kernel, newLines)
          
          const uid = shell.credentials.uid
          await terminal.reloadHistory(uid).catch(() => {})
          return 0
        }

        if (readHistory) {
          const uid = shell.credentials.uid
          await terminal.reloadHistory(uid).catch(() => {})
          return 0
        }

        const lines = await readHistoryFile(shell, kernel)
        
        if (lines.length === 0) {
          return 0
        }

        const displayLines = numEntries !== null 
          ? lines.slice(-numEntries)
          : lines

        const startIndex = numEntries !== null 
          ? lines.length - numEntries + 1
          : 1

        for (let i = 0; i < displayLines.length; i++) {
          const lineNumber = startIndex + i
          const line = displayLines[i]
          const output = `  ${lineNumber}  ${line}\n`
          await writer.write(new TextEncoder().encode(output))
        }

        return 0
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        await io.writelnErr(`history: ${errorMessage}`)
        return 1
      } finally {
        writer.releaseLock()
      }
    }
  })
}
