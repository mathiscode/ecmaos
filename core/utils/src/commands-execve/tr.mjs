/**
 * Real `execve`'d `tr` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/tr.ts`) per `feat/1.0.0-execve-commands`. Reads all of stdin (fd 0) via
 * real `read()` in a loop the same way `pilot-pwd`'s output side does, just reversed.
 */

const { argv, exit, write, read } = globalThis.ecmaosSyscalls

const usage = `Usage: tr [OPTION]... SET1 [SET2]
Translate or delete characters.

  -d, --delete    delete characters in SET1
  -s, --squeeze   replace each sequence of a repeated character
  --help          display this help and exit`

function readAllStdin() {
  const chunkSize = 65536
  const chunks = []
  while (true) {
    const buffer = new Uint8Array(chunkSize)
    const n = read(0, buffer, -1)
    if (n <= 0) break
    chunks.push(buffer.subarray(0, n))
    if (n < chunkSize) break
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(bytes)
}

function expandSet(set) {
  let result = ''
  let i = 0
  while (i < set.length) {
    if (i < set.length - 2 && set[i + 1] === '-') {
      const start = set.charCodeAt(i)
      const end = set.charCodeAt(i + 2)
      for (let j = start; j <= end; j++) result += String.fromCharCode(j)
      i += 3
    } else {
      result += set[i]
      i++
    }
  }
  return result
}

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    write(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  const positional = []
  let deleteMode = false
  let squeeze = false

  for (const arg of args) {
    if (arg === '-d' || arg === '--delete') deleteMode = true
    else if (arg === '-s' || arg === '--squeeze') squeeze = true
    else if (arg.startsWith('-')) {
      const flags = arg.slice(1).split('')
      if (flags.includes('d')) deleteMode = true
      if (flags.includes('s')) squeeze = true
      const invalid = flags.find(f => f !== 'd' && f !== 's')
      if (invalid) { write(2, new TextEncoder().encode(`tr: invalid option -- '${invalid}'\n`)); return 1 }
    } else {
      positional.push(arg)
    }
  }

  if (positional.length === 0) {
    write(2, new TextEncoder().encode('tr: missing operand\n'))
    return 1
  }

  const set1 = positional[0] || ''
  const set2 = positional[1] || ''
  if (!deleteMode && !squeeze && !set2) {
    write(2, new TextEncoder().encode('tr: missing operand after SET1\n'))
    return 1
  }

  const content = readAllStdin()
  const expandedSet1 = expandSet(set1)
  const expandedSet2 = deleteMode ? '' : expandSet(set2)

  let result = ''
  if (deleteMode) {
    const set1Chars = new Set(expandedSet1)
    for (const char of content) if (!set1Chars.has(char)) result += char
  } else {
    const map = new Map()
    const maxLen = Math.max(expandedSet1.length, expandedSet2.length)
    for (let i = 0; i < maxLen; i++) {
      const from = expandedSet1[i] ?? (expandedSet1.length > 0 ? expandedSet1[expandedSet1.length - 1] : '')
      const to = expandedSet2[i] ?? (expandedSet2.length > 0 ? expandedSet2[expandedSet2.length - 1] : '')
      if (from !== undefined) map.set(from, to || '')
    }
    for (const char of content) result += map.get(char) ?? char
  }

  if (squeeze) {
    let squeezed = ''
    let lastChar = ''
    for (const char of result) {
      if (char !== lastChar || !expandedSet1.includes(char)) squeezed += char
      lastChar = char
    }
    result = squeezed
  }

  write(1, new TextEncoder().encode(result))
  return 0
}

try {
  exit(main())
} catch (error) {
  write(2, new TextEncoder().encode(`tr: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
