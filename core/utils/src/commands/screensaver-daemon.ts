import type { Kernel, Process, Shell, Terminal } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'
import { writelnStderr, writelnStdout } from '../shared/helpers.js'

function printUsage(process: Process | undefined, terminal: Terminal): void {
  const usage = `Usage: screensaver-daemon
Start the idle-timeout screensaver daemon: shows the configured screensaver
(the "screensaver" storage setting, default 'matrix') after a period of no
user activity (the "screensaver-timeout" storage setting in ms, default 60000).

  --help  display this help and exit

This registers global activity listeners and returns immediately -- there is
no per-process "daemon" to keep alive here, the same way starting it inline
during boot() never needed one either.`
  writelnStderr(process, terminal, usage)
}

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'screensaver-daemon',
    description: 'Start the idle-timeout screensaver daemon',
    kernel,
    shell,
    terminal,
    run: async (pid: number, argv: string[]) => {
      const process = kernel.processes.get(pid) as Process | undefined

      if (argv.length > 0 && (argv[0] === '--help' || argv[0] === '-h')) {
        printUsage(process, terminal)
        return 0
      }

      const stop = kernel.startScreensaverDaemon()
      if (!stop) {
        await writelnStderr(process, terminal, 'screensaver-daemon: no such screensaver configured')
        return 1
      }

      await writelnStdout(process, terminal, 'screensaver-daemon: watching for idle activity')
      return 0
    }
  })
}
