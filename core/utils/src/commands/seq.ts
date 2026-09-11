import type { Kernel, Shell, Terminal } from '@ecmaos/types'
import type { CommandContext, CommandIO } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'

function printUsage(io: CommandIO): void {
  const usage = `Usage: seq [OPTION]... LAST
       seq [OPTION]... FIRST LAST
       seq [OPTION]... FIRST INCREMENT LAST
Print numbers from FIRST to LAST, in steps of INCREMENT.

  -s, --separator=STRING   use STRING to separate numbers (default: \\n)
  --help                    display this help and exit`
  io.writelnErr(usage)
}

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'seq',
    description: 'Print a sequence of numbers',
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

      let separator = '\n'
      const args: string[] = []

      for (let i = 0; i < ctx.argv.length; i++) {
        const arg = ctx.argv[i]
        if (!arg) continue
        if (arg === '--help' || arg === '-h') {
          printUsage(io)
          return 0
        } else if (arg === '-s' || arg === '--separator') {
          if (i + 1 < ctx.argv.length) {
            const nextArg = ctx.argv[++i]
            if (nextArg !== undefined) {
              separator = nextArg
            }
          } else {
            await io.writelnErr('seq: option requires an argument -- \'s\'')
            return 1
          }
        } else if (arg.startsWith('--separator=')) {
          separator = arg.slice(12)
        } else if (arg.startsWith('-s')) {
          separator = arg.slice(2)
        } else if (!arg.startsWith('-')) {
          args.push(arg)
        }
      }

      if (args.length === 0) {
        await io.writelnErr('seq: missing operand')
        return 1
      }

      let first = 1
      let increment = 1
      let last: number

      if (args.length === 1) {
        const arg0 = args[0]
        if (arg0 === undefined) {
          await io.writelnErr('seq: missing operand')
          return 1
        }
        last = parseFloat(arg0)
        if (isNaN(last)) {
          await io.writelnErr(`seq: invalid number: ${arg0}`)
          return 1
        }
      } else if (args.length === 2) {
        const arg0 = args[0]
        const arg1 = args[1]
        if (arg0 === undefined || arg1 === undefined) {
          await io.writelnErr('seq: missing operand')
          return 1
        }
        first = parseFloat(arg0)
        last = parseFloat(arg1)
        if (isNaN(first) || isNaN(last)) {
          await io.writelnErr('seq: invalid number')
          return 1
        }
      } else if (args.length === 3) {
        const arg0 = args[0]
        const arg1 = args[1]
        const arg2 = args[2]
        if (arg0 === undefined || arg1 === undefined || arg2 === undefined) {
          await io.writelnErr('seq: missing operand')
          return 1
        }
        first = parseFloat(arg0)
        increment = parseFloat(arg1)
        last = parseFloat(arg2)
        if (isNaN(first) || isNaN(increment) || isNaN(last)) {
          await io.writelnErr('seq: invalid number')
          return 1
        }
      } else {
        await io.writelnErr('seq: too many arguments')
        return 1
      }

      const writer = io.stdout!.getWriter()
      const numbers: number[] = []

      if (increment > 0) {
        for (let i = first; i <= last; i += increment) {
          numbers.push(i)
        }
      } else if (increment < 0) {
        for (let i = first; i >= last; i += increment) {
          numbers.push(i)
        }
      } else {
        await io.writelnErr('seq: zero increment')
        writer.releaseLock()
        return 1
      }

      const output = numbers.map(n => {
        if (Number.isInteger(n)) {
          return n.toString()
        } else {
          return n.toFixed(10).replace(/\.?0+$/, '')
        }
      }).join(separator)

      try {
        await writer.write(new TextEncoder().encode(output + (separator === '\n' ? '' : '\n')))
        return 0
      } finally {
        writer.releaseLock()
      }
    }
  })
}
