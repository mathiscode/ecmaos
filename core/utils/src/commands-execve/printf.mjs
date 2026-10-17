/** Format and print arguments according to a printf-style format string. */

import { formatPrintf, printfBytes } from '../lib/printf-format.ts'

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls

const usage = `Usage: printf FORMAT [ARGUMENT]...
Format and print ARGUMENT(s) according to FORMAT.

FORMAT controls the output as in C printf.  Interpreted sequences:

  \\\\     backslash
  \\a      alert (BEL)
  \\b      backspace
  \\c      produce no further output
  \\e      escape
  \\f      form feed
  \\n      new line
  \\r      carriage return
  \\t      horizontal tab
  \\v      vertical tab
  \\0NNN   byte with octal value NNN (1 to 3 digits)
  \\xHH    byte with hexadecimal value HH (1 to 2 digits)

Conversion specifiers:

  %b      ARGUMENT as a string with '\\' escapes interpreted
  %c      ARGUMENT as a single character
  %d      ARGUMENT as a signed decimal integer
  %i      ARGUMENT as a signed decimal integer
  %o      ARGUMENT as an unsigned octal number
  %q      ARGUMENT quoted so a shell reads it back as it is
  %s      ARGUMENT as a string
  %u      ARGUMENT as an unsigned decimal integer
  %x      ARGUMENT as an unsigned hexadecimal number (lowercase)
  %X      ARGUMENT as an unsigned hexadecimal number (uppercase)
  %%      a single %

  --help  display this help and exit`

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    writeAll(1, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  if (args.length === 0) {
    writeAll(2, new TextEncoder().encode("printf: missing format string\nTry 'printf --help' for more information.\n"))
    return 1
  }

  let status = 0
  const output = formatPrintf(args[0], args.slice(1), value => {
    writeAll(2, new TextEncoder().encode(`printf: ${value}: invalid number\n`))
    status = 1
  }, character => {
    writeAll(2, new TextEncoder().encode(`printf: \`${character}': invalid format character\n`))
    status = 1
  })
  writeAll(1, printfBytes(output))
  return status
}

try {
  exit(main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`printf: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
