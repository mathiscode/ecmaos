import type { Kernel, Shell, Terminal } from '@ecmaos/types'
import type { CommandContext, CommandIO } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'

function printUsage(io: CommandIO): void {
  const usage = `Usage: set [-e|+e] [-u|+u] [-o pipefail|+o pipefail]
Configure shell options for the current shell.

  -e, +e           exit (or stop exiting) immediately if a command fails
  -u, +u           treat (or stop treating) unset variables as an error
  -o pipefail      (or +o pipefail) a pipeline fails if any stage fails, not just the last
  --help           display this help and exit`
  io.writelnErr(usage)
}

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'set',
    description: 'Configure shell options (-e, -u, -o pipefail)',
    kernel,
    shell,
    terminal,
    run: async (ctx: CommandContext, io: CommandIO) => {

      if (ctx.argv[0] === '--help' || ctx.argv[0] === '-h') {
        printUsage(io)
        return 0
      }

      for (let i = 0; i < ctx.argv.length; i++) {
        const arg = ctx.argv[i] as string

        if (arg === '-e') shell.applyShellOption('errexit', true)
        else if (arg === '+e') shell.applyShellOption('errexit', false)
        else if (arg === '-u') shell.applyShellOption('nounset', true)
        else if (arg === '+u') shell.applyShellOption('nounset', false)
        else if (arg === '-o' || arg === '+o') {
          const option = ctx.argv[++i]
          if (option !== 'pipefail') {
            await io.writelnErr(`set: unsupported option: ${option ?? '<missing>'}`)
            return 1
          }
          shell.applyShellOption('pipefail', arg === '-o')
        } else {
          await io.writelnErr(`set: unsupported option: ${arg}`)
          return 1
        }
      }

      return 0
    }
  })
}
