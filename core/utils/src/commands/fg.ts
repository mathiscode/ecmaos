import type { Kernel, Process, Shell, Terminal } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'
import { writelnStderr } from '../shared/helpers.js'

function printUsage(process: Process | undefined, terminal: Terminal): void {
  const usage = `Usage: fg [%JOBSPEC]
Resume a stopped or backgrounded job in the foreground and wait for it.
JOBSPEC may be %N (job N), %% or %+ (most recent), %- (previous), or a
name prefix (%name). With no argument, resumes the most recently started
job.

  --help  display this help and exit`
  writelnStderr(process, terminal, usage)
}

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'fg',
    description: 'Resume a job in the foreground',
    kernel,
    shell,
    terminal,
    run: async (pid: number, argv: string[]) => {
      const process = kernel.processes.get(pid) as Process | undefined

      if (argv.includes('--help') || argv.includes('-h')) {
        printUsage(process, terminal)
        return 0
      }

      const spec = argv[0]
      if (spec && !shell.getJob(spec)) {
        await writelnStderr(process, terminal, `fg: ${spec}: no such job`)
        return 1
      }

      if (!spec && !shell.getJob()) {
        await writelnStderr(process, terminal, 'fg: no current job')
        return 1
      }

      const code = await shell.fg(spec)
      return code ?? 1
    }
  })
}
