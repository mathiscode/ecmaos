/** `users`: print the names of the users logged in now, from `/run/utmp` (or FILE), sorted, one per login. */

import { readTextFile } from './lib/fs-text.mjs'

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()

const args = argv.slice(1)
if (args[0] === '--help') {
  writeAll(1, encoder.encode('Usage: users [OPTION]... [FILE]\nOutput who is currently logged in according to FILE.\nIf FILE is not specified, use /run/utmp.\n\n      --help        display this help and exit\n      --version     output version information and exit\n'))
  exit(0)
} else if (args[0] === '--version') {
  writeAll(1, encoder.encode('users (ecmaOS coreutils) 1.0\n'))
  exit(0)
} else if (args.length > 1) {
  writeAll(2, encoder.encode(`users: extra operand '${args[1]}'\nTry 'users --help' for more information.\n`))
  exit(1)
} else {
  let text = ''
  try { text = readTextFile(args[0] ?? '/run/utmp') } catch { /* nobody */ }
  const names = text.split('\n').filter(Boolean).map(line => line.split('\t')[0]).filter(Boolean).sort()
  writeAll(1, encoder.encode(names.length ? names.join(' ') + '\n' : ''))
  exit(0)
}
