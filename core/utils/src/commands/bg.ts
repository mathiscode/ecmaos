import type { Kernel, Shell, Terminal } from '@ecmaos/types'
import type { CommandContext, CommandIO } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'

function printUsage(io: CommandIO): void {
  const usage = `Usage: bg [%JOBSPEC]
Resume a stopped job in the background, without waiting for it. JOBSPEC
may be %N (job N), %% or %+ (most recent), %- (previous), or a name
prefix (%name). With no argument, resumes the most recently started job.

  --help  display this help and exit`
  io.writelnErr(usage)
}

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'bg',
    description: 'Resume a stopped job in the background',
    kernel,
    shell,
    terminal,
    run: async (ctx: CommandContext, io: CommandIO) => {

      if (ctx.argv.includes('--help') || ctx.argv.includes('-h')) {
        printUsage(io)
        return 0
      }

      const spec = ctx.argv[0]
      const job = shell.getJob(spec)
      if (!job) {
        await io.writelnErr(spec ? `bg: ${spec}: no such job` : 'bg: no current job')
        return 1
      }

      if (job.status !== 'stopped') {
        await io.writelnErr(`bg: job ${job.id} already in background`)
        return 1
      }

      shell.bg(spec)
      return 0
    }
  })
}
