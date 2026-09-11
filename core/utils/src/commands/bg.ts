import type { Kernel, Process, Shell, Terminal } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'
import { writelnStderr } from '../shared/helpers.js'

function printUsage(process: Process | undefined, terminal: Terminal): void {
  const usage = `Usage: bg [%JOBSPEC]
Resume a stopped job in the background, without waiting for it. JOBSPEC
may be %N (job N), %% or %+ (most recent), %- (previous), or a name
prefix (%name). With no argument, resumes the most recently started job.

  --help  display this help and exit`
  writelnStderr(process, terminal, usage)
}

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'bg',
    description: 'Resume a stopped job in the background',
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
      const job = shell.getJob(spec)
      if (!job) {
        await writelnStderr(process, terminal, spec ? `bg: ${spec}: no such job` : 'bg: no current job')
        return 1
      }

      if (job.status !== 'stopped') {
        await writelnStderr(process, terminal, `bg: job ${job.id} already in background`)
        return 1
      }

      shell.bg(spec)
      return 0
    }
  })
}
