import type { CommandContext, CommandIO, Job, Kernel, Shell, Terminal } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'

function printUsage(io: CommandIO): void {
  const usage = `Usage: jobs [-l]
List the shell's tracked background/foreground jobs.

  -l     also show each job's underlying process id(s)
  --help display this help and exit`
  io.writelnErr(usage)
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
    run: async (ctx: CommandContext, io: CommandIO) => {
      if (ctx.argv.includes('--help') || ctx.argv.includes('-h')) {
        printUsage(io)
        return 0
      }

      const showPids = ctx.argv.includes('-l')
      // Shell.listJobs() returns every pipeline this shell has ever run, including plain foreground
      // commands that already ran to completion (per its own doc comment, callers are expected to
      // filter for display) -- a real shell's `jobs` only shows jobs that were backgrounded OR are
      // currently stopped (a `^Z`-suspended foreground job is very much a job worth listing, even
      // though it was never launched with `&`), so filter down to those.
      const jobs = shell.listJobs().filter(job => job.background || job.status === 'stopped')
      if (jobs.length === 0) return 0

      const mostRecentId = jobs[jobs.length - 1]?.id
      const previousId = jobs.length > 1 ? jobs[jobs.length - 2]?.id : undefined

      for (const job of jobs) {
        const marker = job.id === mostRecentId ? '+' : job.id === previousId ? '-' : ' '
        const pids = showPids && job.processes.length > 0 ? ` (${job.processes.map(p => p.pid).join(', ')})` : ''
        const suffix = job.background ? ' &' : ''
        await io.writeln(`[${job.id}]${marker}  ${statusLabel(job).padEnd(24)}${job.commandLine}${suffix}${pids}`)
      }

      return 0
    }
  })
}
