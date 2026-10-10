/** Translate, squeeze, or delete characters from stdin. */

const { argv, exit, writeAll, read } = globalThis.ecmaosSyscalls

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
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(bytes)
}

const range = (from, to) => { let out = ''; for (let c = from.charCodeAt(0); c <= to.charCodeAt(0); c++) out += String.fromCharCode(c); return out }
const CLASSES = {
  upper: range('A', 'Z'), lower: range('a', 'z'), digit: range('0', '9'),
  alpha: range('A', 'Z') + range('a', 'z'), alnum: range('0', '9') + range('A', 'Z') + range('a', 'z'),
  xdigit: range('0', '9') + range('A', 'F') + range('a', 'f'),
  space: ' \t\n\r\f\v', blank: ' \t', cntrl: range('\0', '\x1f') + '\x7f',
  punct: range('!', '/') + range(':', '@') + range('[', '`') + range('{', '~'),
  print: range(' ', '~'), graph: range('!', '~'),
}
const ESCAPES = { n: '\n', t: '\t', r: '\r', f: '\f', v: '\v', a: '\x07', b: '\b', '\\': '\\' }

/** SET as the characters it names: backslash escapes, `[:class:]`, and `a-z` ranges. */
function expandSet(set) {
  const tokens = []
  for (let i = 0; i < set.length; i++) {
    const char = set[i]
    if (char === '[' && set[i + 1] === ':') {
      const end = set.indexOf(':]', i + 2)
      const name = end === -1 ? undefined : set.slice(i + 2, end)
      if (name !== undefined && name in CLASSES) { for (const c of CLASSES[name]) tokens.push({ c, plain: false }); i = end + 1; continue }
    }
    if (char === '\\' && i + 1 < set.length) {
      const octal = /^[0-7]{1,3}/.exec(set.slice(i + 1))
      if (octal) { tokens.push({ c: String.fromCharCode(parseInt(octal[0], 8)), plain: false }); i += octal[0].length; continue }
      const next = set[i + 1]
      tokens.push({ c: ESCAPES[next] ?? next, plain: false })
      i++
      continue
    }
    tokens.push({ c: char, plain: true })
  }

  let result = ''
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (i + 2 < tokens.length && tokens[i + 1].plain && tokens[i + 1].c === '-') {
      result += range(token.c, tokens[i + 2].c)
      i += 2
    } else result += token.c
  }
  return result
}

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    writeAll(2, new TextEncoder().encode(usage + '\n'))
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
      if (invalid) { writeAll(2, new TextEncoder().encode(`tr: invalid option -- '${invalid}'\n`)); return 1 }
    } else {
      positional.push(arg)
    }
  }

  if (positional.length === 0) {
    writeAll(2, new TextEncoder().encode('tr: missing operand\n'))
    return 1
  }

  const set1 = positional[0] || ''
  const set2 = positional[1] || ''
  if (!deleteMode && !squeeze && !set2) {
    writeAll(2, new TextEncoder().encode('tr: missing operand after SET1\n'))
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

  writeAll(1, new TextEncoder().encode(result))
  return 0
}

try {
  exit(main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`tr: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
