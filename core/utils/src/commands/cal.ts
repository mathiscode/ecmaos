import type { Kernel, Shell, Terminal } from '@ecmaos/types'
import type { CommandContext, CommandIO } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'

function printUsage(io: CommandIO): void {
  const usage = `Usage: cal [MONTH] [YEAR]
Display a calendar.

  MONTH   month (1-12)
  YEAR    year
  --help  display this help and exit`
  io.writelnErr(usage)
}

export const meta = { command: 'cal', description: 'Display a calendar' } as const

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

      const now = new Date()
      let month: number | undefined
      let year: number | undefined

      if (ctx.argv.length === 1) {
        const argStr = ctx.argv[0]
        if (!argStr) {
          month = now.getMonth() + 1
          year = now.getFullYear()
        } else {
          const arg = parseInt(argStr, 10)
          if (isNaN(arg)) {
            await io.writeln('cal: invalid argument')
            return 1
          }
          if (arg >= 1 && arg <= 12) {
            month = arg
            year = now.getFullYear()
          } else {
            year = arg
            month = now.getMonth() + 1
          }
        }
      } else if (ctx.argv.length === 2) {
        const monthStr = ctx.argv[0]
        const yearStr = ctx.argv[1]
        if (!monthStr || !yearStr) {
          await io.writeln('cal: invalid arguments')
          return 1
        }
        month = parseInt(monthStr, 10)
        year = parseInt(yearStr, 10)
        if (isNaN(month) || isNaN(year)) {
          await io.writeln('cal: invalid arguments')
          return 1
        }
      } else {
        month = now.getMonth() + 1
        year = now.getFullYear()
      }

      if (month < 1 || month > 12) {
        await io.writeln('cal: invalid month')
        return 1
      }

      const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December']
      const dayNames = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

      const firstDay = new Date(year, month - 1, 1)
      const lastDay = new Date(year, month, 0)
      const daysInMonth = lastDay.getDate()
      const startDayOfWeek = firstDay.getDay()

      let output = `     ${monthNames[month - 1]} ${year}\n`
      output += dayNames.join(' ') + '\n'

      let day = 1
      let isFirstWeek = true

      while (day <= daysInMonth) {
        let line = ''
        for (let i = 0; i < 7; i++) {
          if (isFirstWeek && i < startDayOfWeek) {
            line += '   '
          } else if (day <= daysInMonth) {
            line += day.toString().padStart(2) + ' '
            day++
          } else {
            line += '   '
          }
        }
        output += line.trimEnd() + '\n'
        isFirstWeek = false
      }

      await io.writeln(output)
      return 0
    }
  })
}
