import path from 'path'
import type { Kernel, Shell, Terminal } from '@ecmaos/types'
import type { CommandContext, CommandIO } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'

function printUsage(io: CommandIO): void {
  const usage = `Usage: cd [DIRECTORY]
Change the shell working directory.

  DIRECTORY  the directory to change to (default: $HOME)
  --help     display this help and exit`
  io.writelnErr(usage)
}

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'cd',
    description: 'Change the shell working directory',
    kernel,
    shell,
    terminal,
    run: async (ctx: CommandContext, io: CommandIO) => {
      const process = ctx.process

      if (ctx.argv.length > 0 && (ctx.argv[0] === '--help' || ctx.argv[0] === '-h')) {
        printUsage(io)
        return 0
      }

      const destination = ctx.argv.length > 0 && ctx.argv[0] && !ctx.argv[0].startsWith('-') ? ctx.argv[0] : shell.cwd
      const fullPath = destination ? path.resolve(shell.cwd, destination) : shell.cwd
      
      try {
        await shell.context.fs.promises.access(fullPath)
        shell.cwd = fullPath
        localStorage.setItem(`cwd:${shell.credentials.uid}`, fullPath)
        return 0
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        if (process) {
          const writer = io.stderr!.getWriter()
          try {
            await writer.write(new TextEncoder().encode(`cd: ${destination}: ${errorMessage}\n`))
          } finally {
            writer.releaseLock()
          }
        } else {
          terminal.write(`cd: ${destination}: ${errorMessage}\n`)
        }
        return 1
      }
    }
  })
}
