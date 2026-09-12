/**
 * Real `execve`'d `cmp` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/cmp.ts`) per `feat/1.0.0-execve-commands`. See `head.mjs`'s doc comment
 * for why there's no in-band interrupt handling and no `/dev`-path special case anymore.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, write, read, getcwd, open, close, stat, O_RDONLY } = globalThis.ecmaosSyscalls

const usage = `Usage: cmp [OPTION]... FILE1 FILE2
Compare two files byte by byte.

  -l, --verbose          print byte number and differing byte values
  -s, --quiet, --silent  suppress output; return exit status only
  --help                 display this help and exit`

function readWholeFile(fullPath) {
  const size = stat(fullPath).size
  const fd = open(fullPath, O_RDONLY)
  const bytes = new Uint8Array(size)
  try {
    let bytesRead = 0
    while (bytesRead < size) {
      const chunk = new Uint8Array(size - bytesRead)
      const n = read(fd, chunk, -1)
      if (n <= 0) break
      bytes.set(chunk.subarray(0, n), bytesRead)
      bytesRead += n
    }
  } finally {
    close(fd)
  }
  return bytes
}

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    write(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  let verbose = false
  let quiet = false
  const files = []

  for (const arg of args) {
    if (arg === '-l' || arg === '--verbose') verbose = true
    else if (arg === '-s' || arg === '--quiet' || arg === '--silent') quiet = true
    else if (arg.startsWith('-')) {
      const flags = arg.slice(1).split('')
      if (flags.includes('l')) verbose = true
      if (flags.includes('s')) quiet = true
      const invalid = flags.find(f => !['l', 's'].includes(f))
      if (invalid) {
        write(2, new TextEncoder().encode(`cmp: invalid option -- '${invalid}'\n`))
        write(2, new TextEncoder().encode("Try 'cmp --help' for more information.\n"))
        return 1
      }
    } else {
      files.push(arg)
    }
  }

  if (files.length !== 2) {
    write(2, new TextEncoder().encode('cmp: missing operand after\n'))
    write(2, new TextEncoder().encode("Try 'cmp --help' for more information.\n"))
    return 1
  }

  const [file1, file2] = files
  const cwd = getcwd()
  const fullPath1 = resolve(cwd, file1)
  const fullPath2 = resolve(cwd, file2)

  try {
    const bytes1 = readWholeFile(fullPath1)
    const bytes2 = readWholeFile(fullPath2)
    const minLength = Math.min(bytes1.length, bytes2.length)

    for (let i = 0; i < minLength; i++) {
      if (bytes1[i] !== bytes2[i]) {
        if (verbose) write(2, new TextEncoder().encode(`${i + 1} ${bytes1[i]} ${bytes2[i]}\n`))
        else if (!quiet) write(2, new TextEncoder().encode(`${file1} ${file2} differ: byte ${i + 1}, line ${Math.floor(i / 80) + 1}\n`))
        return 1
      }
    }

    if (bytes1.length !== bytes2.length) {
      if (!quiet) write(2, new TextEncoder().encode(`cmp: EOF on ${bytes1.length < bytes2.length ? file1 : file2}\n`))
      return 1
    }

    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    write(2, new TextEncoder().encode(`cmp: ${message}\n`))
    return 1
  }
}

try {
  exit(main())
} catch (error) {
  write(2, new TextEncoder().encode(`cmp: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
