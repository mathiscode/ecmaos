/**
 * `fmt`: reformat paragraphs, as GNU fmt does. A paragraph is a run of lines with the same indentation (and `-p` prefix); its
 * words are broken into lines by a cost search that keeps lines near the goal width (93% of `-w`, 75 by default), likes
 * to break after the end of a sentence or a punctuation mark and dislikes lines of very different lengths. `-s` splits only,
 * `-u` gives one space between words and two after a sentence, `-c` keeps the indentation of the first two lines, `-t` is for
 * tagged paragraphs, `-p` limits the work to lines that start with a prefix.
 *
 * Where several breakings have close costs the result can differ from GNU's, whose constants are tuned by hand; they were
 * fitted here against the real tool.
 */

import { readFdBytes, readFileBytes, writeFdBytes } from './lib/bytes.mjs'
import { getopt } from './lib/getopt.mjs'
import { reasonOf } from './lib/errno.mjs'
import { resolve } from './lib/path-utils.mjs'

const { argv, exit, getcwd } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeFdBytes(2, encoder.encode(`fmt: ${text}\n`))

const usage = `Usage: fmt [-WIDTH] [OPTION]... [FILE]...
Reformat each paragraph in the FILE(s), writing to standard output.
The option -WIDTH is an abbreviated form of --width=DIGITS.

With no FILE, or when FILE is -, read standard input.

Mandatory arguments to long options are mandatory for short options too.
  -c, --crown-margin
         preserve indentation of first two lines
  -p, --prefix=STRING
         reformat only lines beginning with STRING,
         reattaching the prefix to reformatted lines
  -s, --split-only
         split long lines, but do not refill
  -t, --tagged-paragraph
         indentation of first line different from second
  -u, --uniform-spacing
         one space between words, two after sentences
  -w, --width=WIDTH
         maximum line width (default of 75 columns)
  -g, --goal=WIDTH
         goal width (default of 93% of width)
      --help        display this help and exit
      --version     output version information and exit`

// costs, in the units of (departure from the goal width * 10) squared
const SHORT = 100
const RAGGED = 0
const LINE_COST = 0
const SENTENCE_BONUS = 1250
const NOBREAK_COST = 667000
const PUNCT_BONUS = 1320
const PAREN_BONUS = 100
const WIDOW = 22000
const ORPHAN = 15500
const LAST_WORD = 20000

const INFINITY = Number.MAX_SAFE_INTEGER

/** Columns of leading white space (tabs to multiples of 8) and where the text starts */
function indentOf(line) {
  let column = 0
  let at = 0
  for (; at < line.length; at++) {
    if (line[at] === ' ') column++
    else if (line[at] === '\t') column = (Math.floor(column / 8) + 1) * 8
    else break
  }
  return { column, at }
}

/** The words of a stretch of text: `{ text, length, space, period, punct, paren, final }` (`space` is what followed, in columns) */
function wordsOf(text, uniform, endsSentenceAtEnd = true) {
  const words = []
  const pattern = /(\S+)([ \t]*)/g
  let match
  while ((match = pattern.exec(text))) {
    const word = match[1]
    const last = word[word.length - 1]
    const trailing = word.replace(/["')\]]+$/, '')
    const lastCore = trailing[trailing.length - 1]
    const atEnd = match.index + match[0].length >= text.length
    let spaces = 0
    for (const ch of match[2]) spaces = ch === '\t' ? (Math.floor((match.index + word.length + spaces) / 8) + 1) * 8 - (match.index + word.length) : spaces + 1
    const period = lastCore === '.' || lastCore === '?' || lastCore === '!'
    const entry = {
      text: word,
      length: Array.from(word).length,
      period,
      punct: !period && (last === ',' || last === ';' || last === ':' || /[,;:]/.test(lastCore ?? '')),
      paren: word[0] === '(' || word[0] === '[',
      final: period && ((atEnd && endsSentenceAtEnd) || spaces >= 2),
      space: spaces
    }
    entry.space = entry.final ? 2 : atEnd ? 1 : Math.max(1, spaces)
    if (uniform) entry.space = entry.final ? 2 : 1
    words.push(entry)
  }
  return words
}

/** Breaks `words` into lines: `{ from, to }` pairs; `first` and `other` are the indentation of the first and the other lines */
function breakLines(words, { width, goal, first, other }) {
  const n = words.length
  const best = new Array(n + 1).fill(0)
  const nextBreak = new Array(n + 1).fill(n)
  const lineLength = new Array(n + 1).fill(0)
  const baseCost = index => {
    let cost = LINE_COST
    if (index > 0) {
      const previous = words[index - 1]
      if (previous.period) cost += previous.final ? -SENTENCE_BONUS : NOBREAK_COST
      else if (previous.punct) cost -= PUNCT_BONUS
      else if (index > 1 && words[index - 2].final) cost += Math.floor(WIDOW / (previous.length + 2))
    }
    // the last word of the paragraph left alone on its line
    if (index === n - 1 && n > 1) cost += Math.floor(LAST_WORD / (words[index].length + 2))
    const word = words[index]
    if (word.paren) cost -= PAREN_BONUS
    else if (word.final) cost += Math.floor(ORPHAN / (word.length + 2))
    return cost
  }
  for (let start = n - 1; start >= 0; start--) {
    let bestCost = INFINITY
    let length = (start === 0 ? first : other) + words[start].length
    let w = start
    for (;;) {
      w++
      let lineCost = 0
      if (w < n) {
        const shortfall = goal - length
        lineCost = SHORT * shortfall * shortfall
        const difference = length - lineLength[w]
        lineCost += RAGGED * difference * difference
      }
      const cost = lineCost + best[w]
      if (bestCost > cost) { bestCost = cost; nextBreak[start] = w; lineLength[start] = length }
      if (w === n) break
      length += words[w - 1].space + words[w].length
      if (length > width) break
    }
    best[start] = bestCost + baseCost(start)
  }
  const lines = []
  for (let i = 0; i < n;) { lines.push({ from: i, to: nextBreak[i] }); i = nextBreak[i] }
  return lines
}

function main() {
  // -WIDTH
  const args = argv.slice(1).map(arg => (/^-\d+$/.test(arg) ? `--width=${arg.slice(1)}` : arg))
  const { options, operands, error } = getopt(args, {
    short: 'cstuw:p:g:x',
    long: { 'crown-margin': 'c', 'split-only': 's', 'tagged-paragraph': 't', 'uniform-spacing': 'u', width: { key: 'w', arg: 'required' }, prefix: { key: 'p', arg: 'required' }, goal: { key: 'g', arg: 'required' }, help: 'help', version: 'version' }
  })
  if (error) { err(error); writeFdBytes(2, encoder.encode("Try 'fmt --help' for more information.\n")); return 1 }
  const o = { crown: false, split: false, tagged: false, uniform: false, width: 75, goal: undefined, prefix: '' }
  for (const [key, value] of options) {
    if (key === 'help') { writeFdBytes(1, encoder.encode(usage + '\n')); return 0 }
    if (key === 'version') { writeFdBytes(1, encoder.encode('fmt (ecmaOS coreutils)\n')); return 0 }
    if (key === 'c') o.crown = true
    else if (key === 's') o.split = true
    else if (key === 't') o.tagged = true
    else if (key === 'u') o.uniform = true
    else if (key === 'p') o.prefix = value
    else if (key === 'w') { if (!/^\d+$/.test(value)) { err(`invalid width: ‘${value}’`); return 1 } o.width = Number(value) }
    else if (key === 'g') { if (!/^\d+$/.test(value)) { err(`invalid width: ‘${value}’`); return 1 } o.goal = Number(value) }
  }
  if (o.goal === undefined) o.goal = Math.floor(o.width * 187 / 200)
  else if (o.goal > o.width) { err(`invalid width: ‘${o.goal}’: Value too large for defined data type`); return 1 }
  const width = Math.min(o.width, 2500)
  const files = operands.length ? operands : ['-']
  const cwd = getcwd()
  let status = 0
  let out = ''
  let tabs = false

  for (const name of files) {
    let bytes
    try { bytes = name === '-' ? readFdBytes(0) : readFileBytes(resolve(cwd, name)) } catch (e) {
      err(`cannot open ‘${name}’ for reading: ${reasonOf(e)}`.replace('‘', "'").replace('’', "'"))
      status = 1
      continue
    }
    const text = new TextDecoder().decode(bytes)
    const lines = text === '' ? [] : text.split('\n')
    if (lines.length && lines[lines.length - 1] === '') lines.pop()
    // a line's prefix, indentation and words
    const parse = line => {
      if (o.prefix && !line.startsWith(o.prefix)) return { plain: true, line }
      const body = o.prefix ? line.slice(o.prefix.length) : line
      const { column, at } = indentOf(body)
      if (/^[ \t]*[\t]/.test(body)) tabs = true
      return { plain: false, indent: column, text: body.slice(at), blank: body.slice(at).trim() === '' }
    }
    const parsed = lines.map(parse)
    const emit = (line, indent, ws) => {
      // the indentation with tabs where the output used them in its input
      let prefixText = o.prefix
      let column = 0
      let lead = ''
      const spaceTo = target => {
        let result = ''
        if (tabs) {
          const stop = Math.floor(target / 8) * 8
          if (column + 1 < stop) while (column < stop) { result += '\t'; column = (Math.floor(column / 8) + 1) * 8 }
        }
        while (column < target) { result += ' '; column++ }
        return result
      }
      lead = spaceTo(indent)
      let text = prefixText + lead
      column = indent
      for (let k = line.from; k < line.to; k++) {
        const word = ws[k]
        text += word.text
        column += word.length
        if (k < line.to - 1) text += spaceTo(column + word.space)
      }
      return text + '\n'
    }
    let i = 0
    while (i < parsed.length) {
      const entry = parsed[i]
      if (entry.plain) { out += entry.line + '\n'; i++; continue }
      if (entry.blank) { out += '\n'; i++; continue }
      const firstIndent = entry.indent
      const members = [entry]
      let otherIndent = firstIndent
      let j = i + 1
      const usable = line => line && !line.plain && !line.blank
      if (o.split) {
        // each line stands alone, split if it is too long
        // split only: broken like any paragraph, but the end of the line does not end a sentence
        const ws = wordsOf(entry.text, o.uniform, false)
        for (const l of breakLines(ws, { width, goal: o.goal, first: firstIndent, other: firstIndent })) out += emit(l, firstIndent, ws)
        i++
        continue
      }
      if (o.crown || o.tagged) {
        const second = parsed[j]
        if (usable(second) && (!o.tagged || second.indent !== firstIndent)) {
          otherIndent = second.indent
          members.push(second)
          j++
        } else if (o.tagged) otherIndent = firstIndent === 0 ? 3 : 0
      }
      while (usable(parsed[j]) && parsed[j].indent === otherIndent) { members.push(parsed[j]); j++ }
      const ws = []
      for (const member of members) {
        const memberWords = wordsOf(member.text, o.uniform)
        if (memberWords.length) ws.push(...memberWords)
      }
      if (ws.length === 0) { i = j; continue }
      const broken = breakLines(ws, { width, goal: o.goal, first: firstIndent, other: otherIndent })
      broken.forEach((l, index) => { out += emit(l, index === 0 ? firstIndent : otherIndent, ws) })
      i = j
    }
  }
  writeFdBytes(1, encoder.encode(out))
  return status
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
