/** Repeat a line for ever, or until the reader of the pipe is gone. */

const { argv, exit, writeAll, write } = globalThis.ecmaosSyscalls

import { getopt, tryHelp } from './lib/getopt.mjs'

const { options, operands: args, error } = getopt(argv.slice(1), { long: { help: 'help', version: 'version' }, permute: false })
if (error) { writeAll(2, new TextEncoder().encode(`yes: ${error}\n${tryHelp('yes')}\n`)); exit(1) }
for (const [key] of options) {
  if (key === 'help') { writeAll(1, new TextEncoder().encode('Usage: yes [STRING]...\n  or:  yes OPTION\nRepeatedly output a line with all specified STRING(s), or `y`.\n\n      --help     display this help and exit\n      --version  output version information and exit\n')); exit(0) }
  if (key === 'version') { writeAll(1, new TextEncoder().encode('yes (ecmaOS coreutils) 1.0\n')); exit(0) }
}

const line = (args.length ? args.join(' ') : 'y') + '\n'
// a block of lines at a time, as the real one does, so a pipe is filled in a few writes rather than many
const encoded = new TextEncoder().encode(line)
const block = new Uint8Array(Math.max(encoded.length, 8192 - (8192 % encoded.length)))
for (let at = 0; at < block.length; at += encoded.length) block.set(encoded, at)

try {
  for (;;) writeAll(1, block)
} catch {
  // The reader closed: the real `yes` is ended by SIGPIPE, which a shell reports as 141.
  write(2, new Uint8Array(0))
  exit(141)
}
