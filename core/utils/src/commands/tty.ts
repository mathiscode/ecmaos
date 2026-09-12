import type { Kernel, Shell, Terminal } from '@ecmaos/types'
import type { CommandContext, CommandIO } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'

function printUsage(io: CommandIO): void {
  const usage = `Usage: tty [TTY_NUMBER]
Print the current TTY number or switch to a different TTY.

  TTY_NUMBER    switch to the specified TTY (0-7)
  --help        display this help and exit

If no TTY_NUMBER is provided, prints the current TTY number.
If TTY_NUMBER is provided, switches to that TTY.`
  io.writelnErr(usage)
}

export const meta = { command: 'tty', description: 'Print the current TTY number or switch to a different TTY' } as const

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    ...meta,
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
        await io.writeln(kernel.activeTty.toString())
        return 0
      }

      if (ctx.argv.length > 1) {
        await io.writelnErr('tty: too many arguments')
        await io.writelnErr("Try 'tty --help' for more information.")
        return 1
      }

      const ttyNumber = parseInt(ctx.argv[0] ?? '0', 10)

      if (isNaN(ttyNumber)) {
        await io.writelnErr(`tty: invalid TTY number '${ctx.argv[0]}'`)
        await io.writelnErr("Try 'tty --help' for more information.")
        return 1
      }

      if (ttyNumber < 0 || ttyNumber > 7) {
        await io.writelnErr(`tty: TTY number must be between 0 and 7`)
        await io.writelnErr("Try 'tty --help' for more information.")
        return 1
      }

      try {
        await kernel.switchTty(ttyNumber)
        return 0
      } catch (error) {
        await io.writelnErr(`tty: failed to switch to TTY ${ttyNumber}: ${error instanceof Error ? error.message : String(error)}`)
        return 1
      }
    }
  })
}
