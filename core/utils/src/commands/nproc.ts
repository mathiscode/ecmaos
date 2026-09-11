import type { Kernel, Shell, Terminal } from '@ecmaos/types'
import type { CommandContext, CommandIO } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'

function printUsage(io: CommandIO): void {
  const usage = `Usage: nproc
Print the number of processing units available.

  --help  display this help and exit`
  io.writelnErr(usage)
}

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'nproc',
    description: 'Print the number of processing units available',
    kernel,
    shell,
    terminal,
    run: async (ctx: CommandContext, io: CommandIO) => {
      if (ctx.argv.includes('--help') || ctx.argv.includes('-h')) {
        printUsage(io)
        return 0
      }

      // Same source /proc/cpuinfo uses (see filesystem.ts's generated /proc/cpuinfo), so the two
      // stay consistent with each other.
      const cores = navigator.hardwareConcurrency || 1
      await io.writeln(String(cores))

      return 0
    }
  })
}
