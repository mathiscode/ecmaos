import type { Kernel, Shell, Terminal } from '@ecmaos/types'
import type { CommandContext, CommandIO } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'

function printUsage(io: CommandIO): void {
  const usage = `Usage: local NAME[=VALUE]...
Declare one or more variables local to the current function call.

  --help  display this help and exit`
  io.writelnErr(usage)
}

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'local',
    description: 'Declare a variable local to the current function call',
    kernel,
    shell,
    terminal,
    run: async (ctx: CommandContext, io: CommandIO) => {

      if (ctx.argv.length === 0 || ctx.argv[0] === '--help' || ctx.argv[0] === '-h') {
        printUsage(io)
        return ctx.argv.length === 0 ? 1 : 0
      }

      try {
        for (const arg of ctx.argv) {
          const eq = arg.indexOf('=')
          if (eq === -1) shell.declareLocal(arg)
          else shell.declareLocal(arg.slice(0, eq), arg.slice(eq + 1))
        }
        return 0
      } catch (error) {
        await io.writelnErr(`local: ${error instanceof Error ? error.message : String(error)}`)
        return 1
      }
    }
  })
}
