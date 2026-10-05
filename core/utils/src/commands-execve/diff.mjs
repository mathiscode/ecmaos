/**
 * Compare two files line by line and print the differences as a unified diff (what `patch` reads): `@@` hunks
 * with `-U NUM` / `--unified=NUM` lines of context (3 by default). `-u` is accepted and changes nothing, since
 * unified is the only format. `-c` (copied context) is accepted but also prints unified.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, read, getcwd, open, close, stat, O_RDONLY } = globalThis.ecmaosSyscalls

const usage = `Usage: diff [OPTION]... FILE1 FILE2
Compare files line by line.

  -u                  unified output (the default and only format)
  -U NUM, --unified=NUM  output NUM (default 3) lines of context
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

/**
 * Groups `diffLines` output into unified hunks: each change plus `context` lines around it, hunks that touch or
 * overlap merged, with `@@ -start,count +start,count @@` headers (a count of 0 numbers the line before, as diff does).
 */
function unifiedHunks(diff, context) {
  const changes = []
  diff.forEach((line, index) => { if (!line.startsWith('  ')) changes.push(index) })
  if (changes.length === 0) return []

  const ranges = []
  for (const index of changes) {
    const from = Math.max(0, index - context)
    const to = Math.min(diff.length - 1, index + context)
    const last = ranges[ranges.length - 1]
    if (last && from <= last[1] + 1) last[1] = to
    else ranges.push([from, to])
  }

  // line numbers (1-based) of the first line of each diff entry in file 1 and file 2
  const starts1 = []
  const starts2 = []
  let n1 = 1
  let n2 = 1
  for (const line of diff) {
    starts1.push(n1)
    starts2.push(n2)
    if (!line.startsWith('+ ')) n1++
    if (!line.startsWith('- ')) n2++
  }

  const out = []
  for (const [from, to] of ranges) {
    const body = diff.slice(from, to + 1)
    const count1 = body.filter(line => !line.startsWith('+ ')).length
    const count2 = body.filter(line => !line.startsWith('- ')).length
    const start1 = count1 === 0 ? starts1[from] - 1 : starts1[from]
    const start2 = count2 === 0 ? starts2[from] - 1 : starts2[from]
    out.push(`@@ -${start1}${count1 === 1 ? '' : `,${count1}`} +${start2}${count2 === 1 ? '' : `,${count2}`} @@`)
    for (const line of body) out.push(line.startsWith('  ') ? ` ${line.slice(2)}` : `${line[0]}${line.slice(2)}`)
  }
  return out
}

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    writeAll(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  const files = []
  let context = 3

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    if (arg === '--help' || arg === '-h') {
      writeAll(2, new TextEncoder().encode(usage + '\n'))
      return 0
    } else if (arg === '-u' || arg === '-c' || arg === '--unified' || arg === '--context') {
      // unified is the only format
    } else if (arg === '-U' && i + 1 < args.length) {
      context = Math.max(0, parseInt(args[++i], 10) || 0)
    } else if (/^-U\d+$/.test(arg)) {
      context = parseInt(arg.slice(2), 10)
    } else if (arg.startsWith('--unified=') || arg.startsWith('--context=')) {
      context = Math.max(0, parseInt(arg.split('=')[1], 10) || 0)
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
    for (const line of unifiedHunks(diff, context)) output += line + '\n'
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
