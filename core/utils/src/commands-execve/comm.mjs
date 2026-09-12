/**
 * Real `execve`'d `comm` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/comm.ts`) per `feat/1.0.0-execve-commands`. See `head.mjs`'s doc comment
 * for why there's no in-band interrupt handling and no `/dev`-path special case anymore.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, write, read, getcwd, open, close, stat, O_RDONLY } = globalThis.ecmaosSyscalls

const usage = `Usage: comm [OPTION]... FILE1 FILE2
Compare two sorted files line by line.

  -1     suppress lines unique to FILE1
  -2     suppress lines unique to FILE2
  -3     suppress lines that appear in both files
  --help display this help and exit`

function readFileLines(fullPath) {
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
  const text = new TextDecoder().decode(bytes)
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    write(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  const files = []
  let suppress1 = false
  let suppress2 = false
  let suppress3 = false

  for (const arg of args) {
    if (arg === '-1') suppress1 = true
    else if (arg === '-2') suppress2 = true
    else if (arg === '-3') suppress3 = true
    else if (!arg.startsWith('-')) { if (files.length < 2) files.push(arg) }
  }

  if (files.length !== 2) {
    write(2, new TextEncoder().encode('comm: exactly two files must be specified\n'))
    return 1
  }

  const [file1, file2] = files
  const cwd = getcwd()

  try {
    const lines1 = readFileLines(resolve(cwd, file1))
    const lines2 = readFileLines(resolve(cwd, file2))

    let i = 0
    let j = 0
    let output = ''

    while (i < lines1.length || j < lines2.length) {
      if (i >= lines1.length) {
        if (!suppress2) output += (suppress1 ? '' : '\t') + lines2[j] + '\n'
        j++
      } else if (j >= lines2.length) {
        if (!suppress1) output += lines1[i] + '\n'
        i++
      } else {
        const cmp = lines1[i].localeCompare(lines2[j])
        if (cmp < 0) {
          if (!suppress1) output += lines1[i] + '\n'
          i++
        } else if (cmp > 0) {
          if (!suppress2) output += (suppress1 ? '' : '\t') + lines2[j] + '\n'
          j++
        } else {
          if (!suppress3) {
            const prefix = suppress1 && suppress2 ? '' : suppress1 ? '\t' : suppress2 ? '' : '\t\t'
            output += prefix + lines1[i] + '\n'
          }
          i++
          j++
        }
      }
    }

    write(1, new TextEncoder().encode(output))
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    write(2, new TextEncoder().encode(`comm: ${message}\n`))
    return 1
  }
}

try {
  exit(main())
} catch (error) {
  write(2, new TextEncoder().encode(`comm: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
