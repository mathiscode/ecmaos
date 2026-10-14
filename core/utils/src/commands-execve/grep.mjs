/**
 * Search files for lines matching a pattern, as GNU `grep` does: basic regular expressions by default, `-E` extended, `-F` fixed
 * strings, `-P` as JavaScript; `-e` and `-f` for several patterns; `-i -v -w -x`; `-c -l -L -o -q -s -m -b -n -H -h`; `-A -B -C`
 * context with `--` between groups; `-r` and `-R` for directories; and colors. Exit status 0 when a line was selected, 1 when
 * none was, 2 on an error (unless `-q` found a match).
 */

import { resolve } from './lib/path-utils.mjs'
import { isTty } from './lib/tty.mjs'
import { toBytes, translate } from './lib/regex-posix.mjs'

const { argv, env, exit, writeAll, read, getcwd, open, close, readdir, isDirectory, isSymbolicLink, O_RDONLY } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`grep: ${text}\n`))

const usage = `Usage: grep [OPTION]... PATTERNS [FILE]...
Search for PATTERNS in each FILE. PATTERNS can contain multiple patterns separated by newlines.

Pattern selection and interpretation:
  -E, --extended-regexp     PATTERNS are extended regular expressions
  -F, --fixed-strings       PATTERNS are strings
  -G, --basic-regexp        PATTERNS are basic regular expressions
  -P, --perl-regexp         PATTERNS are JavaScript regular expressions
  -e, --regexp=PATTERNS     use PATTERNS for matching
  -f, --file=FILE           take PATTERNS from FILE
  -i, --ignore-case         ignore case distinctions in patterns and data
  -w, --word-regexp         match only whole words
  -x, --line-regexp         match only whole lines
Miscellaneous:
  -s, --no-messages         suppress error messages
  -v, --invert-match        select non-matching lines
Output control:
  -m, --max-count=NUM       stop after NUM selected lines
  -b, --byte-offset         print the byte offset with output lines
  -n, --line-number         print line number with output lines
  -H, --with-filename       print file name with output lines
  -h, --no-filename         suppress the file name prefix on output
  -o, --only-matching       show only nonempty parts of lines that match
  -q, --quiet, --silent     suppress all normal output
  -L, --files-without-match print only names of FILEs with no selected lines
  -l, --files-with-matches  print only names of FILEs with selected lines
  -c, --count               print only a count of selected lines per FILE
      --color[=WHEN]        use markers to highlight the matching strings; WHEN is 'always', 'never', or 'auto'
  -a, --text                process a binary file as if it were text
  -z, --null-data           a data line ends in 0 byte, not newline
Context control:
  -B, --before-context=NUM  print NUM lines of leading context
  -A, --after-context=NUM   print NUM lines of trailing context
  -C, --context=NUM         print NUM lines of output context
  -NUM                      same as --context=NUM
File and directory selection:
  -r, --recursive           like --directories=recurse
  -R, --dereference-recursive  likewise, but follow all symlinks
      --include=GLOB        search only files that match GLOB
      --exclude=GLOB        skip files that match GLOB
      --exclude-dir=GLOB    skip directories that match GLOB
  --help                    display this help and exit`

const decode = bytes => { let text = ''; for (let at = 0; at < bytes.length; at += 8192) text += String.fromCharCode(...bytes.subarray(at, at + 8192)); return text }
const encodeLatin1 = text => Uint8Array.from(text, ch => ch.charCodeAt(0))

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

/** A shell glob (`*`, `?`, `[...]`) as a regular expression, for --include and --exclude */
const globToRegex = glob => new RegExp('^' + glob.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')

function main() {
  const args = argv.slice(1)
  let mode = 'basic'
  const patterns = []
  let patternGiven = false
  let ignoreCase = false
  let invert = false
  let wordMatch = false
  let lineMatch = false
  let quiet = false
  let noMessages = false
  let countOnly = false
  let listMatching = false
  let listNonMatching = false
  let onlyMatching = false
  let maxCount = Infinity
  let byteOffset = false
  let lineNumbers = false
  let withFilename
  let before = 0
  let after = 0
  let recursive = false
  let dereference = false
  let binaryAsText = false
  let zero = false
  let colorWhen = 'never'
  const includes = []
  const excludes = []
  const excludeDirs = []
  const operands = []

  const integer = (text, what) => {
    if (!/^\d+$/.test(text ?? '')) { err(`${text ?? ''}: invalid ${what} argument`); return undefined }
    return Number(text)
  }
  const addPatterns = text => { patternGiven = true; patterns.push(...text.split('\n')) }
  const readPatternFile = file => {
    try {
      const fd = file === '-' ? 0 : open(resolve(getcwd(), file), O_RDONLY)
      let text
      try { text = decode(readFd(fd)) } finally { if (fd > 2) close(fd) }
      patternGiven = true
      if (text !== '') { const lines = text.split('\n'); if (lines[lines.length - 1] === '') lines.pop(); patterns.push(...lines) }
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      err(`${file}: ${/ENOENT/.test(message) ? 'No such file or directory' : message}`)
      return false
    }
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { operands.push(...args.slice(i + 1)); break }
    if (arg === '--help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (arg === '-' || !arg.startsWith('-')) { operands.push(arg); continue }

    if (arg.startsWith('--')) {
      const [name, inline] = arg.split(/=(.*)/s)
      const value = () => (inline !== undefined ? inline : args[++i])
      const simple = {
        '--extended-regexp': () => { mode = 'extended' }, '--fixed-strings': () => { mode = 'fixed' }, '--basic-regexp': () => { mode = 'basic' }, '--perl-regexp': () => { mode = 'perl' },
        '--ignore-case': () => { ignoreCase = true }, '--no-ignore-case': () => { ignoreCase = false }, '--word-regexp': () => { wordMatch = true }, '--line-regexp': () => { lineMatch = true },
        '--no-messages': () => { noMessages = true }, '--invert-match': () => { invert = true }, '--byte-offset': () => { byteOffset = true }, '--line-number': () => { lineNumbers = true },
        '--with-filename': () => { withFilename = true }, '--no-filename': () => { withFilename = false }, '--only-matching': () => { onlyMatching = true },
        '--quiet': () => { quiet = true }, '--silent': () => { quiet = true }, '--files-without-match': () => { listNonMatching = true; listMatching = false },
        '--files-with-matches': () => { listMatching = true; listNonMatching = false }, '--count': () => { countOnly = true }, '--text': () => { binaryAsText = true },
        '--null-data': () => { zero = true }, '--recursive': () => { recursive = true }, '--dereference-recursive': () => { recursive = true; dereference = true },
        '--line-buffered': () => {}, '--binary': () => {}, '--null': () => {}
      }
      if (simple[name]) { simple[name](); continue }
      if (name === '--color' || name === '--colour') {
        const when = inline ?? 'auto'
        const mapped = { always: 'always', yes: 'always', force: 'always', never: 'never', no: 'never', none: 'never', auto: 'auto', tty: 'auto', 'if-tty': 'auto' }[when]
        if (!mapped) { err(`invalid argument '${when}' for '--color'`); return 2 }
        colorWhen = mapped
        continue
      }
      if (name === '--regexp') { addPatterns(value() ?? ''); continue }
      if (name === '--file') { if (!readPatternFile(value())) return 2; continue }
      if (name === '--max-count') { maxCount = integer(value(), 'max count'); if (maxCount === undefined) return 2; continue }
      if (name === '--before-context' || name === '--after-context' || name === '--context') {
        const number = integer(value(), 'context length')
        if (number === undefined) return 2
        if (name !== '--after-context') before = number
        if (name !== '--before-context') after = number
        continue
      }
      if (name === '--include') { includes.push(globToRegex(value())); continue }
      if (name === '--exclude') { excludes.push(globToRegex(value())); continue }
      if (name === '--exclude-dir') { excludeDirs.push(globToRegex(value())); continue }
      err(`unrecognized option '${arg}'`)
      err("Usage: grep [OPTION]... PATTERNS [FILE]...")
      err("Try 'grep --help' for more information.")
      return 2
    }

    // -NUM is a context length
    if (/^-\d+$/.test(arg)) { before = after = Number(arg.slice(1)); continue }
    for (let c = 1; c < arg.length; c++) {
      const flag = arg[c]
      if (flag === 'E') mode = 'extended'
      else if (flag === 'F') mode = 'fixed'
      else if (flag === 'G') mode = 'basic'
      else if (flag === 'P') mode = 'perl'
      else if (flag === 'i' || flag === 'y') ignoreCase = true
      else if (flag === 'v') invert = true
      else if (flag === 'w') wordMatch = true
      else if (flag === 'x') lineMatch = true
      else if (flag === 'q') quiet = true
      else if (flag === 's') noMessages = true
      else if (flag === 'c') countOnly = true
      else if (flag === 'l') { listMatching = true; listNonMatching = false }
      else if (flag === 'L') { listNonMatching = true; listMatching = false }
      else if (flag === 'o') onlyMatching = true
      else if (flag === 'b') byteOffset = true
      else if (flag === 'n') lineNumbers = true
      else if (flag === 'H') withFilename = true
      else if (flag === 'h') withFilename = false
      else if (flag === 'a') binaryAsText = true
      else if (flag === 'z') zero = true
      else if (flag === 'r') recursive = true
      else if (flag === 'R') { recursive = true; dereference = true }
      else if (flag === 'U' || flag === 'T') { /* no effect here */ }
      else if ('efmABC'.includes(flag)) {
        const value = c + 1 < arg.length ? arg.slice(c + 1) : args[++i]
        if (value === undefined) { err(`option requires an argument -- '${flag}'`); return 2 }
        if (flag === 'e') addPatterns(value)
        else if (flag === 'f') { if (!readPatternFile(value)) return 2 }
        else if (flag === 'm') { maxCount = integer(value, 'max count'); if (maxCount === undefined) return 2 }
        else {
          const number = integer(value, 'context length')
          if (number === undefined) return 2
          if (flag !== 'A') before = number
          if (flag !== 'B') after = number
        }
        break
      } else {
        err(`invalid option -- '${flag}'`)
        err('Usage: grep [OPTION]... PATTERNS [FILE]...')
        err("Try 'grep --help' for more information.")
        return 2
      }
    }
  }

  if (!patternGiven) {
    if (operands.length === 0) { err('Usage: grep [OPTION]... PATTERNS [FILE]...'); err("Try 'grep --help' for more information."); return 2 }
    addPatterns(operands.shift())
  }

  // The patterns as one regular expression
  let regex
  try {
    const parts = patterns.map(pattern => {
      const bytes = toBytes(pattern)
      if (mode === 'fixed') return bytes.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')
      if (mode === 'perl') return pattern
      return translate(bytes, mode === 'extended').source
    })
    let source = parts.length === 0 ? '(?!)' : parts.map(part => `(?:${part})`).join('|')
    if (lineMatch) source = `^(?:${source})$`
    else if (wordMatch) source = `(?<![A-Za-z0-9_])(?:${source})(?![A-Za-z0-9_])`
    regex = new RegExp(source, ignoreCase ? 'i' : '')
  } catch (error) {
    err(error instanceof Error ? error.message : String(error))
    return 2
  }
  const globalRegex = new RegExp(regex.source, regex.flags + 'g')

  const useColor = colorWhen === 'always' || (colorWhen === 'auto' && isTty(1) && env?.TERM !== 'dumb')
  const palette = { ms: '01;31', fn: '35', ln: '32', bn: '32', se: '36' }
  if (useColor) for (const part of (env?.GREP_COLORS ?? '').split(':')) { const [key, value] = part.split('='); if (key in palette && value) palette[key] = value }
  const sgr = (codes, text) => `\x1b[${codes}m\x1b[K${text}\x1b[m\x1b[K`
  const colored = (kind, text) => (useColor ? sgr(palette[kind], text) : text)

  const lineEnd = zero ? '\0' : '\n'
  const cwd = getcwd()
  let output = ''
  const flush = () => { if (output) { writeAll(1, encodeLatin1(output)); output = '' } }
  let anySelected = false
  let hadError = false
  let printedGroup = false
  const contextWanted = (before > 0 || after > 0) && !onlyMatching && !countOnly && !listMatching && !listNonMatching && !quiet

  const complain = text => { if (!noMessages) err(text); hadError = true }

  // Searches one file's data; returns whether a line was selected
  const search = (name, data, showName) => {
    const text = decode(data)
    // A file with a NUL byte is binary: a match is reported as one line, and nothing is printed from it
    const binary = !binaryAsText && !zero && text.includes('\0')
    const lines = text === '' ? [] : text.split(lineEnd)
    if (lines.length && lines[lines.length - 1] === '') lines.pop()

    const offsets = []
    if (byteOffset) { let at = 0; for (const line of lines) { offsets.push(at); at += line.length + 1 } }

    const prefix = (number, offset, separator) => {
      let out = ''
      if (showName) out += colored('fn', name) + colored('se', separator)
      if (lineNumbers) out += colored('ln', String(number)) + colored('se', separator)
      if (byteOffset) out += colored('bn', String(offset)) + colored('se', separator)
      return out
    }

    let selected = 0
    let lastPrinted = -1
    let pendingAfter = 0
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]
      const isMatch = regex.test(line) !== invert
      if (isMatch && selected >= maxCount) break
      if (isMatch) {
        selected++
        if (quiet) return selected
        if (listMatching || listNonMatching) return selected
        if (countOnly) continue
        if (binary) { flush(); output += `Binary file ${name} matches\n`; return selected }
        if (contextWanted) {
          const start = Math.max(lastPrinted + 1, index - before)
          if (printedGroup && start > lastPrinted + 1) output += colored('se', '--') + '\n'
          else if (printedGroup && lastPrinted < 0) output += colored('se', '--') + '\n'
          for (let k = start; k < index; k++) output += prefix(k + 1, offsets[k], '-') + lines[k] + lineEnd
        }
        if (onlyMatching) {
          if (!invert) {
            globalRegex.lastIndex = 0
            for (let m = globalRegex.exec(line); m; m = globalRegex.exec(line)) {
              if (m[0] === '') { globalRegex.lastIndex++; continue }
              output += prefix(index + 1, (offsets[index] ?? 0) + m.index, ':') + colored('ms', m[0]) + lineEnd
            }
          }
        } else {
          let shown = line
          if (useColor && !invert) {
            let result = ''
            let last = 0
            globalRegex.lastIndex = 0
            for (let m = globalRegex.exec(line); m; m = globalRegex.exec(line)) {
              if (m[0] === '') { globalRegex.lastIndex++; continue }
              result += line.slice(last, m.index) + sgr(palette.ms, m[0])
              last = m.index + m[0].length
            }
            shown = result + line.slice(last)
          }
          output += prefix(index + 1, offsets[index], ':') + shown + lineEnd
        }
        lastPrinted = index
        printedGroup = printedGroup || contextWanted
        pendingAfter = after
        if (output.length > 65536) flush()
      } else if (contextWanted && pendingAfter > 0) {
        output += prefix(index + 1, offsets[index], '-') + line + lineEnd
        lastPrinted = index
        pendingAfter--
      }
      if (selected >= maxCount && !(contextWanted && pendingAfter > 0)) break
    }
    return selected
  }

  const report = (name, selected, showName) => {
    if (quiet) return
    if (listMatching && selected > 0) output += colored('fn', name) + '\n'
    else if (listNonMatching && selected === 0) output += colored('fn', name) + '\n'
    else if (countOnly) output += (showName ? colored('fn', name) + colored('se', ':') : '') + selected + '\n'
  }

  const searchFile = (name, fullPath, showName) => {
    let data
    try {
      const fd = open(fullPath, O_RDONLY)
      try { data = readFd(fd) } finally { close(fd) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      complain(`${name}: ${/ENOENT/.test(message) ? 'No such file or directory' : /EACCES/.test(message) ? 'Permission denied' : message}`)
      return false
    }
    const selected = search(name, data, showName)
    if (selected > 0) anySelected = true
    report(name, selected, showName)
    return quiet && selected > 0
  }

  const files = operands.length ? operands : (recursive ? ['.'] : ['-'])
  const showName = withFilename ?? (files.length > 1 || recursive)
  // `grep -r pattern` with no operand searches the current directory and names files without a `./`
  const bare = recursive && operands.length === 0

  const walk = (name, fullPath, top) => {
    if (isDirectory(fullPath)) {
      if (!recursive) { complain(`${name}: Is a directory`); return false }
      if (!top && excludeDirs.some(re => re.test(name.slice(name.lastIndexOf('/') + 1)))) return false
      let names
      try { names = readdir(fullPath).sort() } catch (error) { complain(`${name}: ${error instanceof Error ? error.message : String(error)}`); return false }
      for (const child of names) {
        const childPath = `${fullPath}/${child}`
        if (!dereference && isSymbolicLink(childPath)) continue
        const childName = bare && name === '.' ? child : `${name.replace(/\/$/, '')}/${child}`
        if (walk(childName, childPath, false)) return true
      }
      return false
    }
    const base = name.slice(name.lastIndexOf('/') + 1)
    if (!top || recursive) {
      if (includes.length && !includes.some(re => re.test(base))) return false
      if (excludes.some(re => re.test(base))) return false
    }
    return searchFile(name, fullPath, showName)
  }

  for (const file of files) {
    let stop = false
    if (file === '-') {
      const selected = search('(standard input)', readFd(0), showName)
      if (selected > 0) anySelected = true
      report('(standard input)', selected, showName)
      stop = quiet && selected > 0
    } else stop = walk(file, resolve(cwd, file), true)
    if (stop) break
  }

  flush()
  if (quiet && anySelected) return 0
  return hadError ? 2 : anySelected ? 0 : 1
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(2)
}
