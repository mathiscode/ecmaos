import type { Kernel, Shell, Terminal } from '@ecmaos/types'
import type { CommandContext, CommandIO } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'

function printUsage(io: CommandIO): void {
  const usage = `Usage: fg [%JOBSPEC]
Resume a stopped or backgrounded job in the foreground and wait for it.
JOBSPEC may be %N (job N), %% or %+ (most recent), %- (previous), or a
name prefix (%name). With no argument, resumes the most recently started
job.

  --help  display this help and exit`
  io.writelnErr(usage)
}

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'fg',
    description: 'Resume a job in the foreground',
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
        await io.writelnErr(`fg: ${spec}: no such job`)
        return 1
      }

      if (!spec && !shell.getJob()) {
        await io.writelnErr('fg: no current job')
        return 1
      }

      const code = await shell.fg(spec)
      return code ?? 1
    }
  })
}
