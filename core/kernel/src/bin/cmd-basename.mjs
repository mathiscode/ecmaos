/**
 * Real `execve`'d `basename` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/basename.ts`) per `feat/1.0.0-execve-commands`.
 */

import { basename } from './lib/path-utils.mjs'

const { argv, exit, write } = globalThis.ecmaosSyscalls

const usage = `Usage: basename NAME [SUFFIX]
       basename OPTION... NAME...
Strip directory and suffix from filenames.

  -s, --suffix=SUFFIX  remove a trailing SUFFIX
  --help               display this help and exit`

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    write(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  let suffix
  const paths = []
  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === '-s' || arg === '--suffix') {
      if (i + 1 < args.length) suffix = args[++i]
      else { write(2, new TextEncoder().encode("basename: option requires an argument -- 's'\n")); return 1 }
    } else if (arg.startsWith('--suffix=')) {
      suffix = arg.slice(9)
    } else if (arg.startsWith('-s')) {
      suffix = arg.slice(2)
    } else if (!arg.startsWith('-')) {
      paths.push(arg)
    }
    i++
  }

  if (paths.length === 0) {
    write(2, new TextEncoder().encode('basename: missing operand\n'))
    return 1
  }

  let output = ''
  for (const filePath of paths) {
    let name = basename(filePath)
    if (suffix && name.endsWith(suffix)) name = name.slice(0, -suffix.length)
    output += name + '\n'
  }
  write(1, new TextEncoder().encode(output))
  return 0
}

try {
  exit(main())
} catch (error) {
  write(2, new TextEncoder().encode(`basename: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
