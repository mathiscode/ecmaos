import path from 'path'
import chalk from 'chalk'
import type { Kernel, Shell, Terminal } from '@ecmaos/types'
import type { CommandContext, CommandIO } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'

function printUsage(io: CommandIO): void {
  const usage = `Usage: umount [OPTIONS] TARGET
       umount [-a|--all]

Unmount a filesystem.

Options:
  -a, --all    unmount all filesystems (except root)
  --help       display this help and exit

Examples:
  umount /mnt/tmp        unmount filesystem at /mnt/tmp
  umount -a              unmount all filesystems`
  io.writelnErr(usage)
}

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'umount',
    description: 'Unmount a filesystem',
    kernel,
    shell,
    terminal,
    run: async (ctx: CommandContext, io: CommandIO) => {

      if (ctx.argv.length > 0 && (ctx.argv[0] === '--help' || ctx.argv[0] === '-h')) {
        printUsage(io)
        return 0
      }

      let allMode = false
      const positionalArgs: string[] = []

      for (let i = 0; i < ctx.argv.length; i++) {
        const arg = ctx.argv[i]
        if (arg === '-a' || arg === '--all') {
          allMode = true
        } else if (arg && !arg.startsWith('-')) {
          positionalArgs.push(arg)
        }
      }


      if (allMode) {
        const mountList = Array.from(kernel.filesystem.mounts.keys())
        let unmountedCount = 0
        let errorCount = 0

        for (const target of mountList) {
          if (target === '/') continue

          try {
            kernel.filesystem.fsSync.umount(target)
            unmountedCount++
            await io.writeln(chalk.green(`Unmounted ${target}`))
          } catch (error) {
            errorCount++
            await io.writelnErr(chalk.red(`umount: failed to unmount ${target}: ${error instanceof Error ? error.message : 'Unknown error'}`))
          }
        }

        if (unmountedCount === 0 && errorCount === 0) {
          await io.writeln('No filesystems to unmount.')
        }

        return errorCount > 0 ? 1 : 0
      }

      if (positionalArgs.length === 0) {
        await io.writelnErr(chalk.red('umount: missing target argument'))
        await io.writelnErr('Try \'umount --help\' for more information.')
        return 1
      }

      if (positionalArgs.length > 1) {
        await io.writelnErr(chalk.red('umount: too many arguments'))
        await io.writelnErr('Try \'umount --help\' for more information.')
        return 1
      }

      const targetArg = positionalArgs[0]
      if (!targetArg) {
        await io.writelnErr(chalk.red('umount: missing target argument'))
        return 1
      }
      const target = path.resolve(shell.cwd, targetArg)

      if (target === '/') {
        await io.writelnErr(chalk.red('umount: cannot unmount root filesystem'))
        return 1
      }

      const mountList = Array.from(kernel.filesystem.mounts.keys())
      if (!mountList.includes(target)) {
        await io.writelnErr(chalk.red(`umount: ${target} is not mounted`))
        return 1
      }

      try {
        kernel.filesystem.fsSync.umount(target)
        await io.writeln(chalk.green(`Unmounted ${target}`))
        return 0
      } catch (error) {
        await io.writelnErr(chalk.red(`umount: failed to unmount ${target}: ${error instanceof Error ? error.message : 'Unknown error'}`))
        return 1
      }
    }
  })
}
