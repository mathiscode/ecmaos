import type { Kernel, Process, Shell, Terminal } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'
import { writelnStderr } from '../shared/helpers.js'

function printUsage(process: Process | undefined, terminal: Terminal): void {
  const usage = `Usage: local NAME[=VALUE]...
Declare one or more variables local to the current function call.

  --help  display this help and exit`
  writelnStderr(process, terminal, usage)
}

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'local',
    description: 'Declare a variable local to the current function call',
    kernel,
    shell,
    terminal,
    run: async (pid: number, argv: string[]) => {
      const process = kernel.processes.get(pid) as Process | undefined

      if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
        printUsage(process, terminal)
        return argv.length === 0 ? 1 : 0
      }

      try {
        for (const arg of argv) {
          const eq = arg.indexOf('=')
          if (eq === -1) shell.declareLocal(arg)
          else shell.declareLocal(arg.slice(0, eq), arg.slice(eq + 1))
        }
        return 0
      } catch (error) {
        await writelnStderr(process, terminal, `local: ${error instanceof Error ? error.message : String(error)}`)
        return 1
      }
    }
  })
}
