/**
 * Number the lines of files, as GNU `nl` does: by default only non-empty lines are numbered (`-b t`), the number is six wide
 * and right aligned, and a line that is not numbered is indented by as much so the text lines up. Supports `-b`, `-h` and `-f`
 * (styles `a`, `t`, `n` and `pREGEX`), `-n` (`ln`, `rn`, `rz`), `-w`, `-s`, `-v`, `-i`, `-l`, `-d` and `-p`, with the
 * `\\:\\:\\:`, `\\:\\:` and `\\:` page delimiters that start a header, body and footer section.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, read, getcwd, open, close, isDirectory, O_RDONLY } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`nl: ${text}\n`))

const usage = `Usage: nl [OPTION]... [FILE]...
Write each FILE to standard output, with line numbers added. With no FILE, or when FILE is -, read standard input.

  -b, --body-numbering=STYLE      use STYLE for numbering body lines
  -d, --section-delimiter=CC      use CC for logical page delimiters
  -f, --footer-numbering=STYLE    use STYLE for numbering footer lines
  -h, --header-numbering=STYLE    use STYLE for numbering header lines
  -i, --line-increment=NUMBER     line number increment at each line
  -l, --join-blank-lines=NUMBER   group of NUMBER empty lines counted as one
  -n, --number-format=FORMAT      insert line numbers according to FORMAT (ln, rn, rz)
  -p, --no-renumber               do not reset line numbers for each section
  -s, --number-separator=STRING   add STRING after (possible) line number
  -v, --starting-line-number=NUM  first line number for each section
  -w, --number-width=NUMBER       use NUMBER columns for line numbers
  --help                          display this help and exit

STYLE is one of: a (number all lines), t (number only nonempty lines), n (number no lines), pBRE (number only lines that
match the regular expression BRE).`

const longOptions = {
  '--body-numbering': 'b', '--section-delimiter': 'd', '--footer-numbering': 'f', '--header-numbering': 'h', '--line-increment': 'i',
  '--join-blank-lines': 'l', '--number-format': 'n', '--no-renumber': 'p', '--number-separator': 's', '--starting-line-number': 'v', '--number-width': 'w'
}

function style(text, what) {
  if (text === 'a' || text === 't' || text === 'n') return { kind: text }
  if (text && text[0] === 'p') {
    try { return { kind: 'p', pattern: new RegExp(text.slice(1)) } } catch { /* reported below */ }
  }
  err(`invalid ${what} numbering style: '${text}'`)
  return undefined
}

const decode = bytes => { let text = ''; for (let at = 0; at < bytes.length; at += 8192) text += String.fromCharCode(...bytes.subarray(at, at + 8192)); return text }

function readFd(fd) {
  const chunks = []
  let total = 0
  for (;;) {
    const buffer = new Uint8Array(65536)
    const n = read(fd, buffer, -1)
    if (n <= 0) break
    chunks.push(buffer.subarray(0, n))
    total += n
  }
  const bytes = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length }
  return bytes
}

function main() {
  const args = argv.slice(1)
  const styles = { header: { kind: 'n' }, body: { kind: 't' }, footer: { kind: 'n' } }
  let delimiter = '\\:'
  let increment = 1
  let joinBlank = 1
  let format = 'rn'
  let renumber = true
  let separator = '\t'
  let start = 1
  let width = 6
  const files = []

  const integer = (text, what) => {
    if (!/^-?\d+$/.test(text ?? '')) { err(`invalid ${what}: '${text ?? ''}'`); return undefined }
    return Number(text)
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { files.push(...args.slice(i + 1)); break }
    if (arg === '--help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (arg === '-' || !arg.startsWith('-')) { files.push(arg); continue }

    let flag
    let value
    if (arg.startsWith('--')) {
      const [name, inline] = arg.split(/=(.*)/s)
      flag = longOptions[name]
      if (!flag) { err(`unrecognized option '${arg}'`); err("Try 'nl --help' for more information."); return 1 }
      value = inline
      if (flag !== 'p' && value === undefined) value = args[++i]
    } else {
      flag = arg[1]
      if (!'bdfhilnpsvw'.includes(flag)) { err(`invalid option -- '${flag}'`); err("Try 'nl --help' for more information."); return 1 }
      if (flag !== 'p') value = arg.length > 2 ? arg.slice(2) : args[++i]
    }

    if (flag === 'p') { renumber = false; continue }
    if (value === undefined) { err(`option requires an argument -- '${flag}'`); return 1 }
    if (flag === 'b' || flag === 'h' || flag === 'f') {
      const parsed = style(value, { b: 'body', h: 'header', f: 'footer' }[flag])
      if (!parsed) return 1
      styles[{ b: 'body', h: 'header', f: 'footer' }[flag]] = parsed
    } else if (flag === 'd') {
      if (value.length === 0 || value.length > 2) { err('invalid section delimiter'); return 1 }
      delimiter = value.length === 1 ? value + ':' : value
    } else if (flag === 'n') {
      if (!['ln', 'rn', 'rz'].includes(value)) { err(`invalid line numbering format: '${value}'`); return 1 }
      format = value
    } else if (flag === 's') separator = value
    else {
      const number = integer(value, { i: 'line number increment', l: 'line number of blank lines', v: 'starting line number', w: 'line number field width' }[flag])
      if (number === undefined) return 1
      if (flag === 'i') increment = number
      else if (flag === 'l') joinBlank = number
      else if (flag === 'v') start = number
      else if (flag === 'w') { if (number < 1) { err(`invalid line number field width: '${value}'`); return 1 } width = number }
    }
  }

  const cwd = getcwd()
  let number = start
  let section = 'body'
  let blankRun = 0
  let failed = false
  const out = []

  const render = n => (format === 'ln' ? String(n).padEnd(width) : format === 'rz' ? (n < 0 ? '-' + String(-n).padStart(width - 1, '0') : String(n).padStart(width, '0')) : String(n).padStart(width))

  const numbered = (line, kind) => {
    if (kind.kind === 'a') return true
    if (kind.kind === 'n') return false
    if (kind.kind === 't') return line !== ''
    return kind.pattern.test(line)
  }

  const handle = text => {
    if (text === '') return
    const lines = text.split('\n')
    const endsWithNewline = lines[lines.length - 1] === ''
    if (endsWithNewline) lines.pop()
    for (const line of lines) {
      // A line made of a delimiter, twice or three times over, starts a header, a body or a footer
      const sections = { [delimiter.repeat(3)]: 'header', [delimiter.repeat(2)]: 'body', [delimiter]: 'footer' }
      if (sections[line]) {
        section = sections[line]
        if (renumber) number = start
        blankRun = 0
        out.push('\n')
        continue
      }
      const kind = styles[section]
      let count = numbered(line, kind)
      if (line === '' && kind.kind === 'a') {
        // With `-l N` only every Nth empty line in a run is numbered
        blankRun++
        count = blankRun >= joinBlank
        if (count) blankRun = 0
      } else blankRun = 0
      if (count) { out.push(render(number) + separator + line + '\n'); number += increment }
      else out.push(' '.repeat(width + separator.length) + line + '\n')
    }
  }

  if (files.length === 0) files.push('-')
  for (const file of files) {
    try {
      if (file === '-') { handle(decode(readFd(0))); continue }
      const fullPath = resolve(cwd, file)
      if (isDirectory(fullPath)) { err(`${file}: Is a directory`); failed = true; continue }
      const fd = open(fullPath, O_RDONLY)
      try { handle(decode(readFd(fd))) } finally { close(fd) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      err(`${file}: ${/ENOENT/.test(message) ? 'No such file or directory' : /EACCES/.test(message) ? 'Permission denied' : message}`)
      failed = true
    }
  }

  writeAll(1, Uint8Array.from(out.join(''), ch => ch.charCodeAt(0)))
  return failed ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
