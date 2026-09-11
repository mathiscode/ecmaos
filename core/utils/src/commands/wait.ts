import type { Kernel, Process, Shell, Terminal } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'
import { writelnStderr } from '../shared/helpers.js'

function printUsage(process: Process | undefined, terminal: Terminal): void {
  const usage = `Usage: wait [%JOBSPEC | PID]
Wait for a background job (or, with no argument, every currently tracked
background job) to finish. JOBSPEC may be %N, %%/%+, %-, or %name; a bare
number is matched against a job's underlying process id.

  --help  display this help and exit`
  writelnStderr(process, terminal, usage)
}

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'wait',
    description: 'Wait for background job(s) to finish',
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
        await writelnStderr(process, terminal, `wait: ${spec}: no such job or process`)
        return 1
      }

      const code = await shell.wait(spec)
      return code ?? 0
    }
  })
}
