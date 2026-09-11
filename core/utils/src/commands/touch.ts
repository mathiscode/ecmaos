import path from 'path'
import type { Kernel, Shell, Terminal } from '@ecmaos/types'
import type { CommandContext, CommandIO } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'

function printUsage(io: CommandIO): void {
  const usage = `Usage: touch [OPTION]... FILE...
Update the access and modification times of each FILE to the current time.

  --help  display this help and exit`
  io.writelnErr(usage)
}

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'touch',
    description: 'Create an empty file',
    kernel,
    shell,
    terminal,
    run: async (ctx: CommandContext, io: CommandIO) => {

      if (ctx.argv.length > 0 && (ctx.argv[0] === '--help' || ctx.argv[0] === '-h')) {
        printUsage(io)
        return 0
      }

      if (ctx.argv.length === 0) {
        await io.writelnErr('touch: missing file operand')
        await io.writelnErr("Try 'touch --help' for more information.")
        return 1
      }

      let hasError = false

      for (const target of ctx.argv) {
        if (!target || target.startsWith('-')) continue

        const fullPath = target ? path.resolve(shell.cwd, target) : shell.cwd
        
        try {
          await shell.context.fs.promises.appendFile(fullPath, '')
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          await io.writelnErr(`touch: ${target}: ${errorMessage}`)
          hasError = true
        }
      }

      return hasError ? 1 : 0
    }
  })
}
