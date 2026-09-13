/**
 * Real `execve`'d `diff` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/diff.ts`) per `feat/1.0.0-execve-commands`. See `cat.mjs`'s doc comment
 * for why there's no in-band interrupt handling and no `/dev`-path special case anymore. The original
 * parsed -u/-c NUM but never actually used them in its output (a TODO'd, dead feature -- confirmed by
 * reading the original directly) -- still parsed here for argument-compatibility, still unused.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, read, getcwd, open, close, stat, O_RDONLY } = globalThis.ecmaosSyscalls

const usage = `Usage: diff [OPTION]... FILE1 FILE2
Compare files line by line.

  -u, --unified=NUM   output NUM (default 3) lines of unified context
  -c, --context=NUM   output NUM (default 3) lines of copied context
  --help              display this help and exit`

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

function lcs(a, b) {
  const m = a.length
  const n = b.length
  const dp = []
  for (let i = 0; i <= m; i++) dp[i] = new Array(n + 1).fill(0)
  for (let i = 1; i <= m; i++) {
    const row = dp[i]
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        row[j] = dp[i - 1][j - 1] + 1
      } else {
        row[j] = Math.max(dp[i - 1][j], row[j - 1])
      }
    }
  }
  return dp
}

function diffLines(a, b) {
  const dp = lcs(a, b)
  const result = []
  let i = a.length
  let j = b.length

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      result.unshift(`  ${a[i - 1]}`)
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift(`+ ${b[j - 1]}`)
      j--
    } else if (i > 0) {
      result.unshift(`- ${a[i - 1]}`)
      i--
    }
  }

  return result
}

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    writeAll(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  const files = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    if (arg === '--help' || arg === '-h') {
      writeAll(2, new TextEncoder().encode(usage + '\n'))
      return 0
    } else if (arg === '-u' || arg === '--unified') {
      if (i + 1 < args.length) i++
    } else if (arg.startsWith('--unified=')) {
      // no-op: parsed for compatibility, never used by the original either
    } else if (arg === '-c' || arg === '--context') {
      if (i + 1 < args.length) i++
    } else if (arg.startsWith('--context=')) {
      // no-op: see -u above
    } else if (!arg.startsWith('-')) {
      files.push(arg)
    }
  }

  if (files.length !== 2) {
    writeAll(2, new TextEncoder().encode('diff: exactly two files must be specified\n'))
    return 1
  }

  const [file1, file2] = files
  const cwd = getcwd()
  const fullPath1 = resolve(cwd, file1)
  const fullPath2 = resolve(cwd, file2)

  try {
    const content1 = new TextDecoder().decode(readWholeFile(fullPath1))
    const content2 = new TextDecoder().decode(readWholeFile(fullPath2))

    const lines1 = content1.split('\n')
    const lines2 = content2.split('\n')
    if (lines1[lines1.length - 1] === '') lines1.pop()
    if (lines2[lines2.length - 1] === '') lines2.pop()

    const diff = diffLines(lines1, lines2)

    if (diff.length === 0 || diff.every(line => line.startsWith('  '))) {
      return 0
    }

    let output = `--- ${file1}\n+++ ${file2}\n`
    for (const line of diff) output += line + '\n'
    writeAll(1, new TextEncoder().encode(output))

    return 1
  } catch (error) {
    writeAll(2, new TextEncoder().encode(`diff: ${error instanceof Error ? error.message : String(error)}\n`))
    return 1
  }
}

try {
  exit(main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`diff: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
