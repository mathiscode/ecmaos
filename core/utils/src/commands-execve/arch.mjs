/** `arch`: print the machine hardware name, as `uname -m` does. */

import { machineName } from './lib/machine.mjs'

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()

const args = argv.slice(1)
if (args[0] === '--help') { writeAll(1, encoder.encode('Usage: arch [OPTION]...\nPrint machine architecture.\n\n      --help        display this help and exit\n      --version     output version information and exit\n')); exit(0) }
else if (args[0] === '--version') { writeAll(1, encoder.encode('arch (ecmaOS coreutils) 1.0\n')); exit(0) }
else if (args.length) { writeAll(2, encoder.encode(`arch: extra operand '${args[0]}'\nTry 'arch --help' for more information.\n`)); exit(1) }
else { writeAll(1, encoder.encode(`${await machineName()}\n`)); exit(0) }
