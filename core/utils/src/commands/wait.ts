import type { Kernel, Shell, Terminal } from '@ecmaos/types'
import type { CommandContext, CommandIO } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'

function printUsage(io: CommandIO): void {
  const usage = `Usage: wait [%JOBSPEC | PID]
Wait for a background job (or, with no argument, every currently tracked
background job) to finish. JOBSPEC may be %N, %%/%+, %-, or %name; a bare
number is matched against a job's underlying process id.

  --help  display this help and exit`
  io.writelnErr(usage)
}

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'wait',
    description: 'Wait for background job(s) to finish',
    kernel,
    shell,
    terminal,
    run: async (ctx: CommandContext, io: CommandIO) => {

      if (ctx.argv.includes('--help') || ctx.argv.includes('-h')) {
        printUsage(io)
        return 0
      }

      const spec = ctx.argv[0]
      if (spec && !shell.getJob(spec)) {
        await io.writelnErr(`wait: ${spec}: no such job or process`)
        return 1
      }

      const code = await shell.wait(spec)
      return code ?? 0
    }
  })
}
