/**
 * Real `execve`'d `date` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/date.ts`) per `feat/1.0.0-execve-commands`. Pure `Date` formatting, no
 * live kernel/shell/terminal state.
 */

const { argv, exit, write } = globalThis.ecmaosSyscalls

const usage = `Usage: date [OPTION]... [+FORMAT]
Print or set the system date and time.

  -I, --iso-8601[=TIMESPEC]  output date/time in ISO 8601 format
  -R, --rfc-2822              output date and time in RFC 2822 format
  -f, --format=FORMAT         output date/time in specified format (strftime-like)
  --help                      display this help and exit`

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    write(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  const now = new Date()
  let output = ''
  let iso8601 = false
  let rfc2822 = false
  let format

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue

    if (arg === '--help' || arg === '-h') {
      write(2, new TextEncoder().encode(usage + '\n'))
      return 0
    } else if (arg === '-I' || arg === '--iso-8601') {
      iso8601 = true
    } else if (arg === '-R' || arg === '--rfc-2822') {
      rfc2822 = true
    } else if (arg === '-f' || arg === '--format') {
      if (i + 1 < args.length) {
        format = args[++i]
      } else {
        write(1, new TextEncoder().encode("date: option requires an argument -- 'f'\n"))
        return 1
      }
    } else if (arg.startsWith('--format=')) {
      format = arg.slice(9)
    } else if (arg.startsWith('--iso-8601=')) {
      iso8601 = true
    } else if (arg.startsWith('-f')) {
      format = arg.slice(2)
    } else if (arg.startsWith('+')) {
      format = arg.slice(1)
    }
  }

  if (iso8601) {
    output = now.toISOString()
  } else if (rfc2822) {
    output = now.toUTCString()
  } else if (format) {
    const year = now.getFullYear()
    const month = String(now.getMonth() + 1).padStart(2, '0')
    const day = String(now.getDate()).padStart(2, '0')
    const hours = String(now.getHours()).padStart(2, '0')
    const minutes = String(now.getMinutes()).padStart(2, '0')
    const seconds = String(now.getSeconds()).padStart(2, '0')
    const milliseconds = String(now.getMilliseconds()).padStart(3, '0')

    output = format
      .replace(/%Y/g, String(year))
      .replace(/%m/g, month)
      .replace(/%d/g, day)
      .replace(/%H/g, hours)
      .replace(/%M/g, minutes)
      .replace(/%S/g, seconds)
      .replace(/%s/g, String(Math.floor(now.getTime() / 1000)))
      .replace(/%f/g, milliseconds)
      .replace(/%z/g, now.getTimezoneOffset().toString())
  } else {
    output = now.toString()
  }

  write(1, new TextEncoder().encode(output + '\n'))
  return 0
}

try {
  exit(main())
} catch (error) {
  write(2, new TextEncoder().encode(`date: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
