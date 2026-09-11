import path from 'path'
import type { Kernel, Shell, Terminal } from '@ecmaos/types'
import type { CommandContext, CommandIO } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'

function printUsage(io: CommandIO): void {
  const usage = `Usage: basename NAME [SUFFIX]
       basename OPTION... NAME...
Strip directory and suffix from filenames.

  -s, --suffix=SUFFIX  remove a trailing SUFFIX
  --help               display this help and exit`
  io.writelnErr(usage)
}

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'basename',
    description: 'Strip directory and suffix from filenames',
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

      let suffix: string | undefined
      const paths: string[] = []
      let i = 0

      while (i < ctx.argv.length) {
        const arg = ctx.argv[i]
        if (!arg) {
          i++
          continue
        }
        if (arg === '-s' || arg === '--suffix') {
          if (i + 1 < ctx.argv.length) {
            suffix = ctx.argv[++i]
          } else {
            await io.writelnErr('basename: option requires an argument -- \'s\'')
            return 1
          }
        } else if (arg.startsWith('--suffix=')) {
          suffix = arg.slice(9)
        } else if (arg.startsWith('-s')) {
          suffix = arg.slice(2)
        } else if (!arg.startsWith('-')) {
          paths.push(arg)
        }
        i++
      }

      if (paths.length === 0) {
        await io.writelnErr('basename: missing operand')
        return 1
      }

      const writer = io.stdout!.getWriter()

      try {
        for (const filePath of paths) {
          let basename = path.basename(filePath)
          
          if (suffix && basename.endsWith(suffix)) {
            basename = basename.slice(0, -suffix.length)
          }
          
          await writer.write(new TextEncoder().encode(basename + '\n'))
        }

        return 0
      } finally {
        writer.releaseLock()
      }
    }
  })
}
