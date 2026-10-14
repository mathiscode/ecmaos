/**
 * Translate, squeeze, or delete characters from stdin, as GNU `tr` does, on bytes. A set is made of characters, ranges
 * (`a-z`), classes (`[:alpha:]`), equivalence classes (`[=a=]`), repeats (`[c*3]`, `[c*]` in SET2) and escapes (`\n`, `\t`,
 * `\\`, `\NNN` octal). `-c` complements SET1, `-d` deletes, `-s` squeezes repeats of the last set, `-t` truncates SET1 to the
 * length of SET2. Input is processed as it is read.
 */

const { argv, exit, writeAll, read } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`tr: ${text}\n`))

const usage = `Usage: tr [OPTION]... SET1 [SET2]
Translate, squeeze, and/or delete characters from standard input, writing to standard output.

  -c, -C, --complement    use the complement of SET1
  -d, --delete            delete characters in SET1, do not translate
  -s, --squeeze-repeats   replace each sequence of a repeated character that is listed in the last specified SET, with a single occurrence of that character
  -t, --truncate-set1     first truncate SET1 to length of SET2
  --help                  display this help and exit

SETs are specified as strings of characters. Interpreted sequences are:
  \\NNN            character with octal value NNN (1 to 3 octal digits)
  \\\\              backslash
  \\a \\b \\f \\n \\r \\t \\v   the usual escapes
  CHAR1-CHAR2     all characters from CHAR1 to CHAR2 in ascending order
  [CHAR*]         in SET2, copies of CHAR until length of SET1
  [CHAR*REPEAT]   REPEAT copies of CHAR, REPEAT octal if starting with 0
  [:alnum:] [:alpha:] [:blank:] [:cntrl:] [:digit:] [:graph:] [:lower:] [:print:] [:punct:] [:space:] [:upper:] [:xdigit:]
  [=CHAR=]        all characters which are equivalent to CHAR`

const classes = {
  alnum: b => (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122),
  alpha: b => (b >= 65 && b <= 90) || (b >= 97 && b <= 122),
  blank: b => b === 32 || b === 9,
  cntrl: b => b < 32 || b === 127,
  digit: b => b >= 48 && b <= 57,
  graph: b => b > 32 && b < 127,
  lower: b => b >= 97 && b <= 122,
  print: b => b >= 32 && b < 127,
  punct: b => (b > 32 && b < 127) && !((b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122)),
  space: b => b === 32 || (b >= 9 && b <= 13),
  upper: b => b >= 65 && b <= 90,
  xdigit: b => (b >= 48 && b <= 57) || (b >= 65 && b <= 70) || (b >= 97 && b <= 102)
}

const simpleEscapes = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92 }

/** A set as a list of items: `{ byte }`, `{ repeat: byte, count }` (count `undefined` for `[c*]`), in order; or `{ error }` */
function parseSet(text) {
  // The operand arrives as UTF-8 text; work on its bytes
  const input = Array.from(encoder.encode(text), b => String.fromCharCode(b))
  const items = []
  let i = 0

  const readChar = () => {
    if (input[i] === '\\') {
      const next = input[i + 1]
      if (next === undefined) { i += 1; return 92 }
      if (/[0-7]/.test(next)) {
        let digits = ''
        let k = i + 1
        while (digits.length < 3 && /[0-7]/.test(input[k] ?? '')) digits += input[k++]
        i = k
        return parseInt(digits, 8) & 255
      }
      i += 2
      return next in simpleEscapes ? simpleEscapes[next] : next.charCodeAt(0)
    }
    return input[i++].charCodeAt(0)
  }

  while (i < input.length) {
    if (input[i] === '[' && input[i + 1] === ':') {
      const end = input.indexOf(':', i + 2)
      if (end > 0 && input[end + 1] === ']') {
        const name = input.slice(i + 2, end).join('')
        if (!(name in classes)) return { error: `invalid character class '${name}'` }
        for (let b = 0; b < 256; b++) if (classes[name](b)) items.push({ byte: b, cls: name })
        i = end + 2
        continue
      }
    }
    if (input[i] === '[' && input[i + 1] === '=') {
      const end = input.indexOf('=', i + 3)
      if (end > 0 && input[end + 1] === ']' && end === i + 3) {
        items.push({ byte: input[i + 2].charCodeAt(0) })
        i = end + 2
        continue
      }
    }
    if (input[i] === '[') {
      // [c*n] and [c*]
      const save = i
      i++
      const byte = i < input.length ? readChar() : undefined
      if (byte !== undefined && input[i] === '*') {
        let k = i + 1
        let digits = ''
        while (k < input.length && /[0-9]/.test(input[k])) digits += input[k++]
        if (input[k] === ']') {
          items.push({ repeat: byte, count: digits === '' ? undefined : parseInt(digits, digits[0] === '0' ? 8 : 10) })
          i = k + 1
          continue
        }
      }
      i = save
    }
    const from = readChar()
    if (input[i] === '-' && i + 1 < input.length) {
      i++
      const to = readChar()
      if (to < from) return { error: `range-endpoints of '${String.fromCharCode(from)}-${String.fromCharCode(to)}' are in reverse collating sequence order` }
      for (let b = from; b <= to; b++) items.push({ byte: b })
    } else items.push({ byte: from })
  }
  return { items }
}

function main() {
  const args = argv.slice(1)
  let complement = false
  let remove = false
  let squeeze = false
  let truncate = false
  const sets = []
  let optionsEnded = false

  for (const arg of args) {
    if (!optionsEnded && arg === '--') optionsEnded = true
    else if (!optionsEnded && arg === '--help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    else if (!optionsEnded && arg === '--complement') complement = true
    else if (!optionsEnded && arg === '--delete') remove = true
    else if (!optionsEnded && arg === '--squeeze-repeats') squeeze = true
    else if (!optionsEnded && arg === '--truncate-set1') truncate = true
    else if (!optionsEnded && arg.startsWith('--')) { err(`unrecognized option '${arg}'`); err("Try 'tr --help' for more information."); return 1 }
    else if (!optionsEnded && arg.startsWith('-') && arg.length > 1) {
      for (const flag of arg.slice(1)) {
        if (flag === 'c' || flag === 'C') complement = true
        else if (flag === 'd') remove = true
        else if (flag === 's') squeeze = true
        else if (flag === 't') truncate = true
        else { err(`invalid option -- '${flag}'`); err("Try 'tr --help' for more information."); return 1 }
      }
    } else sets.push(arg)
  }

  const needed = remove && squeeze ? 2 : remove ? 1 : squeeze ? 1 : 2
  if (sets.length === 0) { err('missing operand'); err("Try 'tr --help' for more information."); return 1 }
  if (sets.length > 2) { err(`extra operand '${sets[2]}'`); err("Try 'tr --help' for more information."); return 1 }
  if (sets.length < needed) {
    err(`missing operand after '${sets[sets.length - 1]}'`)
    err(`Two strings must be given when ${squeeze && remove ? 'both deleting and squeezing repeats' : 'translating'}.`)
    err("Try 'tr --help' for more information.")
    return 1
  }
  if (sets.length === 2 && remove && !squeeze) { err(`extra operand '${sets[1]}'`); err('Only one string may be given when deleting without squeezing repeats.'); err("Try 'tr --help' for more information."); return 1 }

  const first = parseSet(sets[0])
  if (first.error) { err(first.error); return 1 }
  const second = sets.length > 1 ? parseSet(sets[1]) : undefined
  if (second?.error) { err(second.error); return 1 }

  // SET1 as a list of bytes (its complement, in ascending order, with -c)
  let set1 = []
  for (const item of first.items) {
    if (item.repeat !== undefined) { err('the [c*] construct may appear in string2 only'); return 1 }
    set1.push(item.byte)
  }
  if (complement) {
    const present = new Set(set1)
    set1 = []
    for (let b = 0; b < 256; b++) if (!present.has(b)) set1.push(b)
  }

  // SET2 as a list of bytes, with `[c*]` filling to the length of SET1
  let set2 = []
  if (second) {
    const fixed = second.items.reduce((sum, item) => sum + (item.repeat === undefined ? 1 : item.count ?? 0), 0)
    const fillers = second.items.filter(item => item.repeat !== undefined && item.count === undefined).length
    if (fillers > 1) { err('only one [c*] repeat construct may appear in string2'); return 1 }
    for (const item of second.items) {
      if (item.repeat === undefined) set2.push(item.byte)
      else for (let n = 0; n < (item.count ?? Math.max(0, set1.length - fixed)); n++) set2.push(item.repeat)
    }
  }

  const translate = new Int16Array(256).fill(-1)
  const inSet1 = new Uint8Array(256)
  for (const b of set1) inSet1[b] = 1
  const squeezeSet = new Uint8Array(256)

  if (remove) {
    if (squeeze && set2.length) for (const b of set2) squeezeSet[b] = 1
    else if (squeeze) for (const b of set1) squeezeSet[b] = 1
  } else if (second) {
    if (set2.length === 0 && set1.length) { err(`when not truncating set1, string2 must be non-empty`); return 1 }
    if (truncate) set1 = set1.slice(0, set2.length)
    // A shorter SET2 is padded with its last byte
    while (set2.length < set1.length) set2.push(set2[set2.length - 1])
    // With -c, GNU maps in ascending order of the complement; a repeated byte in SET1 keeps its first mapping
    const seen = new Uint8Array(256)
    set1.forEach((b, index) => { if (!seen[b]) { seen[b] = 1; translate[b] = set2[index] } })
    for (const b of set2) squeezeSet[b] = 1
    if (!squeeze) squeezeSet.fill(0)
  } else if (squeeze) for (const b of set1) squeezeSet[b] = 1

  let previous = -1
  const buffer = new Uint8Array(65536)
  for (;;) {
    const n = read(0, buffer, -1)
    if (n <= 0) break
    const out = new Uint8Array(n)
    let length = 0
    for (let i = 0; i < n; i++) {
      let byte = buffer[i]
      if (remove) { if (inSet1[byte]) continue }
      else if (second && translate[byte] >= 0) byte = translate[byte]
      if (squeezeSet[byte] && byte === previous) continue
      previous = byte
      out[length++] = byte
    }
    if (length) writeAll(1, out.subarray(0, length))
  }
  return 0
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
