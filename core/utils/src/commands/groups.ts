import type { Kernel, Shell, Terminal, User } from '@ecmaos/types'
import type { CommandContext, CommandIO } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'

function printUsage(io: CommandIO): void {
  const usage = `Usage: groups [USERNAME]...
Print the groups a user belongs to.

  --help  display this help and exit`
  io.writelnErr(usage)
}

export const meta = { command: 'groups', description: 'Print the groups a user belongs to' } as const

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

      const usernames: string[] = []

      for (const arg of ctx.argv) {
        if (!arg) continue

        if (arg === '--help' || arg === '-h') {
          printUsage(io)
          return 0
        } else if (!arg.startsWith('-')) {
          usernames.push(arg)
        } else {
          await io.writelnErr(`groups: invalid option -- '${arg.slice(1)}'`)
          await io.writelnErr("Try 'groups --help' for more information.")
          return 1
        }
      }

      const targets = usernames.length > 0 ? usernames : [shell.username]

      for (const username of targets) {
        const user = Array.from(kernel.users.all.values()).find(
          (u): u is User => (u as User).username === username
        )

        if (!user) {
          await io.writelnErr(`groups: '${username}': no such user`)
          continue
        }

        const groups = shell.credentials.groups || []
        const groupNames = groups.map(gid => {
          const groupUser = kernel.users.get(gid)
          return groupUser?.username || gid.toString()
        })

        const output = `${username} : ${groupNames.join(' ')}`
        await io.writeln(output)
      }

      return 0
    }
  })
}
