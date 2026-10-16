/**
 * Read from stdin and write to both stdout and one or more files. `-i`/`--ignore-interrupts` is
 * accepted for compatibility but has no effect - `^C` always kills the process.
 */

import { resolve } from './lib/path-utils.mjs'
import { getopt, tryHelp } from './lib/getopt.mjs'

const { argv, exit, writeAll, read, getcwd, env, open, close, stat, O_WRONLY, O_CREAT, O_TRUNC } = globalThis.ecmaosSyscalls

const usage = `Usage: tee [OPTION]... [FILE]...
Read from standard input and write to standard output and files.

  -a, --append              append to the given FILEs, do not overwrite
  -i, --ignore-interrupts   ignore interrupt signals
  -p                        operate in a more appropriate MODE with pipes.
      --output-error[=MODE]   set behavior on write error.  See MODE below
      --help        display this help and exit
      --version     output version information and exit

MODE determines behavior with write errors on the outputs:
  'warn'         diagnose errors writing to any output
  'warn-nopipe'  diagnose errors writing to any output not a pipe
  'exit'         exit on error writing to any output
  'exit-nopipe'  exit on error writing to any output not a pipe
The default MODE for the -p option is 'warn-nopipe'.
The default operation when --output-error is not specified, is to
exit immediately on error writing to a pipe, and diagnose errors
writing to non pipe outputs.`

function expandTilde(input) {
  const home = env.HOME
  if (!home) return input
  if (input === '~') return home
  if (input.startsWith('~/')) return home + input.slice(1)
  return input
}

function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'aip',
    long: { append: 'a', 'ignore-interrupts': 'i', 'output-error': { key: 'o', arg: 'optional' }, help: 'help', version: 'version' }
  })
  if (error) {
    writeAll(2, new TextEncoder().encode(`tee: ${error}\n${tryHelp('tee')}\n`))
    return 1
  }
  if (options.some(([key]) => key === 'help')) { writeAll(1, new TextEncoder().encode(usage + '\n')); return 0 }
  if (options.some(([key]) => key === 'version')) { writeAll(1, new TextEncoder().encode('tee (ecmaOS coreutils) 1.0\n')); return 0 }
  let mode
  for (const [key, value] of options) {
    if (key === 'p') mode = 'warn-nopipe'
    else if (key === 'o') {
      mode = value === true ? 'warn-nopipe' : String(value)
      if (!['warn', 'warn-nopipe', 'exit', 'exit-nopipe'].includes(mode)) {
        writeAll(2, new TextEncoder().encode(`tee: invalid argument ‘${value}’ for ‘--output-error’\nValid arguments are:\n  - ‘warn’\n  - ‘warn-nopipe’\n  - ‘exit’\n  - ‘exit-nopipe’\n${tryHelp('tee')}\n`))
        return 1
      }
    }
  }
  const append = options.some(([key]) => key === 'a')
  const files = operands

  const cwd = getcwd()
  const filePaths = files.map(file => ({ path: file, fullPath: resolve(cwd, expandTilde(file)) }))
  const fds = []
  let failed = false
  const reason = error => {
    const message = error instanceof Error ? error.message : String(error)
    return /EISDIR/.test(message) ? 'Is a directory' : /ENOENT/.test(message) ? 'No such file or directory' : /EACCES/.test(message) ? 'Permission denied' : message
  }

  try {
    for (const fileInfo of filePaths) {
      // There is no `O_APPEND`, so append mode opens without `O_TRUNC`, starts at the file's size and advances the
      // position itself.
      const flags = O_WRONLY | O_CREAT | (append ? 0 : O_TRUNC)
      try {
        const fd = open(fileInfo.fullPath, flags, 0o644)
        let position = 0
        if (append) { try { position = stat(fileInfo.fullPath).size } catch { position = 0 } }
        fds.push({ path: fileInfo.path, fd, position })
      } catch (error) {
        // A file that cannot be opened is reported, and the others and standard output carry on, as in GNU tee
        writeAll(2, new TextEncoder().encode(`tee: ${fileInfo.path}: ${reason(error)}\n`))
        failed = true
      }
    }

    const chunkSize = 65536
    while (true) {
      const buffer = new Uint8Array(chunkSize)
      const n = read(0, buffer, -1)
      if (n <= 0) break
      const chunk = buffer.subarray(0, n)

      writeAll(1, chunk)

      for (const fileInfo of fds) {
        try {
          writeAll(fileInfo.fd, chunk, fileInfo.position)
          fileInfo.position += chunk.length
        } catch (error) {
          writeAll(2, new TextEncoder().encode(`tee: ${fileInfo.path}: ${reason(error)}\n`))
          failed = true
          if (mode === 'exit' || mode === 'exit-nopipe') return 1
        }
      }
    }

    return failed ? 1 : 0
  } finally {
    for (const { fd } of fds) close(fd)
  }
}

try {
  exit(main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`tee: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
