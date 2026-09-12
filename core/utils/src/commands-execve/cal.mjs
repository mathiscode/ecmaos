/**
 * Real `execve`'d `cal` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/cal.ts`) per `feat/1.0.0-execve-commands`. Pure `Date` computation, no
 * live kernel/shell/terminal state.
 */

const { argv, exit, write } = globalThis.ecmaosSyscalls

const usage = `Usage: cal [MONTH] [YEAR]
Display a calendar.

  MONTH   month (1-12)
  YEAR    year
  --help  display this help and exit`

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    write(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  const now = new Date()
  let month
  let year

  if (args.length === 1) {
    const arg = parseInt(args[0], 10)
    if (isNaN(arg)) {
      write(1, new TextEncoder().encode('cal: invalid argument\n'))
      return 1
    }
    if (arg >= 1 && arg <= 12) {
      month = arg
      year = now.getFullYear()
    } else {
      year = arg
      month = now.getMonth() + 1
    }
  } else if (args.length === 2) {
    month = parseInt(args[0], 10)
    year = parseInt(args[1], 10)
    if (isNaN(month) || isNaN(year)) {
      write(1, new TextEncoder().encode('cal: invalid arguments\n'))
      return 1
    }
  } else {
    month = now.getMonth() + 1
    year = now.getFullYear()
  }

  if (month < 1 || month > 12) {
    write(1, new TextEncoder().encode('cal: invalid month\n'))
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

  write(1, new TextEncoder().encode(output + '\n'))
  return 0
}

try {
  exit(main())
} catch (error) {
  write(2, new TextEncoder().encode(`cal: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
