import path from 'path'
import chalk from 'chalk'
import * as zipjs from '@zip.js/zip.js'
import type { Kernel, Shell, Terminal } from '@ecmaos/types'
import type { CommandContext, CommandIO } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'

function printUsage(io: CommandIO): void {
  const usage = `Usage: stat [OPTION]... FILE...
Display file or file system status.

  --help  display this help and exit`
  io.writelnErr(usage)
}

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'stat',
    description: 'Display information about a file or directory',
    kernel,
    shell,
    terminal,
    run: async (ctx: CommandContext, io: CommandIO) => {

      if (ctx.argv.length > 0 && (ctx.argv[0] === '--help' || ctx.argv[0] === '-h')) {
        printUsage(io)
        return 0
      }

      // Filter out options/flags and get target paths
      const targets = ctx.argv.length > 0 
        ? ctx.argv.filter(arg => !arg.startsWith('-'))
        : [shell.cwd]

      if (targets.length === 0) {
        targets.push(shell.cwd)
      }

      let hasError = false

      for (const target of targets) {
        const fullPath = path.resolve(shell.cwd, target)
        
        try {
          const stats = await shell.context.fs.promises.stat(fullPath)
          
          if (targets.length > 1) {
            await io.writeln(`${target}:`)
          }
          await io.writeln(JSON.stringify(stats, null, 2))

          const extension = path.extname(fullPath)
          if (extension === '.zip') {
            const blob = new Blob([new Uint8Array(await shell.context.fs.promises.readFile(fullPath))])
            const zipReader = new zipjs.ZipReader(new zipjs.BlobReader(blob))
            const entries = await zipReader.getEntries()
            await io.writeln(chalk.bold('\nZIP Entries:'))
            for (const entry of entries) {
              await io.writeln(`${chalk.blue(entry.filename)} (${entry.uncompressedSize} bytes)`)
            }
          }
          
          if (targets.length > 1) {
            await io.writeln('')
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          await io.writelnErr(`stat: ${target}: ${errorMessage}`)
          hasError = true
        }
      }

      return hasError ? 1 : 0
    }
  })
}
