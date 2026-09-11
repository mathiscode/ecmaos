import type { Kernel, Shell, Terminal } from '@ecmaos/types'
import type { CommandContext, CommandIO } from '@ecmaos/types'
import { TerminalEvents } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'

function printUsage(io: CommandIO): void {
  const usage = `Usage: sleep NUMBER[SUFFIX]...
Pause for NUMBER seconds.  SUFFIX may be 's' for seconds (the default),
'm' for minutes, 'h' for hours or 'd' for days.

  --help  display this help and exit`
  io.writelnErr(usage)
}

function parseDuration(value: string): number {
  const match = value.match(/^([0-9]+(?:\.[0-9]+)?)([smhd]?)$/)
  if (!match?.[1]) return NaN

  const num = parseFloat(match[1])
  if (isNaN(num)) return NaN

  const suffix = match[2] || 's'
  switch (suffix) {
    case 's':
      return num * 1000
    case 'm':
      return num * 60 * 1000
    case 'h':
      return num * 60 * 60 * 1000
    case 'd':
      return num * 24 * 60 * 60 * 1000
    default:
      return NaN
  }
}

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'sleep',
    description: 'Delay for a specified amount of time',
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

      if (ctx.argv.length === 0) {
        await io.writelnErr('sleep: missing operand')
        await io.writelnErr("Try 'sleep --help' for more information.")
        return 1
      }

      let totalDuration = 0

      for (const arg of ctx.argv) {
        if (!arg) continue

        if (arg === '--help' || arg === '-h') {
          printUsage(io)
          return 0
        } else if (arg.startsWith('-')) {
          await io.writelnErr(`sleep: invalid option -- '${arg.slice(1)}'`)
          await io.writelnErr("Try 'sleep --help' for more information.")
          return 1
        } else {
          const duration = parseDuration(arg)
          if (isNaN(duration)) {
            await io.writelnErr(`sleep: invalid time interval '${arg}'`)
            return 1
          }
          totalDuration += duration
        }
      }

      if (totalDuration <= 0) return 0

      let interrupted = false
      let interruptHandler: () => void = () => {}

      await new Promise<void>((resolve) => {
        const timeoutId = setTimeout(() => resolve(), totalDuration)

        // The interrupt can arrive at any point during the wait (`^C` is a real async event, not
        // something checked once) -- the handler itself must cancel the timer and resolve, rather
        // than just flipping a flag that nothing re-checks once the promise executor has returned.
        interruptHandler = () => {
          interrupted = true
          clearTimeout(timeoutId)
          resolve()
        }
        terminal.events.on(TerminalEvents.INTERRUPT, interruptHandler)
      })

      terminal.events.off(TerminalEvents.INTERRUPT, interruptHandler)

      return interrupted ? 130 : 0
    }
  })
}
