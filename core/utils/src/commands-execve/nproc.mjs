/** Print the number of available processing units, as GNU `nproc` does: `--all`, `--ignore=N`, at least 1. */

import { getopt, tryHelp } from './lib/getopt.mjs'

const { argv, exit, writeAll, env } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`nproc: ${text}\n`))

const usage = `Usage: nproc [OPTION]...
Print the number of processing units available to the current process,
which may be less than the number of online processors.

      --all      print the number of installed processors
      --ignore=N  if possible, exclude N processing units
      --help     display this help and exit
      --version  output version information and exit`

function main() {
  const { options, operands, error } = getopt(argv.slice(1), { long: { all: 'all', ignore: { key: 'ignore', arg: 'required' }, help: 'help', version: 'version' } })
  if (error) { err(error); writeAll(2, encoder.encode(tryHelp('nproc') + '\n')); return 1 }
  let ignore = 0
  for (const [key, value] of options) {
    if (key === 'help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (key === 'version') { writeAll(1, encoder.encode('nproc (ecmaOS coreutils) 1.0\n')); return 0 }
    if (key === 'ignore') {
      if (!/^\d+$/.test(String(value))) { err(`invalid number: ‘${value}’`); return 1 }
      ignore = Number(value)
    }
  }
  if (operands.length > 0) { err(`extra operand ‘${operands[0]}’`); writeAll(2, encoder.encode(tryHelp('nproc') + '\n')); return 1 }
  // OMP_NUM_THREADS and OMP_THREAD_LIMIT lower the count unless --all asks for every unit
  let count = navigator.hardwareConcurrency || 1
  if (!options.some(([key]) => key === 'all')) {
    const threads = Number.parseInt(env.OMP_NUM_THREADS ?? '', 10)
    if (threads > 0) count = threads
    const limit = Number.parseInt(env.OMP_THREAD_LIMIT ?? '', 10)
    if (limit > 0) count = Math.min(count, limit)
  }
  writeAll(1, encoder.encode(String(Math.max(1, count - ignore)) + '\n'))
  return 0
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
