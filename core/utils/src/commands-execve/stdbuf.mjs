/**
 * `stdbuf`: run a command with changed buffering for its standard streams. On Linux this preloads a library that sets the
 * C library's buffers; a program here has no such library to preload and the shell's pipes pass bytes as they come, so the
 * modes are checked and accepted and the command runs as it is.
 */

import { findProgram, run } from './lib/run.mjs'

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`stdbuf: ${text}\n`))

const usage = `Usage: stdbuf OPTION... COMMAND
Run COMMAND, with modified buffering operations for its standard streams.

Mandatory arguments to long options are mandatory for short options too.
  -i, --input=MODE   adjust standard input stream buffering
  -o, --output=MODE  adjust standard output stream buffering
  -e, --error=MODE   adjust standard error stream buffering
      --help         display this help and exit
      --version      output version information and exit

If MODE is 'L' the corresponding stream will be line buffered. If MODE is '0' the corresponding stream will be unbuffered.
Otherwise MODE is a number which may be followed by one of the following: KB 1000, K 1024, MB 1000*1000, M 1024*1024, and so on
for G, T, P, E, Z, Y.  In this case the corresponding stream will be fully buffered with the buffer size set to MODE bytes.

Here the buffering modes are accepted and not applied: the streams pass bytes as they are written.`

const validMode = mode => mode === 'L' || /^\d+([KMGTPEZY]B?)?$/i.test(mode)

async function main() {
  const args = argv.slice(1)
  let given = 0
  while (args.length) {
    const arg = args[0]
    if (arg === '--') { args.shift(); break }
    if (arg === '--help') { out(usage + '\n'); return 0 }
    if (arg === '--version') { out('stdbuf (ecmaOS coreutils) 1.0\n'); return 0 }
    let mode
    const long = /^--(input|output|error)(?:=(.*))?$/.exec(arg)
    if (long) { args.shift(); mode = long[2] ?? args.shift() }
    else if (/^-[ioe]$/.test(arg)) { args.shift(); mode = args.shift() }
    else if (/^-[ioe].+/.test(arg)) { args.shift(); mode = arg.slice(2) }
    else if (arg.startsWith('-') && arg.length > 1) { err(`invalid option -- '${arg.replace(/^-+/, '')}'\nTry 'stdbuf --help' for more information.`); return 125 }
    else break
    if (mode === undefined || !validMode(mode)) { err(`invalid mode ‘${mode ?? ''}’`); return 125 }
    given++
  }
  if (!args.length) { err('missing operand\nTry \'stdbuf --help\' for more information.'); return 125 }
  if (!given) { err('you must specify a buffering mode option\nTry \'stdbuf --help\' for more information.'); return 125 }
  const program = findProgram(args[0])
  if (!program) { err(`failed to run command ‘${args[0]}’: No such file or directory`); return 127 }
  try { return (await run(program, args)).status } catch (error) {
    err(`failed to run command ‘${args[0]}’: ${error?.message ?? error}`)
    return 126
  }
}

try {
  exit(await main())
} catch (error) {
  err(error?.message ?? String(error))
  exit(125)
}
