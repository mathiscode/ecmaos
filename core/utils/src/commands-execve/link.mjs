/** `link`: make a hard link, FILE2, to FILE1, with the `link` system call and nothing else. */

import { reasonOf } from './lib/errno.mjs'

const { argv, exit, writeAll, link } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`link: ${text}\n`))

const args = argv.slice(1).filter(arg => arg !== '--')
if (args[0] === '--help') { writeAll(1, encoder.encode('Usage: link FILE1 FILE2\n  or:  link OPTION\nCall the link function to create a link named FILE2 to an existing FILE1.\n\n      --help        display this help and exit\n      --version     output version information and exit\n')); exit(0) }
else if (args[0] === '--version') { writeAll(1, encoder.encode('link (ecmaOS coreutils) 1.0\n')); exit(0) }
else if (args.length !== 2) { err(args.length < 2 ? (args.length ? `missing operand after '${args[0]}'` : 'missing operand') : `extra operand '${args[2]}'`); writeAll(2, encoder.encode("Try 'link --help' for more information.\n")); exit(1) }
else {
  try { link(args[0], args[1]); exit(0) } catch (error) { err(`cannot create link '${args[1]}' to '${args[0]}': ${reasonOf(error)}`); exit(1) }
}
