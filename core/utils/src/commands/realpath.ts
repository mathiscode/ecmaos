import path from 'path'
import type { Kernel, Shell, Terminal } from '@ecmaos/types'
import type { CommandContext, CommandIO } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'

function printUsage(io: CommandIO): void {
  const usage = `Usage: realpath [OPTION]... FILE...
Print the resolved absolute file name.

  -e, --canonicalize-existing  all components of the path must exist
  -q, --quiet                  suppress most error messages
  --help                       display this help and exit`
  io.writelnErr(usage)
}

async function resolveRealPath(
  fs: typeof import('@zenfs/core').fs.promises,
  filePath: string,
  canonicalizeExisting: boolean,
  quiet: boolean
): Promise<string | null> {
  try {
    const resolved = path.resolve(filePath)
    
    if (canonicalizeExisting) {
      const exists = await fs.exists(resolved)
      if (!exists) {
        if (!quiet) {
          throw new Error('No such file or directory')
        }
        return null
      }
    }
    
    return resolved
  } catch (error) {
    if (!quiet) {
      throw error
    }
    return null
  }
}

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'realpath',
    description: 'Print the resolved absolute file name',
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

      let canonicalizeExisting = false
      let quiet = false
      const files: string[] = []

      for (const arg of ctx.argv) {
        if (!arg) continue

        if (arg === '--help' || arg === '-h') {
          printUsage(io)
          return 0
        } else if (arg === '-e' || arg === '--canonicalize-existing') {
          canonicalizeExisting = true
        } else if (arg === '-q' || arg === '--quiet') {
          quiet = true
        } else if (arg.startsWith('-')) {
          const flags = arg.slice(1).split('')
          if (flags.includes('e')) canonicalizeExisting = true
          if (flags.includes('q')) quiet = true
          const invalidFlags = flags.filter(f => !['e', 'q'].includes(f))
          if (invalidFlags.length > 0) {
            await io.writelnErr(`realpath: invalid option -- '${invalidFlags[0]}'`)
            await io.writelnErr("Try 'realpath --help' for more information.")
            return 1
          }
        } else {
          files.push(arg)
        }
      }

      if (files.length === 0) {
        await io.writelnErr('realpath: missing operand')
        await io.writelnErr("Try 'realpath --help' for more information.")
        return 1
      }

      let hasError = false

      for (const file of files) {
        const fullPath = path.resolve(shell.cwd, file)

        try {
          const resolved = await resolveRealPath(
            shell.context.fs.promises,
            fullPath,
            canonicalizeExisting,
            quiet
          )
          
          if (resolved !== null) {
            await io.writeln(resolved)
          } else {
            hasError = true
          }
        } catch (error) {
          if (!quiet) {
            const errorMessage = error instanceof Error ? error.message : String(error)
            await io.writelnErr(`realpath: ${file}: ${errorMessage}`)
          }
          hasError = true
        }
      }

      return hasError ? 1 : 0
    }
  })
}
