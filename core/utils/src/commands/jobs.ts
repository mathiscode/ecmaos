import type { Job, Kernel, Process, Shell, Terminal } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'
import { writelnStdout, writelnStderr } from '../shared/helpers.js'

function printUsage(process: Process | undefined, terminal: Terminal): void {
  const usage = `Usage: jobs [-l]
List the shell's tracked background/foreground jobs.

  -l     also show each job's underlying process id(s)
  --help display this help and exit`
  writelnStderr(process, terminal, usage)
}

/** bash-style status label: `Running`, `Stopped`, or `Done`. */
function statusLabel(job: Job): string {
  switch (job.status) {
    case 'running': return 'Running'
    case 'stopped': return 'Stopped'
    case 'done': return `Done${job.exitCodes && job.exitCodes.some(code => code !== 0) ? `(${job.exitCodes[job.exitCodes.length - 1]})` : ''}`
  }
}

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'jobs',
    description: "List the shell's tracked jobs",
    kernel,
    shell,
    terminal,
    run: async (pid: number, argv: string[]) => {
      const process = kernel.processes.get(pid) as Process | undefined

      if (argv.includes('--help') || argv.includes('-h')) {
        printUsage(process, terminal)
        return 0
      }

      const showPids = argv.includes('-l')
      const jobs = shell.listJobs()
      if (jobs.length === 0) return 0

      const mostRecentId = jobs[jobs.length - 1]?.id
      const previousId = jobs.length > 1 ? jobs[jobs.length - 2]?.id : undefined

      for (const job of jobs) {
        const marker = job.id === mostRecentId ? '+' : job.id === previousId ? '-' : ' '
        const pids = showPids && job.processes.length > 0 ? ` (${job.processes.map(p => p.pid).join(', ')})` : ''
        const suffix = job.background ? ' &' : ''
        await writelnStdout(process, terminal, `[${job.id}]${marker}  ${statusLabel(job).padEnd(24)}${job.commandLine}${suffix}${pids}`)
      }

      return 0
    }
  })
}
