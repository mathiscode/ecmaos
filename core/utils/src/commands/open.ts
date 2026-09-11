import path from 'path'
import chalk from 'chalk'
import type { Kernel, Shell, Terminal } from '@ecmaos/types'
import type { CommandContext, CommandIO } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'

function printUsage(io: CommandIO): void {
  const usage = `Usage: open [FILE|URL]
Open a file or URL.

  --help                   display this help and exit

Examples:
  open file.txt                    open a file in the current directory
  open /path/to/file.txt           open a file by absolute path
  open sample-1/sample-5 (1).jpg   open a file with spaces in the name
  open https://example.com         open a URL in a new tab`
  io.writelnErr(usage)
}

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'open',
    description: 'Open a file or URL',
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
        await io.writelnErr(`open: missing file or URL argument`)
        await io.writelnErr(`Try 'open --help' for more information.`)
        return 1
      }

      const filePath = ctx.argv.join(' ')

      if (!filePath) {
        await io.writelnErr(`open: missing file or URL argument`)
        return 1
      }

      // Check if it's a URL by looking for URL schemes
      const urlPattern = /^[a-zA-Z][a-zA-Z\d+\-.]*:/
      const isURL = urlPattern.test(filePath)

      if (isURL) {
        window.open(filePath, '_blank')
        return 0
      }

      // Treat as file path - resolve relative to current working directory
      const fullPath = path.resolve(shell.cwd, filePath)

      try {
        if (!(await shell.context.fs.promises.exists(fullPath))) {
          await io.writelnErr(chalk.red(`open: file not found: ${fullPath}`))
          return 1
        }

        const file = await shell.context.fs.promises.readFile(fullPath)
        const blob = new Blob([new Uint8Array(file)], { type: 'application/octet-stream' })
        const url = window.URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = path.basename(fullPath)
        a.click()
        window.URL.revokeObjectURL(url)
        return 0
      } catch (error) {
        await io.writelnErr(chalk.red(`open: ${error instanceof Error ? error.message : 'Unknown error'}`))
        return 1
      }
    }
  })
}
