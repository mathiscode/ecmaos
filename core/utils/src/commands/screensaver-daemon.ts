import type { Kernel, Shell, Terminal } from '@ecmaos/types'
import type { CommandContext, CommandIO } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'

function printUsage(io: CommandIO): void {
  const usage = `Usage: screensaver-daemon
Start the idle-timeout screensaver daemon: shows the configured screensaver
(the "screensaver" storage setting, default 'matrix') after a period of no
user activity (the "screensaver-timeout" storage setting in ms, default 60000).

  --help  display this help and exit

This registers global activity listeners and returns immediately -- there is
no per-process "daemon" to keep alive here, the same way starting it inline
during boot() never needed one either.`
  io.writelnErr(usage)
}

export const meta = { command: 'screensaver-daemon', description: 'Start the idle-timeout screensaver daemon' } as const

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    ...meta,
    kernel,
    shell,
    terminal,
    run: async (ctx: CommandContext, io: CommandIO) => {

      if (ctx.argv.length > 0 && (ctx.argv[0] === '--help' || ctx.argv[0] === '-h')) {
        printUsage(io)
        return 0
      }

      const stop = kernel.startScreensaverDaemon()
      if (!stop) {
        await io.writelnErr('screensaver-daemon: no such screensaver configured')
        return 1
      }

      // Quiet on success, like a real Unix daemon -- this runs unconditionally as the last line of
      // /boot/init on every boot, so a confirmation line here was really just boot noise.
      return 0
    }
  })
}
