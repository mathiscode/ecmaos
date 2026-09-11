import type { Kernel, Shell, Terminal } from '@ecmaos/types'
import type { CommandContext, CommandIO } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'

function printUsage(io: CommandIO): void {
  const usage = `Usage: uptime
Print how long the system has been running.

  --help  display this help and exit`
  io.writelnErr(usage)
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)

  const parts: string[] = []
  if (days > 0) {
    parts.push(`${days} day${days !== 1 ? 's' : ''}`)
  }
  if (hours > 0) {
    parts.push(`${hours} hour${hours !== 1 ? 's' : ''}`)
  }
  if (minutes > 0) {
    parts.push(`${minutes} minute${minutes !== 1 ? 's' : ''}`)
  }
  if (secs > 0 || parts.length === 0) {
    parts.push(`${secs} second${secs !== 1 ? 's' : ''}`)
  }

  return parts.join(', ')
}

function getUptimeSeconds(): number {
  return performance.now() / 1000
}

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'uptime',
    description: 'Print how long the system has been running',
    kernel,
    shell,
    terminal,
    run: async (ctx: CommandContext, io: CommandIO) => {
      const process = ctx.process

      if (!process) return 1

      if (ctx.argv.length > 0 && (ctx.argv[0] === '--help' || ctx.argv[0] === '-h')) {
        printUsage(io)
        return 0
      }

      if (ctx.argv.length > 0 && ctx.argv[0] !== '--help' && ctx.argv[0] !== '-h') {
        await io.writelnErr(`uptime: extra operand '${ctx.argv[0]}'`)
        await io.writelnErr("Try 'uptime --help' for more information.")
        return 1
      }

      const uptimeSeconds = getUptimeSeconds()
      const uptimeString = formatUptime(uptimeSeconds)
      const now = new Date()
      
      const output = ` ${now.toLocaleTimeString()} up ${uptimeString}`
      await io.writeln(output)

      return 0
    }
  })
}
