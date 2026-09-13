/**
 * Real `execve`'d `tee` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/tee.ts`) per `feat/1.0.0-execve-commands`. `shell.expandTilde(...)` (a
 * live `Shell` method) is replaced by a small worker-local `~` expansion using `env.HOME` (from the
 * real `init` message, `ecmaosSyscalls.env`) -- the common `~` and `~/rest` cases only, matching what
 * `tee`'s own file-argument usage actually needs (not the fuller quoting-aware expansion `Shell`'s
 * own version handles for general command-line words). See `head.mjs`'s doc comment for why there's
 * no in-band interrupt handling anymore -- `-i`/`--ignore-interrupts` is now a no-op flag accepted
 * for compatibility, since a real execve'd process is killed like any other on `^C` regardless.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, read, getcwd, env, open, close, stat, O_WRONLY, O_CREAT, O_TRUNC } = globalThis.ecmaosSyscalls

const usage = `Usage: tee [OPTION]... [FILE]...
Read from standard input and write to standard output and files.

  -a, --append            append to the given files, do not overwrite
  -i, --ignore-interrupts ignore interrupt signals
  --help                  display this help and exit`

function expandTilde(input) {
  const home = env.HOME
  if (!home) return input
  if (input === '~') return home
  if (input.startsWith('~/')) return home + input.slice(1)
  return input
}

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    writeAll(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  const files = []
  let append = false

  for (const arg of args) {
    if (arg === '-a' || arg === '--append') {
      append = true
    } else if (arg === '-i' || arg === '--ignore-interrupts') {
      // no-op: see module doc comment
    } else if (arg.startsWith('-')) {
      const flags = arg.slice(1).split('')
      if (flags.includes('a')) append = true
      const invalid = flags.find(f => !['a', 'i'].includes(f))
      if (invalid) {
        writeAll(2, new TextEncoder().encode(`tee: invalid option -- '${invalid}'\n`))
        return 1
      }
    } else {
      files.push(arg)
    }
  }

  const cwd = getcwd()
  const filePaths = files.map(file => ({ path: file, fullPath: resolve(cwd, expandTilde(file)) }))
  const fds = []

  try {
    for (const fileInfo of filePaths) {
      // No `O_APPEND` in this interpreter's exposed flag set -- append mode is done explicitly:
      // open without `O_TRUNC` (so existing content survives), start the write position at the
      // file's current size (0 for a brand-new file), and track/advance that position ourselves as
      // each chunk is written, the same way a real `O_APPEND` fd's position advances on every write.
      const flags = O_WRONLY | O_CREAT | (append ? 0 : O_TRUNC)
      try {
        const fd = open(fileInfo.fullPath, flags, 0o644)
        let position = 0
        if (append) { try { position = stat(fileInfo.fullPath).size } catch { position = 0 } }
        fds.push({ path: fileInfo.path, fd, position })
      } catch (error) {
        writeAll(2, new TextEncoder().encode(`tee: ${fileInfo.path}: ${error instanceof Error ? error.message : String(error)}\n`))
        return 1
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
          writeAll(2, new TextEncoder().encode(`tee: ${fileInfo.path}: ${error instanceof Error ? error.message : 'Write error'}\n`))
        }
      }
    }

    return 0
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
