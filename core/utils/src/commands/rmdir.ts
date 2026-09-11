import path from 'path'
import type { Kernel, Shell, Terminal } from '@ecmaos/types'
import type { CommandContext, CommandIO } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'

function printUsage(io: CommandIO): void {
  const usage = `Usage: rmdir [OPTION]... DIRECTORY...
Remove the DIRECTORY(ies), if they are empty.

  --help  display this help and exit`
  io.writelnErr(usage)
}

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'rmdir',
    description: 'Remove a directory',
    kernel,
    shell,
    terminal,
    run: async (ctx: CommandContext, io: CommandIO) => {

      if (ctx.argv.length > 0 && (ctx.argv[0] === '--help' || ctx.argv[0] === '-h')) {
        printUsage(io)
        return 0
      }

      if (ctx.argv.length === 0) {
        await io.writelnErr('rmdir: missing operand')
        await io.writelnErr("Try 'rmdir --help' for more information.")
        return 1
      }

      let hasError = false

      for (const target of ctx.argv) {
        if (!target || target.startsWith('-')) continue

        const fullPath = target ? path.resolve(shell.cwd, target) : shell.cwd
        
        try {
          await shell.context.fs.promises.rm(fullPath, { recursive: true, force: true })
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          await io.writelnErr(`rmdir: ${target}: ${errorMessage}`)
          hasError = true
        }
      }

      return hasError ? 1 : 0
    }
  })
}
