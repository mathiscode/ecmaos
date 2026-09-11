import type { Kernel, Shell, Terminal } from '@ecmaos/types'
import type { CommandContext, CommandIO } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'

function printUsage(io: CommandIO): void {
  const usage = `Usage: load-crontab PATH SCOPE
Load and register crontab entries from PATH, replacing any previously loaded from that SCOPE.

  SCOPE  'system' or 'user'

  --help  display this help and exit

Examples:
  load-crontab /etc/crontab system
  load-crontab ~/.config/crontab user`
  io.writelnErr(usage)
}

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'load-crontab',
    description: 'Load and register crontab entries from a file',
    kernel,
    shell,
    terminal,
    run: async (ctx: CommandContext, io: CommandIO) => {

      if (ctx.argv.length === 0 || ctx.argv[0] === '--help' || ctx.argv[0] === '-h') {
        printUsage(io)
        return ctx.argv.length === 0 ? 1 : 0
      }

      const [rawPath, scope] = ctx.argv
      if (!rawPath || (scope !== 'system' && scope !== 'user')) {
        await io.writelnErr(`load-crontab: SCOPE must be 'system' or 'user'`)
        printUsage(io)
        return 1
      }

      const filePath = shell.expandTilde(rawPath)
      await kernel.loadCrontab(filePath, scope)
      return 0
    }
  })
}
