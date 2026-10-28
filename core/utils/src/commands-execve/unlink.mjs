/** `unlink`: remove one FILE with the `unlink` system call and nothing else. */

import { reasonOf } from './lib/errno.mjs'

const { argv, exit, writeAll, unlink } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`unlink: ${text}\n`))

const args = argv.slice(1).filter(arg => arg !== '--')
if (args[0] === '--help') { writeAll(1, encoder.encode('Usage: unlink FILE\n  or:  unlink OPTION\nCall the unlink function to remove the specified FILE.\n\n      --help        display this help and exit\n      --version     output version information and exit\n')); exit(0) }
else if (args[0] === '--version') { writeAll(1, encoder.encode('unlink (ecmaOS coreutils) 1.0\n')); exit(0) }
else if (args.length !== 1) { err(args.length ? `extra operand '${args[1]}'` : 'missing operand'); writeAll(2, encoder.encode("Try 'unlink --help' for more information.\n")); exit(1) }
else {
  try { unlink(args[0]); exit(0) } catch (error) { err(`cannot unlink '${args[0]}': ${reasonOf(error)}`); exit(1) }
}
