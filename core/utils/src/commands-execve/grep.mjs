/**
 * `grep`: search files for lines that match, as GNU grep does. Basic (`-G`), extended (`-E`), fixed (`-F`) and JavaScript-flavored
 * Perl (`-P`) patterns, matched on Unicode text; `-i -v -w -x`; `-c -l -L -o -q -s -m -b -n -H -h -T -Z`; `-A -B -C` context with
 * group separators; `-r -R` and `-d`, `--include`, `--exclude`, `--exclude-dir`; `-a -I -U --binary-files`; `--color`. The exit
 * status is 0 when a line was selected, 1 when none was, 2 on an error (unless `-q` found a line).
 */

import { compile as compileGlob } from './lib/fnmatch.mjs'
import { readFdBytes, readFileBytes, writeFdBytes } from './lib/bytes.mjs'
import { getopt } from './lib/getopt.mjs'
import { reasonOf } from './lib/errno.mjs'
import { isTty } from './lib/tty.mjs'
import { resolve } from './lib/path-utils.mjs'
import { translate } from './lib/regex-posix.mjs'

const { argv, env, exit, getcwd, lstat, stat, readdir } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const latin1 = bytes => { let text = ''; for (let at = 0; at < bytes.length; at += 8192) text += String.fromCharCode(...bytes.subarray(at, at + 8192)); return text }
const fromLatin1 = text => Uint8Array.from(text, ch => ch.charCodeAt(0))
/** UTF-8 bytes of a string as a string of byte characters */
const asBytes = text => latin1(encoder.encode(text))

// output is a string of byte characters, written out in chunks
const outParts = []
let outSize = 0
const out = text => { outParts.push(text); outSize += text.length; if (outSize > 65536) flush() }
const flush = () => { if (outParts.length) { writeFdBytes(1, fromLatin1(outParts.join(''))); outParts.length = 0; outSize = 0 } }
let quiet = false
const errText = text => { flush(); writeFdBytes(2, encoder.encode(`grep: ${text}\n`)) }

const usage = `Usage: grep [OPTION]... PATTERNS [FILE]...
Search for PATTERNS in each FILE.
Example: grep -i 'hello world' menu.h main.c
PATTERNS can contain multiple patterns separated by newlines.

Pattern selection and interpretation:
  -E, --extended-regexp     PATTERNS are extended regular expressions
  -F, --fixed-strings       PATTERNS are strings
  -G, --basic-regexp        PATTERNS are basic regular expressions
  -P, --perl-regexp         PATTERNS are Perl regular expressions
  -e, --regexp=PATTERNS     use PATTERNS for matching
  -f, --file=FILE           take PATTERNS from FILE
  -i, --ignore-case         ignore case distinctions in patterns and data
      --no-ignore-case      do not ignore case distinctions (default)
  -w, --word-regexp         match only whole words
  -x, --line-regexp         match only whole lines
  -z, --null-data           a data line ends in 0 byte, not newline

Miscellaneous:
  -s, --no-messages         suppress error messages
  -v, --invert-match        select non-matching lines
  -V, --version             display version information and exit
      --help                display this help text and exit

Output control:
  -m, --max-count=NUM       stop after NUM selected lines
  -b, --byte-offset         print the byte offset with output lines
  -n, --line-number         print line number with output lines
      --line-buffered       flush output on every line
  -H, --with-filename       print file name with output lines
  -h, --no-filename         suppress the file name prefix on output
      --label=LABEL         use LABEL as the standard input file name prefix
  -o, --only-matching       show only nonempty parts of lines that match
  -q, --quiet, --silent     suppress all normal output
      --binary-files=TYPE   assume that binary files are TYPE;
                            TYPE is 'binary', 'text', or 'without-match'
  -a, --text                equivalent to --binary-files=text
  -I                        equivalent to --binary-files=without-match
  -d, --directories=ACTION  how to handle directories;
                            ACTION is 'read', 'recurse', or 'skip'
  -D, --devices=ACTION      how to handle devices, FIFOs and sockets;
                            ACTION is 'read' or 'skip'
  -r, --recursive           like --directories=recurse
  -R, --dereference-recursive  likewise, but follow all symlinks
      --include=GLOB        search only files that match GLOB (a file pattern)
      --exclude=GLOB        skip files that match GLOB
      --exclude-from=FILE   skip files that match any file pattern from FILE
      --exclude-dir=GLOB    skip directories that match GLOB
  -L, --files-without-match  print only names of FILEs with no selected lines
  -l, --files-with-matches  print only names of FILEs with selected lines
  -c, --count               print only a count of selected lines per FILE
  -T, --initial-tab         make tabs line up (if needed)
  -Z, --null                print 0 byte after FILE name

Context control:
  -B, --before-context=NUM  print NUM lines of leading context
  -A, --after-context=NUM   print NUM lines of trailing context
  -C, --context=NUM         print NUM lines of output context
  -NUM                      same as --context=NUM
      --group-separator=SEP  print SEP on line between matches with context
      --no-group-separator  do not print separator for matches with context
      --color[=WHEN],
      --colour[=WHEN]       use markers to highlight the matching strings;
                            WHEN is 'always', 'never', or 'auto'
  -U, --binary              do not strip CR characters at EOL (MSDOS/Windows)

When FILE is '-', read standard input.  With no FILE, read '.' if
recursive, '-' otherwise.  With fewer than two FILEs, assume -h.
Exit status is 0 if any line is selected, 1 otherwise;
if any error occurs and -q is not given, the exit status is 2.`

class Usage extends Error {}

// - patterns -----------------------------------------------------------------------------------------------------------

const escapeRegex = text => text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')

/** Splits an extended pattern at top-level `|` (outside brackets, groups and escapes), so each alternative can be tried alone */
function topLevelAlternatives(pattern, extended) {
  const parts = []
  let depth = 0
  let current = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '\\') {
      const next = pattern[i + 1] ?? ''
      if (!extended && next === '|' && depth === 0) { parts.push(current); current = ''; i++; continue }
      if (!extended && next === '(') depth++
      if (!extended && next === ')') depth--
      current += ch + next
      i++
      continue
    }
    if (ch === '[') {
      let j = i + 1
      if (pattern[j] === '^') j++
      if (pattern[j] === ']') j++
      while (j < pattern.length && pattern[j] !== ']') { if (pattern[j] === '[' && /[:.=]/.test(pattern[j + 1] ?? '')) { const close = pattern.indexOf(pattern[j + 1] + ']', j + 2); if (close > 0) j = close + 1 } j++ }
      current += pattern.slice(i, j + 1)
      i = j
      continue
    }
    if (extended && ch === '(') depth++
    if (extended && ch === ')') depth--
    if (extended && ch === '|' && depth === 0) { parts.push(current); current = ''; continue }
    current += ch
  }
  parts.push(current)
  return parts
}

/**
 * The compiled matcher: `{ regexes, test(text), find(text, from) }`. Each alternative is a regex of its own, so a match can be
 * the leftmost and then the longest as POSIX wants.
 */
function buildMatcher(patterns, o) {
  const flags = `gu${o.ignoreCase ? 'i' : ''}${o.mode === 'perl' ? 's' : ''}`
  const sources = []
  for (const pattern of patterns) {
    let alternatives
    if (o.mode === 'fixed') alternatives = [escapeRegex(pattern)]
    else if (o.mode === 'perl') alternatives = [perlSource(pattern)]
    else alternatives = topLevelAlternatives(pattern, o.mode === 'extended').map(part => translate(part, o.mode === 'extended', false, true).source)
    sources.push(...alternatives)
  }
  const wrap = source => {
    let result = `(?:${source})`
    if (o.lineMatch) result = `^${result}$`
    else if (o.wordMatch) result = `(?<![\\p{L}\\p{Nd}_])${result}(?![\\p{L}\\p{Nd}_])`
    return result
  }
  const regexes = sources.map(source => {
    try { return new RegExp(wrap(source), o.perlFlags ? flags + o.perlFlags : flags) } catch (error) { throw new Usage(`Invalid regular expression${error?.message ? '' : ''}`) }
  })
  return {
    regexes,
    test(text) { for (const regex of regexes) { regex.lastIndex = 0; if (regex.test(text)) return true } return false },
    /** The leftmost, then longest, match at or after `from`: `{ index, length }` or undefined */
    find(text, from = 0) {
      let best
      for (const regex of regexes) {
        regex.lastIndex = from
        const match = regex.exec(text)
        if (match && (!best || match.index < best.index || (match.index === best.index && match[0].length > best.length))) best = { index: match.index, length: match[0].length }
      }
      return best
    }
  }
}

/** A Perl-style pattern as JavaScript: `(?i)` and friends at the start become flags */
function perlSource(pattern) {
  return pattern.replace(/\\h/g, '[ \\t]').replace(/\\A/g, '^').replace(/\\z|\\Z/g, '$')
}

// - files ----------------------------------------------------------------------------------------------------------------------

const strictUtf8 = new TextDecoder('utf-8', { fatal: true })

/** Splits file bytes into lines: `{ start, end }` byte offsets (end excludes the terminator) */
function splitLines(bytes, terminator) {
  const lines = []
  let start = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === terminator) { lines.push({ start, end: i }); start = i + 1 }
  }
  if (start < bytes.length) lines.push({ start, end: bytes.length })
  return lines
}

const SGR = (code, text) => `\x1b[${code}m\x1b[K${text}\x1b[m\x1b[K`

async function main() {
  const args = []
  for (const arg of argv.slice(1)) {
    if (arg === '--') { args.push(arg); continue }
    if (args.includes('--')) { args.push(arg); continue }
    // -NUM is -C NUM
    if (/^-\d+$/.test(arg)) { args.push('-C', arg.slice(1)); continue }
    args.push(arg)
  }
  const { options, operands, error } = getopt(args, {
    short: 'EFGPe:f:iywxZsvm:bnHhoqLlcaIzUTA:B:C:d:D:rRVX:',
    long: {
      'extended-regexp': 'E', 'fixed-strings': 'F', 'basic-regexp': 'G', 'perl-regexp': 'P', regexp: { key: 'e', arg: 'required' }, file: { key: 'f', arg: 'required' },
      'ignore-case': 'i', 'no-ignore-case': 'no-i', 'word-regexp': 'w', 'line-regexp': 'x', 'null-data': 'z', 'no-messages': 's', 'invert-match': 'v', version: 'V', help: 'help',
      'max-count': { key: 'm', arg: 'required' }, 'byte-offset': 'b', 'line-number': 'n', 'line-buffered': 'line-buffered', 'with-filename': 'H', 'no-filename': 'h', label: { key: 'label', arg: 'required' },
      'only-matching': 'o', quiet: 'q', silent: 'q', 'binary-files': { key: 'binary-files', arg: 'required' }, text: 'a', directories: { key: 'd', arg: 'required' }, devices: { key: 'D', arg: 'required' },
      recursive: 'r', 'dereference-recursive': 'R', include: { key: 'include', arg: 'required' }, exclude: { key: 'exclude', arg: 'required' }, 'exclude-from': { key: 'exclude-from', arg: 'required' },
      'exclude-dir': { key: 'exclude-dir', arg: 'required' }, 'files-without-match': 'L', 'files-with-matches': 'l', count: 'c', 'initial-tab': 'T', null: 'Z', 'before-context': { key: 'B', arg: 'required' },
      'after-context': { key: 'A', arg: 'required' }, context: { key: 'C', arg: 'required' }, 'group-separator': { key: 'group-separator', arg: 'required' }, 'no-group-separator': 'no-group-separator',
      color: { key: 'color', arg: 'optional' }, colour: { key: 'color', arg: 'optional' }, binary: 'U', unix: 'u', 'unix-byte-offsets': 'u'
    }
  })
  if (error) { errText(error); writeFdBytes(2, encoder.encode("Usage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.\n")); return 2 }
  const o = {
    mode: 'basic', ignoreCase: false, invert: false, wordMatch: false, lineMatch: false, count: false, listMatching: false, listNonMatching: false, onlyMatching: false, maxCount: Infinity,
    byteOffset: false, lineNumbers: false, withFilename: undefined, before: 0, after: 0, contextGiven: false, recursive: false, dereference: false, binary: 'binary', zero: false, nullName: false,
    initialTab: false, color: false, groupSeparator: '--', directories: 'read', devices: 'read', label: '(standard input)', perlFlags: ''
  }
  const patterns = []
  let patternGiven = false
  const includes = []
  const excludes = []
  const excludeDirs = []
  const number = (text, what) => {
    if (!/^\d+$/.test(text)) {
      if (/^-?\d+$/.test(text)) throw new Usage(`${text}: invalid ${what} argument`)
      throw new Usage(`${text}: invalid ${what} argument`)
    }
    return Number(text)
  }
  try {
    for (const [key, value] of options) {
      switch (key) {
        case 'help': out(usage + '\n'); flush(); return 0
        case 'V': out('grep (GNU grep) 3.12 (ecmaOS)\n'); flush(); return 0
        case 'E': o.mode = 'extended'; break
        case 'F': o.mode = 'fixed'; break
        case 'G': o.mode = 'basic'; break
        case 'P': o.mode = 'perl'; break
        case 'e': patternGiven = true; patterns.push(...value.split('\n')); break
        case 'f': {
          let bytes
          try { bytes = value === '-' ? readFdBytes(0) : readFileBytes(resolve(getcwd(), value)) } catch (e) { throw new Usage(`${value}: ${reasonOf(e)}`) }
          patternGiven = true
          const text = new TextDecoder().decode(bytes)
          if (text !== '') { const lines = text.split('\n'); if (lines[lines.length - 1] === '') lines.pop(); patterns.push(...lines) }
          break
        }
        case 'i': case 'y': o.ignoreCase = true; break
        case 'no-i': o.ignoreCase = false; break
        case 'v': o.invert = true; break
        case 'w': o.wordMatch = true; break
        case 'x': o.lineMatch = true; break
        case 'z': o.zero = true; break
        case 's': quiet = true; break
        case 'm': o.maxCount = /^-/.test(value) ? Infinity : number(value, 'max count'); break
        case 'b': o.byteOffset = true; break
        case 'n': o.lineNumbers = true; break
        case 'H': o.withFilename = true; break
        case 'h': o.withFilename = false; break
        case 'label': o.label = value; break
        case 'o': o.onlyMatching = true; break
        case 'q': o.quietMode = true; break
        case 'a': o.binary = 'text'; break
        case 'I': o.binary = 'without-match'; break
        case 'U': case 'u': case 'line-buffered': break
        case 'binary-files':
          if (!['binary', 'text', 'without-match'].includes(value)) throw new Usage('unknown binary-files type')
          o.binary = value
          break
        case 'd':
          if (!['read', 'recurse', 'skip'].includes(value)) throw new Usage(`invalid argument ‘${value}’ for ‘--directories’\nValid arguments are:\n  - ‘read’\n  - ‘recurse’\n  - ‘skip’`)
          o.directories = value
          if (value === 'recurse') o.recursive = true
          break
        case 'D': if (!['read', 'skip'].includes(value)) throw new Usage('unknown devices method'); o.devices = value; break
        case 'r': o.recursive = true; o.directories = 'recurse'; break
        case 'R': o.recursive = true; o.dereference = true; o.directories = 'recurse'; break
        case 'include': includes.push(value); break
        case 'exclude': excludes.push(value); break
        case 'exclude-from': {
          try { excludes.push(...new TextDecoder().decode(readFileBytes(resolve(getcwd(), value))).split('\n').filter(Boolean)) } catch (e) { throw new Usage(`${value}: ${reasonOf(e)}`) }
          break
        }
        case 'exclude-dir': excludeDirs.push(value.replace(/\/+$/, '')); break
        case 'L': o.listNonMatching = true; o.listMatching = false; break
        case 'l': o.listMatching = true; o.listNonMatching = false; break
        case 'c': o.count = true; break
        case 'T': o.initialTab = true; break
        case 'Z': o.nullName = true; break
        case 'A': o.after = number(value, 'context length'); o.contextGiven = true; break
        case 'B': o.before = number(value, 'context length'); o.contextGiven = true; break
        case 'C': o.after = o.before = number(value, 'context length'); o.contextGiven = true; break
        case 'group-separator': o.groupSeparator = value; break
        case 'no-group-separator': o.groupSeparator = undefined; break
        case 'color': {
          if (value === true || value === 'always' || value === 'yes' || value === 'force') o.color = value === true ? isTty(1) && env.TERM !== 'dumb' : true
          else if (value === 'auto' || value === 'tty' || value === 'if-tty') o.color = isTty(1) && env.TERM !== 'dumb'
          else if (value === 'never' || value === 'no' || value === 'none') o.color = false
          else throw new Usage(`invalid argument ‘${value}’ for ‘--color’`)
          break
        }
      }
    }
  } catch (e) {
    if (e instanceof Usage) { errText(e.message); if (!/^invalid argument|^unknown|^invalid/.test(e.message) || true) writeFdBytes(2, encoder.encode("Usage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.\n")); return 2 }
    throw e
  }
  let files = [...operands]
  if (!patternGiven) {
    if (files.length === 0) { writeFdBytes(2, encoder.encode("Usage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.\n")); return 2 }
    patterns.push(...files.shift().split('\n'))
  }
  // a perl pattern's leading (?i) (?s) (?m) (?x) groups are flags
  if (o.mode === 'perl') {
    for (let i = 0; i < patterns.length; i++) {
      const match = /^\(\?([imsx]+)\)/.exec(patterns[i])
      if (match) {
        patterns[i] = patterns[i].slice(match[0].length)
        for (const flag of match[1]) if (flag === 'i') o.ignoreCase = true; else if (flag === 'm' && !o.perlFlags.includes('m')) o.perlFlags += 'm'
      }
    }
  }
  let matcher
  try { matcher = patterns.length ? buildMatcher(patterns, o) : { regexes: [], test: () => false, find: () => undefined } } catch (e) {
    if (e instanceof Usage) { errText(e.message); return 2 }
    errText(e.message)
    return 2
  }
  const implicitCurrent = files.length === 0 && o.recursive
  if (files.length === 0) files = [o.recursive ? '.' : '-']
  const cwd = getcwd()
  const terminator = o.zero ? 0 : 10
  const colors = o.color ? parseColors(env.GREP_COLORS) : undefined
  let anySelected = false
  let hadError = false
  let withFilename = o.withFilename
  if (withFilename === undefined) withFilename = files.length > 1
  // an empty pattern with -v selects nothing, and -m 0 reads nothing: GNU stops before looking at a file
  const decider = o.maxCount === 0 || (patterns.length === 1 && patterns[0] === '' && o.invert && !o.lineMatch && !o.wordMatch)
  if (decider && !o.listNonMatching) return 1
  const sep = (char, kind) => (colors ? SGR(colors.se, char) : char)

  /** Searches one file's bytes; returns whether a line was selected */
  const search = (bytes, label, sizeForWidth) => {
    if (decider) return false
    const isBinary = o.binary !== 'text' && !o.zero && bytes.includes(0)
    if (isBinary && o.binary === 'without-match') return false
    const lines = splitLines(bytes, terminator)
    const decoded = new Array(lines.length)
    let selectedCount = 0
    let lastPrinted = -1
    let afterRemaining = 0
    let printedSomething = false
    const width = o.initialTab ? { line: Math.max(2, String(sizeForWidth).length), byte: Math.max(2, String(sizeForWidth).length) } : undefined
    const textOf = k => {
      if (decoded[k] !== undefined) return decoded[k]
      const slice = bytes.subarray(lines[k].start, lines[k].end)
      let text
      let bad = false
      try { text = strictUtf8.decode(slice) } catch { text = latin1(slice); bad = true }
      decoded[k] = { text, bad }
      return decoded[k]
    }
    const prefix = (k, mark, byteOffset) => {
      let head = ''
      if (withFilename) head += (colors ? SGR(colors.fn, label) : label) + (o.nullName ? '\0' : sep(mark))
      if (o.lineNumbers) {
        const n = String(k + 1)
        head += (colors ? SGR(colors.ln, width ? n.padStart(width.line) : n) : width ? n.padStart(width.line) : n) + sep(mark)
      }
      if (o.byteOffset) {
        const b = String(byteOffset)
        head += (colors ? SGR(colors.bn, width ? b.padStart(width.byte) : b) : width ? b.padStart(width.byte) : b) + sep(mark)
      }
      if (o.initialTab && head !== '') head += '\t'
      return head
    }
    const lineText = k => latin1(bytes.subarray(lines[k].start, lines[k].end))
    const printLine = (k, mark) => {
      let body = lineText(k)
      if (colors && mark === ':' && !o.invert) {
        const { text, bad } = textOf(k)
        if (!bad) body = highlight(text, colors)
      } else if (colors && mark === ':' && o.invert && colors.cx) {
        // selected lines under -v show no match colors
      }
      out(prefix(k, mark, lines[k].start) + body + (o.zero ? '\0' : '\n'))
    }
    const separator = () => {
      if (o.groupSeparator !== undefined && o.contextGiven && printedSomething) out((colors ? SGR(colors.se, asBytes(o.groupSeparator)) : asBytes(o.groupSeparator)) + '\n')
    }
    const highlight = (text, palette) => {
      let result = ''
      let from = 0
      let position = 0
      while (position <= text.length) {
        const found = matcher.find(text, position)
        if (!found) break
        if (found.length === 0) { position = found.index + 1; if (position > text.length) break; continue }
        result += asBytes(text.slice(from, found.index)) + SGR(palette.ms, asBytes(text.slice(found.index, found.index + found.length)))
        from = found.index + found.length
        position = from
      }
      return result + asBytes(text.slice(from))
    }
    const printOnly = k => {
      const { text, bad } = textOf(k)
      let position = 0
      while (position <= text.length) {
        const found = matcher.find(text, position)
        if (!found) break
        if (found.length === 0) { position = found.index + 1; continue }
        const piece = text.slice(found.index, found.index + found.length)
        const bytesOffset = lines[k].start + (bad ? found.index : encoder.encode(text.slice(0, found.index)).length)
        out(prefix(k, ':', bytesOffset) + (colors ? SGR(colors.ms, bad ? piece : asBytes(piece)) : bad ? piece : asBytes(piece)) + (o.zero ? '\0' : '\n'))
        position = found.index + found.length
      }
    }
    const printing = !(o.count || o.listMatching || o.listNonMatching || o.quietMode)
    let stopped = false
    for (let k = 0; k < lines.length && !stopped; k++) {
      const { text, bad } = textOf(k)
      let hit = matcher.test(text)
      if (bad && hit && o.binary !== 'text') hit = hit // matched on the bytes
      const selected = hit !== o.invert
      if (selected && selectedCount < o.maxCount) {
        selectedCount++
        if (o.quietMode) return true
        if (o.listMatching || o.listNonMatching) break
        if (printing) {
          if ((isBinary || (bad && o.binary !== 'text')) && !o.count) {
            flush()
            writeFdBytes(2, encoder.encode(`grep: ${label}: binary file matches\n`))
            return true
          }
          // leading context
          const firstBefore = Math.max(lastPrinted + 1, k - o.before)
          if (printedSomething && firstBefore > lastPrinted + 1) separator()
          else if (!printedSomething && o.contextGiven && false) separator()
          for (let b = firstBefore; b < k; b++) printLine(b, '-')
          if (o.onlyMatching) { if (!o.invert) printOnly(k) } else printLine(k, ':')
          printedSomething = true
          lastPrinted = k
          afterRemaining = o.after
          if (selectedCount >= o.maxCount) {
            // trailing context still follows the last selected line
            for (let a = k + 1; a < lines.length && afterRemaining > 0; a++, afterRemaining--) {
              printLine(a, '-')
              lastPrinted = a
            }
            stopped = true
          }
        } else if (selectedCount >= o.maxCount) stopped = true
      } else if (printing && afterRemaining > 0 && !selected) {
        printLine(k, '-')
        lastPrinted = k
        afterRemaining--
      } else if (selectedCount >= o.maxCount) stopped = true
    }
    if (o.count) {
      out((withFilename ? (colors ? SGR(colors.fn, label) : label) + (o.nullName ? '\0' : sep(':')) : '') + selectedCount + '\n')
    }
    if (o.listMatching && selectedCount > 0) out((colors ? SGR(colors.fn, label) : label) + (o.nullName ? '\0' : '\n'))
    if (o.listNonMatching && selectedCount === 0) out((colors ? SGR(colors.fn, label) : label) + (o.nullName ? '\0' : '\n'))
    return selectedCount > 0
  }

  const includeFile = (name, commandLine) => {
    const base = name.split('/').pop()
    if (excludes.some(pattern => compileGlob(pattern)(base) || compileGlob(pattern)(name))) return false
    if (includes.length && !includes.some(pattern => compileGlob(pattern)(base) || compileGlob(pattern)(name))) return false
    return true
  }

  const process = async (name, display, commandLine) => {
    if (name === '-') {
      let bytes
      try { bytes = readFdBytes(0) } catch (e) { fail(`${o.label}: ${reasonOf(e)}`); return }
      if (search(bytes, o.label, 19)) anySelected = true
      return
    }
    const path = resolve(cwd, name)
    let info
    try { info = commandLine || o.dereference ? stat(path) : lstat(path) } catch (e) { fail(`${display}: ${reasonOf(e)}`); return }
    const kind = info.mode & 0o170000
    if (kind === 0o120000) return
    if (kind === 0o040000) {
      if (o.directories === 'skip') return
      if (o.directories === 'read') { fail(`${display}: Is a directory`); return }
      if (!commandLine && excludeDirs.some(pattern => compileGlob(pattern)(name.split('/').pop()))) return
      if (commandLine && excludeDirs.some(pattern => compileGlob(pattern)(name.replace(/\/+$/, '').split('/').pop()) && name !== '.')) return
      if (o.withFilename === undefined) withFilename = true
      let names = []
      try { names = readdir(path).map(e => (typeof e === 'string' ? e : e.name)).filter(n => n !== '.' && n !== '..').sort() } catch (e) { fail(`${display}: ${reasonOf(e)}`); return }
      for (const child of names) {
        const childName = `${name.replace(/\/+$/, '')}/${child}`
        const childDisplay = implicitCurrent && name === '.' ? child : `${display.replace(/\/+$/, '')}/${child}`
        await process(childName, childDisplay, false)
        if (anySelected && o.quietMode) return
      }
      return
    }
    if (kind !== 0o100000 && o.devices === 'skip') return
    if (!includeFile(name, commandLine)) return
    let bytes
    try { bytes = readFileBytes(path) } catch (e) { fail(`${display}: ${reasonOf(e)}`); return }
    if (search(bytes, display, bytes.length)) anySelected = true
  }
  const fail = text => { hadError = true; if (!quiet) errText(text) }

  if (o.recursive && o.withFilename === undefined && files.length === 1 && files[0] !== '-') {
    // a lone directory prints names; a lone file does not
    try { if ((stat(resolve(cwd, files[0])).mode & 0o170000) !== 0o040000) withFilename = false } catch { /* the error comes later */ }
  }
  for (const file of files) {
    await process(file, file, true)
    if (anySelected && o.quietMode) break
  }
  flush()
  if (o.quietMode && anySelected) return 0
  if (hadError) return 2
  return anySelected ? 0 : 1
}

function parseColors(spec) {
  const colors = { ms: '01;31', mc: '01;31', sl: '', cx: '', fn: '35', ln: '32', bn: '32', se: '36' }
  for (const part of (spec ?? '').split(':')) {
    const [key, value] = part.split('=')
    if (key === 'mt') { colors.ms = value; colors.mc = value }
    else if (key in colors && value !== undefined) colors[key] = value
  }
  return colors
}

try {
  exit(await main())
} catch (error) {
  flush()
  writeFdBytes(2, encoder.encode(`grep: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(2)
}
