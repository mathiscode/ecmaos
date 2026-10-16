/** Print the name the user logged in with, from `LOGNAME` (or `USER` when that is not set). */

import { getopt, tryHelp } from './lib/getopt.mjs'

const { argv, exit, writeAll, env } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const usage = `Usage: logname [OPTION]
Print the user's login name.

      --help     display this help and exit
      --version  output version information and exit`

function main() {
  const { options, operands, error } = getopt(argv.slice(1), { long: { help: 'help', version: 'version' } })
  if (error) { writeAll(2, encoder.encode(`logname: ${error}\n${tryHelp('logname')}\n`)); return 1 }
  for (const [key] of options) {
    if (key === 'help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (key === 'version') { writeAll(1, encoder.encode('logname (ecmaOS coreutils) 1.0\n')); return 0 }
  }
  if (operands.length > 0) { writeAll(2, encoder.encode(`logname: extra operand ‘${operands[0]}’\n${tryHelp('logname')}\n`)); return 1 }
  const name = env.LOGNAME || env.USER
  if (!name) { writeAll(2, encoder.encode('logname: no login name\n')); return 1 }
  writeAll(1, encoder.encode(name + '\n'))
  return 0
}

try {
  exit(main())
} catch (error) {
  writeAll(2, encoder.encode(`logname: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
