import path from 'path'
import type { Kernel, Shell, Terminal } from '@ecmaos/types'
import type { CommandContext, CommandIO } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'

function printUsage(io: CommandIO): void {
  const usage = `Usage: test EXPRESSION
       test [OPTION]
Check file types and compare values.

  -f FILE     FILE exists and is a regular file
  -d FILE     FILE exists and is a directory
  -e FILE     FILE exists
  -r FILE     FILE exists and is readable
  -w FILE     FILE exists and is writable
  -x FILE     FILE exists and is executable
  -n STRING   STRING is not empty
  -z STRING   STRING is empty (zero length)
  STRING1 = STRING2   strings are equal
  STRING1 != STRING2  strings are not equal
  NUM1 -eq NUM2   NUM1 is equal to NUM2
  NUM1 -ne NUM2   NUM1 is not equal to NUM2
  NUM1 -lt NUM2   NUM1 is less than NUM2
  NUM1 -le NUM2   NUM1 is less than or equal to NUM2
  NUM1 -gt NUM2   NUM1 is greater than NUM2
  NUM1 -ge NUM2   NUM1 is greater than or equal to NUM2
  --help      display this help and exit`
  io.writelnErr(usage)
}

export const meta = { command: 'test', description: 'Check file types and compare values' } as const

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    ...meta,
    kernel,
    shell,
    terminal,
    run: async (ctx: CommandContext, io: CommandIO) => {

      if (ctx.argv.length > 0 && (ctx.argv[0] === '--help' || ctx.argv[0] === '-h')) {
        printUsage(io)
        return 0
      }

      const checkFile = async (filePath: string, check: string): Promise<boolean> => {
        const fullPath = path.resolve(shell.cwd, filePath)

        try {
          const stat = await shell.context.fs.promises.stat(fullPath)

          switch (check) {
            case 'f':
              return stat.isFile()
            case 'd':
              return stat.isDirectory()
            case 'e':
              return true
            case 'r':
            case 'w':
            case 'x':
              return true
            default:
              return false
          }
        } catch {
          return false
        }
      }

      if (ctx.argv.length === 0) {
        return 1
      }

      const operator = ctx.argv[0]

      if (operator === '-f' && ctx.argv[1]) {
        return (await checkFile(ctx.argv[1], 'f')) ? 0 : 1
      }

      if (operator === '-d' && ctx.argv[1]) {
        return (await checkFile(ctx.argv[1], 'd')) ? 0 : 1
      }

      if (operator === '-e' && ctx.argv[1]) {
        return (await checkFile(ctx.argv[1], 'e')) ? 0 : 1
      }

      if (operator === '-r' && ctx.argv[1]) {
        return (await checkFile(ctx.argv[1], 'r')) ? 0 : 1
      }

      if (operator === '-w' && ctx.argv[1]) {
        return (await checkFile(ctx.argv[1], 'w')) ? 0 : 1
      }

      if (operator === '-x' && ctx.argv[1]) {
        return (await checkFile(ctx.argv[1], 'x')) ? 0 : 1
      }

      if (operator === '-n' && ctx.argv.length > 1) {
        return (ctx.argv[1]?.length ?? 0) > 0 ? 0 : 1
      }

      if (operator === '-z' && ctx.argv.length > 1) {
        return (ctx.argv[1]?.length ?? 0) === 0 ? 0 : 1
      }

      if (ctx.argv.length === 3) {
        const [left, op, right] = ctx.argv as [string, string, string]
        switch (op) {
          case '=': return left === right ? 0 : 1
          case '!=': return left !== right ? 0 : 1
          case '-eq': return Number(left) === Number(right) ? 0 : 1
          case '-ne': return Number(left) !== Number(right) ? 0 : 1
          case '-lt': return Number(left) < Number(right) ? 0 : 1
          case '-le': return Number(left) <= Number(right) ? 0 : 1
          case '-gt': return Number(left) > Number(right) ? 0 : 1
          case '-ge': return Number(left) >= Number(right) ? 0 : 1
        }
      }

      return 1
    }
  })
}
