import path from 'path'
import type { Kernel, Shell, Terminal } from '@ecmaos/types'
import type { CommandContext, CommandIO } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'

function printUsage(io: CommandIO): void {
  const usage = `Usage: which [COMMAND]...
Locate a command.

  COMMAND  the command(s) to locate
  --help  display this help and exit`
  io.writelnErr(usage)
}

export const meta = { command: 'which', description: 'Locate a command' } as const

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

      const commands: string[] = []
      for (const arg of ctx.argv) {
        if (arg !== '--help' && arg !== '-h' && !arg.startsWith('-')) {
          commands.push(arg)
        }
      }

      if (commands.length === 0) {
        await io.writelnErr('which: missing command name')
        return 1
      }

      const writer = io.stdout!.getWriter()
      let exitCode = 0

      const resolveCommand = async (command: string): Promise<string | undefined> => {
        if (command.startsWith('./')) {
          const cwdCommand = path.join(shell.cwd, command.slice(2))
          if (await shell.context.fs.promises.exists(cwdCommand)) {
            return cwdCommand
          }
          return undefined
        }

        const paths = shell.env.get('PATH')?.split(':') || ['/bin', '/usr/bin', '/usr/local/bin']
        const resolvedCommand = path.resolve(command)

        if (await shell.context.fs.promises.exists(resolvedCommand)) {
          return resolvedCommand
        }

        for (const pathDir of paths) {
          const expandedPath = pathDir.replace(/\$([A-Z_]+)/g, (_, name) => shell.env.get(name) || '')
          const fullPath = `${expandedPath}/${command}`
          if (await shell.context.fs.promises.exists(fullPath)) return fullPath
        }

        return undefined
      }

      try {
        for (const cmd of commands) {
          const commandPath = await resolveCommand(cmd)
          
          if (commandPath) {
            await writer.write(new TextEncoder().encode(commandPath + '\n'))
          } else {
            exitCode = 1
          }
        }

        return exitCode
      } finally {
        writer.releaseLock()
      }
    }
  })
}
