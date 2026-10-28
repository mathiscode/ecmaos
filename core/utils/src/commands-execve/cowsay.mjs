/**
 * `cowsay` and `cowthink`: a cow, or another creature, saying (or thinking) a message in a balloon, as cowsay 3 draws
 * it. The creatures are `.cow` files on `COWPATH` (`/usr/share/cows`), in cowsay's own format, so the cows of other
 * collections work as they are: a Perl heredoc assigned to `$the_cow`, in which `$eyes`, `$tongue` and `$thoughts` are
 * filled in and `\\` is a backslash. Code a cow file runs besides that is not run.
 */

import { reasonOf } from './lib/errno.mjs'
import { readFdText, readTextFile } from './lib/fs-text.mjs'
import { getopt, tryHelp } from './lib/getopt.mjs'

const { argv, env, exit, writeAll, readdir } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const think = (argv[0] ?? '').split('/').pop() === 'cowthink'
const name = think ? 'cowthink' : 'cowsay'
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`${name}: ${text}\n`))

const usage = `Usage: ${name} [-bdgpstwy] [-h] [-e eyes] [-f cowfile] [-l] [-n] [-T tongue] [-W wrapcolumn] [message]
A cow ${think ? 'thinking' : 'saying'} the message, or standard input.

  -e EYES     the cow's eyes (two characters; default oo)
  -T TONGUE   its tongue (two characters; default none)
  -f COWFILE  another creature: a name on COWPATH, or a path to a .cow file
  -l          list the creatures on COWPATH
  -n          keep the message's lines as they are (no wrapping)
  -W COLUMN   wrap the message at COLUMN (default 40)
  -b -d -g -p -s -t -w -y
              borg, dead, greedy, paranoid, stoned, tired, wired and youthful eyes
  -h          display this help and exit`

// The modes' eyes and tongues, as cowsay has them
const MODES = { b: ['==', '  '], d: ['xx', 'U '], g: ['$$', '  '], p: ['@@', '  '], s: ['**', 'U '], t: ['--', '  '], w: ['OO', '  '], y: ['..', '  '] }

const cowpath = () => (env.COWPATH || '/usr/share/cows').split(':').filter(Boolean)

function listCows() {
  for (const dir of cowpath()) {
    let names
    try { names = readdir(dir) } catch { continue }
    const cows = names.filter(file => file.endsWith('.cow')).map(file => file.slice(0, -4)).sort()
    out(`Cow files in ${dir}:\n${wrapWords(cows, 79).join('\n')}\n`)
  }
}

function findCow(cow) {
  if (cow.includes('/')) return cow
  for (const dir of cowpath()) {
    const path = `${dir}/${cow.endsWith('.cow') ? cow : `${cow}.cow`}`
    try { readTextFile(path); return path } catch {}
  }
  return undefined
}

/** The picture a .cow file draws: its `$the_cow` heredoc with the variables put in */
function drawCow(text, { eyes, tongue, thoughts }) {
  const head = /\$the_cow\s*=\s*<<\s*(["']?)(\w+)\1\s*;?[^\n]*\n/.exec(text)
  if (!head) throw new Error('not a cow file (no $the_cow = <<EOC)')
  const body = text.slice(head.index + head[0].length)
  const end = new RegExp(`^${head[2]}\\s*$`, 'm').exec(body)
  const picture = end ? body.slice(0, end.index) : body
  // a single-quoted heredoc is taken as it is; otherwise Perl's interpolation: the three variables, and escapes
  if (head[1] === "'") return picture
  return picture.replace(/\\(.)|\$\{(eyes|tongue|thoughts)\}|\$(eyes|tongue|thoughts)\b/g, (match, escaped, braced, bare) => {
    if (escaped !== undefined) return escaped
    return { eyes, tongue, thoughts }[braced ?? bare]
  })
}

const expandTabs = line => line.replace(/[^\t]*\t/g, chunk => chunk.slice(0, -1).padEnd((Math.floor((chunk.length - 1) / 8) + 1) * 8))
const width = text => [...text].length

/** `words` filled into lines of at most `columns - 1` characters, as Perl's Text::Wrap fills them */
function wrapWords(words, columns) {
  const lines = []
  let line = ''
  for (let word of words) {
    while (width(word) > columns - 1) {
      if (line) { lines.push(line); line = '' }
      lines.push([...word].slice(0, columns - 1).join(''))
      word = [...word].slice(columns - 1).join('')
    }
    if (!word) continue
    if (!line) line = word
    else if (width(line) + 1 + width(word) <= columns - 1) line += ` ${word}`
    else { lines.push(line); line = word }
  }
  if (line) lines.push(line)
  return lines
}

/** The message as the balloon's lines: wrapped paragraph by paragraph, or as it is with -n */
function messageLines(text, { wrap, columns }) {
  const lines = text.replace(/\n$/, '').split('\n').map(expandTabs)
  if (!wrap) return lines
  const result = []
  let paragraph = []
  const flush = () => { if (paragraph.length) result.push(...wrapWords(paragraph.join(' ').split(/\s+/).filter(Boolean), columns)); paragraph = [] }
  for (const line of lines) {
    if (line.trim() === '') { flush(); result.push(''); continue }
    paragraph.push(line)
  }
  flush()
  return result.length ? result : ['']
}

function balloon(lines) {
  const longest = Math.max(...lines.map(width))
  const pad = line => line + ' '.repeat(longest - width(line))
  const rows = [` ${'_'.repeat(longest + 2)}`]
  if (think) rows.push(...lines.map(line => `( ${pad(line)} )`))
  else if (lines.length === 1) rows.push(`< ${pad(lines[0])} >`)
  else rows.push(...lines.map((line, i) => {
    const [left, right] = i === 0 ? ['/', '\\'] : i === lines.length - 1 ? ['\\', '/'] : ['|', '|']
    return `${left} ${pad(line)} ${right}`
  }))
  rows.push(` ${'-'.repeat(longest + 2)}`)
  return rows.join('\n') + '\n'
}

function main() {
  const { options, operands, error } = getopt(argv.slice(1), { short: 'bdgpstwyhe:f:lnT:W:', long: { help: 'h' }, permute: false })
  if (error) { err(error); writeAll(2, encoder.encode(tryHelp(name) + '\n')); return 1 }
  let eyes = 'oo'
  let tongue = '  '
  let cow = 'default'
  let wrap = true
  let columns = 40
  for (const [key, value] of options) {
    if (key === 'h') { out(usage + '\n'); return 0 }
    if (key === 'l') { listCows(); return 0 }
    if (MODES[key]) [eyes, tongue] = MODES[key]
    else if (key === 'e') eyes = [...value, ' ', ' '].slice(0, 2).join('')
    else if (key === 'T') tongue = [...value, ' ', ' '].slice(0, 2).join('')
    else if (key === 'f') cow = value
    else if (key === 'n') wrap = false
    else if (key === 'W') {
      columns = Number(value)
      if (!Number.isInteger(columns) || columns < 2) { err(`invalid wrap column '${value}'`); return 1 }
    }
  }
  const path = findCow(cow)
  if (!path) { err(`could not find ${cow} cowfile!`); return 1 }
  let picture
  try { picture = drawCow(readTextFile(path), { eyes, tongue, thoughts: think ? 'o' : '\\' }) } catch (e) { err(`${cow}: ${e.code ? reasonOf(e) : e.message}`); return 1 }
  const text = operands.length ? operands.join(' ') : readFdText(0)
  out(balloon(messageLines(text, { wrap, columns })) + picture)
  return 0
}

exit(main())
