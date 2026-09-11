import path from 'path'
import chalk from 'chalk'
import type { Kernel, Shell, Terminal } from '@ecmaos/types'
import type { CommandContext, CommandIO } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'

function printUsage(io: CommandIO): void {
  const usage = `Usage: mv [OPTION]... SOURCE... DEST
Rename SOURCE to DEST, or move SOURCE(s) to DIRECTORY.

  --help  display this help and exit`
  io.writelnErr(usage)
}

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'mv',
    description: 'Move or rename files',
    kernel,
    shell,
    terminal,
    run: async (ctx: CommandContext, io: CommandIO) => {

      if (ctx.argv.length > 0 && (ctx.argv[0] === '--help' || ctx.argv[0] === '-h')) {
        printUsage(io)
        return 0
      }

      const args: string[] = []
      for (const arg of ctx.argv) {
        if (arg && !arg.startsWith('-')) {
          args.push(arg)
        }
      }

      if (args.length < 2) {
        await io.writelnErr(chalk.red('Usage: mv <source> <destination>'))
        return 1
      }

      const sourceInput = args[0]
      const destinationInput = args[args.length - 1]

      if (!sourceInput || !destinationInput) {
        await io.writelnErr(chalk.red('Usage: mv <source> <destination>'))
        return 1
      }

      const source = path.resolve(shell.cwd, sourceInput)
      let destination = path.resolve(shell.cwd, destinationInput)

      if (source === destination) return 0
      const disallowedPaths = ['/dev', '/proc', '/sys', '/run']
      if (disallowedPaths.some(path => source.startsWith(path) || destination.startsWith(path))) {
        await io.writelnErr(chalk.red('Cannot move disallowed paths'))
        return 2
      }

      if (await shell.context.fs.promises.exists(destination)) {
        if ((await shell.context.fs.promises.stat(destination)).isDirectory()) {
          destination = path.resolve(destination, path.basename(source))
        } else {
          await io.writelnErr(chalk.red(`${destination} already exists`))
          return 1
        }
      }

      await shell.context.fs.promises.rename(source, destination)
      return 0
    }
  })
}
