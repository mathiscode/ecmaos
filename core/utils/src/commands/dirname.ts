import path from 'path'
import type { Kernel, Shell, Terminal } from '@ecmaos/types'
import type { CommandContext, CommandIO } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'

function printUsage(io: CommandIO): void {
  const usage = `Usage: dirname [OPTION] NAME...
Output each NAME with its last non-slash component and trailing slashes removed.

  --help  display this help and exit`
  io.writelnErr(usage)
}

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'dirname',
    description: 'Strip last component from file path',
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

      const paths: string[] = []
      for (const arg of ctx.argv) {
        if (arg !== '--help' && arg !== '-h' && !arg.startsWith('-')) {
          paths.push(arg)
        }
      }

      if (paths.length === 0) {
        await io.writelnErr('dirname: missing operand')
        return 1
      }

      const writer = io.stdout!.getWriter()

      try {
        for (const filePath of paths) {
          const dir = path.dirname(filePath)
          await writer.write(new TextEncoder().encode(dir + '\n'))
        }

        return 0
      } finally {
        writer.releaseLock()
      }
    }
  })
}
