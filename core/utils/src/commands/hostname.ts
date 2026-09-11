import type { Kernel, Shell, Terminal } from '@ecmaos/types'
import type { CommandContext, CommandIO } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'

function printUsage(io: CommandIO): void {
  const usage = `Usage: hostname [OPTION]
Print the system hostname.

  -f, --fqdn              print the FQDN (Fully Qualified Domain Name)
  -s, --short             print the short hostname
  --help                  display this help and exit`
  io.writelnErr(usage)
}

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'hostname',
    description: 'Print the system hostname',
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

      let showFqdn = false
      let showShort = false
      const args: string[] = []

      for (const arg of ctx.argv) {
        if (!arg) continue

        if (arg === '--help' || arg === '-h') {
          printUsage(io)
          return 0
        } else if (arg === '-f' || arg === '--fqdn') {
          showFqdn = true
        } else if (arg === '-s' || arg === '--short') {
          showShort = true
        } else if (arg.startsWith('-')) {
          const flags = arg.slice(1).split('')
          if (flags.includes('f')) showFqdn = true
          if (flags.includes('s')) showShort = true
          const invalidFlags = flags.filter(f => !['f', 's'].includes(f))
          if (invalidFlags.length > 0) {
            await io.writelnErr(`hostname: invalid option -- '${invalidFlags[0]}'`)
            await io.writelnErr("Try 'hostname --help' for more information.")
            return 1
          }
        } else {
          args.push(arg)
        }
      }

      if (args.length > 0) {
        await io.writelnErr('hostname: invalid argument')
        await io.writelnErr("Try 'hostname --help' for more information.")
        return 1
      }

      const hostname = typeof window !== 'undefined' ? window.location.hostname : 'localhost'

      if (showFqdn) {
        await io.writeln(hostname)
      } else if (showShort) {
        const shortName = hostname.split('.')[0]
        await io.writeln(shortName ?? hostname)
      } else {
        await io.writeln(hostname)
      }

      return 0
    }
  })
}
