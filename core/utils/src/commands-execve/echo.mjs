/** Print arguments to stdout, with optional backslash-escape interpretation. */

import { echoOutput } from '../lib/echo-text.ts'

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls

const usage = `Usage: echo [OPTION]... [STRING]...
Echo the STRING(s) to standard output.

  -e     enable interpretation of backslash escapes
  -E     disable interpretation of backslash escapes (default)
  -n     do not output the trailing newline
  --help display this help and exit`

function main() {
  const args = argv.slice(1) // argv[0] is the program path itself
  const { output, help } = echoOutput(args, { stopAtHelp: true })
  if (help) {
    writeAll(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }
  writeAll(1, new TextEncoder().encode(output))
  return 0
}

try {
  exit(main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`echo: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
