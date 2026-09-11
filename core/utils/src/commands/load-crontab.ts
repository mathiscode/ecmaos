import type { Kernel, Process, Shell, Terminal } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'
import { writelnStderr } from '../shared/helpers.js'

function printUsage(process: Process | undefined, terminal: Terminal): void {
  const usage = `Usage: load-crontab PATH SCOPE
Load and register crontab entries from PATH, replacing any previously loaded from that SCOPE.

  SCOPE  'system' or 'user'

  --help  display this help and exit

Examples:
  load-crontab /etc/crontab system
  load-crontab ~/.config/crontab user`
  writelnStderr(process, terminal, usage)
}

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'load-crontab',
    description: 'Load and register crontab entries from a file',
    kernel,
    shell,
    terminal,
    run: async (pid: number, argv: string[]) => {
      const process = kernel.processes.get(pid) as Process | undefined

      if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
        printUsage(process, terminal)
        return argv.length === 0 ? 1 : 0
      }

      const [rawPath, scope] = argv
      if (!rawPath || (scope !== 'system' && scope !== 'user')) {
        await writelnStderr(process, terminal, `load-crontab: SCOPE must be 'system' or 'user'`)
        printUsage(process, terminal)
        return 1
      }

      const filePath = shell.expandTilde(rawPath)
      await kernel.loadCrontab(filePath, scope)
      return 0
    }
  })
}
