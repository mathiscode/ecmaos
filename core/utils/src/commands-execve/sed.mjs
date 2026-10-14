/**
 * The stream editor, as GNU `sed` does it. A script is addresses (`N`, `$`, `/re/`, `first~step`, `a,b`, `a,+N`, `a,~N`, `0,/re/`,
 * each with `!`) and commands: `s y p P d D n N g G h H x l = a i c r R w W q Q b t T : z F { }`. Patterns are basic regular
 * expressions, or extended with `-E`. The options are `-n -e -f -E/-r -s -z -i[SUFFIX]`. A last line with no newline is written
 * without one, and `N` on the last line prints the pattern space and stops, as GNU does.
 */

import { resolve } from './lib/path-utils.mjs'
import { toBytes, translate } from './lib/regex-posix.mjs'

const { argv, exit, writeAll, read, getcwd, open, close, write, isDirectory, O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`sed: ${text}\n`))

const usage = `Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...

  -n, --quiet, --silent       suppress automatic printing of pattern space
  -e script, --expression=script  add the script to the commands to be executed
  -f script-file, --file=script-file  add the contents of script-file to the commands to be executed
  -E, -r, --regexp-extended   use extended regular expressions in the script
  -i[SUFFIX], --in-place[=SUFFIX]  edit files in place (makes backup if SUFFIX supplied)
  -s, --separate              consider files as separate rather than as a single continuous long stream
  -z, --null-data             separate lines by NUL characters
  -u, --unbuffered            (ignored)
  -l N, --line-length=N       specify the desired line-wrap length for the 'l' command
  --help                      display this help and exit

If no -e, --expression, -f, or --file option is given, then the first non-option argument is taken as the sed script to interpret.`

class ScriptError extends Error {}

const decode = bytes => { let text = ''; for (let at = 0; at < bytes.length; at += 8192) text += String.fromCharCode(...bytes.subarray(at, at + 8192)); return text }
const encodeBytes = text => Uint8Array.from(text, ch => ch.charCodeAt(0))

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

const simpleEscapes = { n: '\n', t: '\t', f: '\f', v: '\v', a: '\x07', r: '\r' }

/** Escapes sed gives a meaning to inside a pattern: `\n`, `\t`, `\xHH`; other backslash pairs are left for the regular expression */
function patternEscapes(text) {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\\' || i + 1 >= text.length) { out += text[i]; continue }
    const next = text[i + 1]
    if (next in simpleEscapes) { out += simpleEscapes[next]; i++ }
    else if (next === 'x' && /^[0-9a-fA-F]{1,2}/.test(text.slice(i + 2))) {
      const hex = /^[0-9a-fA-F]{1,2}/.exec(text.slice(i + 2))[0]
      const ch = String.fromCharCode(parseInt(hex, 16))
      out += /[\\^$.*+?()[\]{}|/-]/.test(ch) ? '\\' + ch : ch
      i += 1 + hex.length
    } else { out += text[i] + next; i++ }
  }
  return out
}

/** Parses the script text into commands */
function parseScript(text, extended, options) {
  const commands = []
  const labels = new Map()
  const blocks = []
  let pos = 0

  const fail = message => { throw new ScriptError(`-e expression #1, char ${pos}: ${message}`) }
  const skipBlanks = () => { while (pos < text.length && (text[pos] === ' ' || text[pos] === '\t')) pos++ }
  const skipSeparators = () => { while (pos < text.length && /[\s;]/.test(text[pos])) pos++ }

  const compileRegex = (source, flags) => {
    if (source === '') return { empty: true }
    let result
    try { result = translate(toBytes(patternEscapes(source)), extended, true) } catch (error) { return fail(error.message) }
    try { return { regex: new RegExp(result.source, (flags.includes('I') ? 'i' : '') + (flags.includes('M') ? 'm' : '')) } } catch { return fail('Invalid regular expression') }
  }

  /** Text up to the closing delimiter: `\delim` becomes `delim`, other escapes are kept; a newline must be escaped */
  const readDelimited = (delimiter, what) => {
    let out = ''
    for (;;) {
      if (pos >= text.length) fail(`unterminated ${what}`)
      const ch = text[pos++]
      if (ch === delimiter) return out
      if (ch === '\\') {
        if (pos >= text.length) fail(`unterminated ${what}`)
        const next = text[pos++]
        out += next === delimiter ? (delimiter === 'n' ? '\\n' : delimiter) : '\\' + next
        continue
      }
      if (ch === '\n' && what !== "`y' command") fail(`unterminated ${what}`)
      out += ch
    }
  }

  const readAddress = () => {
    skipBlanks()
    const ch = text[pos]
    if (ch === undefined) return undefined
    if (/\d/.test(ch)) {
      const number = Number(/^\d+/.exec(text.slice(pos))[0])
      pos += String(number).length
      if (text[pos] === '~') {
        pos++
        const step = /^\d+/.exec(text.slice(pos))
        if (!step) fail('expected number after ~')
        pos += step[0].length
        return { type: 'step', first: number, step: Number(step[0]) }
      }
      return { type: 'line', n: number }
    }
    if (ch === '$') { pos++; return { type: 'last' } }
    if (ch === '/' || ch === '\\') {
      let delimiter = '/'
      if (ch === '\\') { pos++; delimiter = text[pos] }
      pos++
      const source = readDelimited(delimiter, 'address regex')
      let flags = ''
      while (text[pos] === 'I' || text[pos] === 'M') flags += text[pos++]
      return { type: 're', ...compileRegex(source, flags) }
    }
    return undefined
  }

  while (pos < text.length) {
    skipSeparators()
    if (pos >= text.length) break
    if (text[pos] === '#') { while (pos < text.length && text[pos] !== '\n') pos++; continue }

    const command = { addr1: readAddress(), addr2: undefined, negate: false, name: '', active: false }
    if (command.addr1) {
      skipBlanks()
      if (text[pos] === ',') {
        pos++
        skipBlanks()
        if (text[pos] === '+' || text[pos] === '~') {
          const kind = text[pos++]
          const number = /^\d+/.exec(text.slice(pos))
          if (!number) fail('expected number after + or ~')
          pos += number[0].length
          command.addr2 = { type: kind === '+' ? 'plus' : 'multiple', n: Number(number[0]) }
        } else command.addr2 = readAddress()
        if (!command.addr2) fail('unexpected `,\'')
      }
    }
    skipBlanks()
    while (text[pos] === '!') { command.negate = true; pos++; skipBlanks() }
    if (command.addr1?.type === 'line' && command.addr1.n === 0 && command.addr2?.type !== 're') fail('invalid usage of line address 0')
    if (pos >= text.length) fail('missing command')

    const name = text[pos++]
    command.name = name

    /** After a command: only blanks, then a separator, `}` or a comment may follow */
    const endOfCommand = () => {
      skipBlanks()
      if (pos < text.length && !/[;\n}#]/.test(text[pos])) fail('extra characters after command')
    }
    const lineArgument = () => {
      skipBlanks()
      const start = pos
      while (pos < text.length && text[pos] !== '\n') pos++
      return text.slice(start, pos)
    }

    switch (name) {
      case '{':
        blocks.push(commands.length)
        commands.push(command)
        continue
      case '}': {
        if (command.addr1) fail('} doesn\'t want any addresses')
        const open = blocks.pop()
        if (open === undefined) fail('unexpected `}\'')
        commands[open].end = commands.length
        endOfCommand()
        commands.push(command)
        continue
      }
      case '#':
        while (pos < text.length && text[pos] !== '\n') pos++
        continue
      case ':': {
        if (command.addr1) fail(': doesn\'t want any addresses')
        skipBlanks()
        const start = pos
        while (pos < text.length && text[pos] !== '\n' && text[pos] !== ';') pos++
        const label = text.slice(start, pos).trim()
        if (!label) fail('":" lacks a label')
        labels.set(label, commands.length)
        continue
      }
      case 'b': case 't': case 'T': {
        skipBlanks()
        const start = pos
        while (pos < text.length && text[pos] !== '\n' && text[pos] !== ';' && text[pos] !== '}') pos++
        command.label = text.slice(start, pos).trim()
        break
      }
      case 'a': case 'i': case 'c': {
        skipBlanks()
        if (text[pos] === '\\') {
          pos++
          skipBlanks()
          if (text[pos] === '\n') pos++
        }
        if (pos >= text.length && name !== 'c') fail('expected \\ after `a\', `c\' or `i\'')
        let body = ''
        while (pos < text.length) {
          const ch = text[pos++]
          if (ch === '\\' && pos < text.length) {
            const next = text[pos++]
            body += next === 't' ? '\t' : next
          } else if (ch === '\n') break
          else body += ch
        }
        command.text = body
        break
      }
      case 'r': case 'R': case 'w': case 'W': {
        command.file = lineArgument()
        if (!command.file) fail('missing filename in r/R/w/W commands')
        break
      }
      case 'q': case 'Q': case 'l': case 'L': {
        skipBlanks()
        const number = /^\d+/.exec(text.slice(pos))
        if (number) { command.n = Number(number[0]); pos += number[0].length }
        endOfCommand()
        break
      }
      case 's': {
        const delimiter = text[pos++]
        if (delimiter === undefined || delimiter === '\n' || delimiter === '\\') fail('unterminated `s\' command')
        const source = readDelimited(delimiter, "`s' command")
        const replacement = readDelimited(delimiter, "`s' command")
        command.global = false
        command.print = false
        command.nth = 1
        let flags = ''
        for (;;) {
          const ch = text[pos]
          if (ch === 'g') { command.global = true; pos++ }
          else if (ch === 'p') { command.print = true; pos++ }
          else if (ch === 'i' || ch === 'I') { flags += 'I'; pos++ }
          else if (ch === 'm' || ch === 'M') { flags += 'M'; pos++ }
          else if (ch === 'e') pos++
          else if (ch !== undefined && /\d/.test(ch)) {
            const number = /^\d+/.exec(text.slice(pos))[0]
            command.nth = Number(number)
            if (command.nth === 0) fail('number option to `s\' command may not be zero')
            pos += number.length
          } else if (ch === 'w') { pos++; command.file = lineArgument(); break }
          else break
        }
        Object.assign(command, compileRegex(source, flags))
        command.replacement = parseReplacement(replacement)
        if (!command.empty) {
          const groups = new RegExp(command.regex.source + '|').exec('').length - 1
          for (const part of command.replacement) if (part.group > groups) fail(`invalid reference \\${part.group} on \`s' command's RHS`)
        }
        if (!command.file) endOfCommand()
        break
      }
      case 'y': {
        const delimiter = text[pos++]
        const unescape = raw => {
          let out = ''
          for (let i = 0; i < raw.length; i++) {
            if (raw[i] === '\\' && i + 1 < raw.length) {
              const next = raw[++i]
              out += next === '\\' ? '\\' : next in simpleEscapes ? simpleEscapes[next] : '\\' + next
            } else out += raw[i]
          }
          return out
        }
        const from = unescape(readDelimited(delimiter, "`y' command"))
        const to = unescape(readDelimited(delimiter, "`y' command"))
        if (from.length !== to.length) fail("strings for `y' command are different lengths")
        command.map = new Map(Array.from(from, (ch, index) => [ch, to[index]]))
        endOfCommand()
        break
      }
      case '=': case 'd': case 'D': case 'g': case 'G': case 'h': case 'H': case 'n': case 'N': case 'p': case 'P': case 'x': case 'z': case 'F':
        endOfCommand()
        break
      default:
        fail(`unknown command: \`${name}'`)
    }
    commands.push(command)
  }

  if (blocks.length) fail('unmatched `{\'')
  for (const command of commands) {
    if ((command.name === 'b' || command.name === 't' || command.name === 'T') && command.label) {
      if (!labels.has(command.label)) throw new ScriptError(`-e expression #1, char ${pos}: can't find label for jump to \`${command.label}'`)
    }
  }
  return { commands, labels }
}

/** The replacement of an `s` command as parts: text, `{ group }` (0 is the whole match), and case operations */
function parseReplacement(text) {
  const parts = []
  let literal = ''
  const flush = () => { if (literal) { parts.push({ text: literal }); literal = '' } }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '&') { flush(); parts.push({ group: 0 }); continue }
    if (ch === '\\' && i + 1 < text.length) {
      const next = text[++i]
      if (/\d/.test(next)) { flush(); parts.push({ group: Number(next) }) }
      else if ('LUluE'.includes(next)) { flush(); parts.push({ caseOp: next }) }
      else if (next in simpleEscapes) literal += simpleEscapes[next]
      else if (next === 'x' && /^[0-9a-fA-F]{1,2}/.test(text.slice(i + 1))) {
        const hex = /^[0-9a-fA-F]{1,2}/.exec(text.slice(i + 1))[0]
        literal += String.fromCharCode(parseInt(hex, 16))
        i += hex.length
      } else literal += next
      continue
    }
    literal += ch
  }
  flush()
  return parts
}

function expandReplacement(parts, match) {
  let out = ''
  let mode = null
  let once = null
  const add = piece => {
    for (const ch of piece) {
      let value = ch
      if (once) { value = once === 'u' ? ch.toUpperCase() : ch.toLowerCase(); once = null }
      else if (mode === 'U') value = ch.toUpperCase()
      else if (mode === 'L') value = ch.toLowerCase()
      out += value
    }
  }
  for (const part of parts) {
    if (part.caseOp) {
      if (part.caseOp === 'U' || part.caseOp === 'L') { mode = part.caseOp; once = null }
      else if (part.caseOp === 'E') { mode = null; once = null }
      else once = part.caseOp
    } else if (part.group !== undefined) add(match[part.group] ?? '')
    else add(part.text)
  }
  return out
}

/** How `l` shows text: escapes for the usual control characters, octal for the rest, `\` at a wrap and `$` at the end */
function listText(text, width) {
  const names = { 7: '\\a', 8: '\\b', 12: '\\f', 10: '\\n', 13: '\\r', 9: '\\t', 11: '\\v', 92: '\\\\' }
  const units = Array.from(text, ch => {
    const code = ch.charCodeAt(0)
    return code in names ? names[code] : code >= 32 && code < 127 ? ch : '\\' + code.toString(8).padStart(3, '0')
  })
  let out = ''
  let line = 0
  for (const unit of units) {
    if (width > 1 && line + unit.length > width - 1) { out += '\\\n'; line = 0 }
    out += unit
    line += unit.length
  }
  return out + '$\n'
}

/** Runs a script over input files, returning what it writes and how it ended */
function execute(program, files, options, state) {
  const { commands, labels } = program
  const delimiter = options.zero ? '\0' : '\n'
  let output = ''
  let missingNewline = false

  const emit = piece => {
    if (missingNewline) { output += delimiter; missingNewline = false }
    output += piece
  }

  const lines = []
  const names = []
  for (const file of files) {
    const text = file.text
    const parts = text === '' ? [] : text.split(delimiter)
    const hasNewline = text.endsWith(delimiter)
    if (parts.length && parts[parts.length - 1] === '') parts.pop()
    parts.forEach((line, index) => { lines.push({ line, newline: index < parts.length - 1 || hasNewline, file: file.name, last: index === parts.length - 1 }); })
    names.push(file.name)
  }
  // With separate files the `$` address is the last line of each file; otherwise of the last file that has lines
  const lastIndexOfFile = new Map()
  lines.forEach((entry, index) => lastIndexOfFile.set(entry.file, index))

  let cursor = 0
  let current = { line: '', newline: true, file: '-' }
  let lineNumber = state.lineNumber
  let ps = ''
  const isLast = () => (options.separate ? cursor >= lines.length || lines[cursor].file !== current.file : cursor >= lines.length)
  const hasInput = () => cursor < lines.length

  let previousFile
  const readLine = () => {
    if (!hasInput()) return false
    // With separate files each starts counting again
    if (options.separate && lines[cursor].file !== previousFile) lineNumber = 0
    current = lines[cursor++]
    previousFile = current.file
    lineNumber++
    return true
  }

  const appendQueue = []
  let substituted = false
  let quit = false
  let exitCode = 0
  const written = state.written
  const sideReaders = state.sideReaders

  const printPs = (text = ps) => {
    emit(text)
    if (current.newline) output += delimiter
    else missingNewline = true
  }

  const matchRegex = (address, text) => {
    if (address.empty) { if (!state.lastRegex) throw new ScriptError('no previous regular expression'); return state.lastRegex.test(text) }
    state.lastRegex = address.regex
    return address.regex.test(text)
  }

  const matches = (address, forStart) => {
    if (address.type === 'line') return lineNumber === address.n
    if (address.type === 'last') return isLast()
    if (address.type === 'step') return address.step === 0 ? lineNumber === address.first : lineNumber >= address.first && (lineNumber - address.first) % address.step === 0
    return matchRegex(address, ps)
  }

  const selected = command => {
    let result
    if (!command.addr1) result = true
    else if (!command.addr2) result = matches(command.addr1)
    else if (command.active) {
      const end = command.addr2
      if (end.type === 'last') { if (isLast()) command.active = false }
      else if (end.type === 're') { if (matchRegex(end, ps)) command.active = false }
      else if (lineNumber >= command.endLine) command.active = false
      result = true
      // A numeric end that is behind us ends the range without taking this line
      if (command.active === false && command.endLine !== undefined && end.type !== 're' && end.type !== 'last' && lineNumber > command.endLine) result = false
    } else if (matches(command.addr1)) {
      const end = command.addr2
      if (end.type === 'line') { if (end.n > lineNumber) { command.active = true; command.endLine = end.n } }
      else if (end.type === 'plus') { if (end.n > 0) { command.active = true; command.endLine = lineNumber + end.n } }
      else if (end.type === 'multiple') {
        if (end.n > 0 && lineNumber % end.n !== 0) { command.active = true; command.endLine = Math.ceil(lineNumber / end.n) * end.n }
      } else if (end.type === 'last') { if (!isLast()) command.active = true }
      else command.active = true
      result = true
    } else if (command.addr1.type === 'line' && command.addr1.n === 0 && command.addr2.type === 're' && lineNumber === 1 && !command.zeroDone) {
      // 0,/re/: the range is already open before the first line, and the first line can end it
      command.zeroDone = true
      command.active = !matchRegex(command.addr2, ps)
      result = true
    } else result = false
    return command.negate ? !result : result
  }

  const substitute = command => {
    let regex
    if (command.empty) { if (!state.lastRegex) throw new ScriptError('no previous regular expression'); regex = state.lastRegex }
    else { regex = command.regex; state.lastRegex = regex }
    command.globalRegex ??= new Map()
    let global = command.globalRegex.get(regex)
    if (!global) { global = new RegExp(regex.source, regex.flags + 'g'); command.globalRegex.set(regex, global) }
    global.lastIndex = 0
    let out = ''
    let last = 0
    let count = 0
    let replaced = false
    let previousEnd = -1
    for (let match = global.exec(ps); match; match = global.exec(ps)) {
      const start = match.index
      const end = start + match[0].length
      if (match[0] === '' && start === previousEnd) { if (start >= ps.length) break; global.lastIndex = start + 1; continue }
      count++
      if (count >= command.nth) {
        out += ps.slice(last, start) + expandReplacement(command.replacement, match)
        last = end
        replaced = true
        if (!command.global) break
      }
      previousEnd = end
      if (match[0] === '') { if (end >= ps.length) break; global.lastIndex = end + 1 }
    }
    if (!replaced) return false
    ps = out + ps.slice(last)
    return true
  }

  const sideWrite = (file, text) => {
    if (file === '/dev/stdout') { emit(text + delimiter); return }
    if (file === '/dev/stderr') { writeAll(2, encodeBytes(text + '\n')); return }
    written.set(file, (written.get(file) ?? '') + text + '\n')
  }

  const flushAppends = () => {
    for (const item of appendQueue.splice(0)) {
      if (item.text !== undefined) emit(item.text + '\n')
      else if (item.file) {
        try {
          const fd = open(resolve(getcwd(), item.file), O_RDONLY)
          try { const data = decode(readFd(fd)); if (data) { emit(data); if (!data.endsWith('\n')) missingNewline = true } } finally { close(fd) }
        } catch { /* a file that is not there adds nothing */ }
      } else if (item.line !== undefined) emit(item.line + '\n')
    }
  }

  let restart = false
  while (quit === false && (restart || readLine())) {
    if (!restart) { ps = current.line; substituted = false }
    restart = false
    let autoprint = !options.quiet
    let pc = 0

    cycle:
    while (pc < commands.length) {
      const command = commands[pc]
      if (!selected(command)) { pc = command.name === '{' ? command.end + 1 : pc + 1; continue }
      switch (command.name) {
        case '{': case '}': case ':': break
        case 's':
          if (substitute(command)) {
            substituted = true
            if (command.print) printPs()
            if (command.file) sideWrite(command.file, ps)
          }
          break
        case 'y': ps = Array.from(ps, ch => command.map.get(ch) ?? ch).join(''); break
        case 'p': printPs(); break
        case 'P': { const at = ps.indexOf('\n'); emit((at < 0 ? ps : ps.slice(0, at)) + '\n'); break }
        case 'd': autoprint = false; break cycle
        case 'D': {
          const at = ps.indexOf('\n')
          if (at < 0) { autoprint = false; break cycle }
          ps = ps.slice(at + 1)
          autoprint = false
          restart = true
          break cycle
        }
        case 'n':
          if (!hasInput()) { if (!options.posix && autoprint) printPs(); autoprint = false; quit = true; break cycle }
          if (autoprint) printPs()
          flushAppends()
          readLine()
          ps = current.line
          break
        case 'N':
          if (!hasInput()) { quit = true; break cycle }
          flushAppends()
          readLine()
          ps += '\n' + current.line
          break
        case 'g': ps = state.hold; break
        case 'G': ps += '\n' + state.hold; break
        case 'h': state.hold = ps; break
        case 'H': state.hold += '\n' + ps; break
        case 'x': { const swap = state.hold; state.hold = ps; ps = swap; break }
        case 'l': emit(listText(ps, command.n ?? options.lineLength)); break
        case '=': emit(lineNumber + '\n'); break
        case 'a': appendQueue.push({ text: command.text }); break
        case 'i': emit(command.text + '\n'); break
        case 'c':
          // In a range the text is written when the range ends
          if (!command.addr2 || !command.active || command.negate) emit(command.text + '\n')
          autoprint = false
          break cycle
        case 'r': appendQueue.push({ file: command.file }); break
        case 'R': {
          let reader = sideReaders.get(command.file)
          if (!reader) {
            let rows = []
            try { const fd = open(resolve(getcwd(), command.file), O_RDONLY); try { rows = decode(readFd(fd)).split('\n') } finally { close(fd) } } catch { /* nothing to read */ }
            if (rows.length && rows[rows.length - 1] === '') rows.pop()
            reader = { rows, at: 0 }
            sideReaders.set(command.file, reader)
          }
          if (reader.at < reader.rows.length) appendQueue.push({ line: reader.rows[reader.at++] })
          break
        }
        case 'w': sideWrite(command.file, ps); break
        case 'W': { const at = ps.indexOf('\n'); sideWrite(command.file, at < 0 ? ps : ps.slice(0, at)); break }
        case 'z': ps = ''; break
        case 'F': emit((current.file === '-' ? '-' : current.file) + '\n'); break
        case 'q':
          exitCode = command.n ?? 0
          quit = true
          break cycle
        case 'Q':
          exitCode = command.n ?? 0
          quit = true
          autoprint = false
          break cycle
        case 'b': case 't': case 'T': {
          let jump
          if (command.name === 'b') jump = true
          else if (command.name === 't') { jump = substituted; substituted = false }
          else { jump = !substituted; substituted = false }
          if (jump) {
            if (!command.label) break cycle
            pc = labels.get(command.label)
            continue
          }
          break
        }
        default: break
      }
      pc++
    }

    if (autoprint) printPs()
    flushAppends()
  }

  state.lineNumber = lineNumber
  return { output, missingNewline, exitCode }
}

function main() {
  const args = argv.slice(1)
  const options = { quiet: false, extended: false, separate: false, zero: false, inPlace: undefined, lineLength: 70, posix: false }
  const scripts = []
  const operands = []
  let haveScript = false

  const addScriptFile = file => {
    try {
      const fd = file === '-' ? 0 : open(resolve(getcwd(), file), O_RDONLY)
      let text
      try { text = decode(readFd(fd)) } finally { if (fd > 2) close(fd) }
      scripts.push(text.endsWith('\n') ? text.slice(0, -1) : text)
      haveScript = true
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      err(`couldn't open file ${file}: ${/ENOENT/.test(message) ? 'No such file or directory' : message}`)
      return false
    }
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { operands.push(...args.slice(i + 1)); break }
    if (arg === '--help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (arg === '--version') { writeAll(1, encoder.encode('sed (ecmaOS) 4.9\n')); return 0 }
    if (arg === '-' || !arg.startsWith('-')) { operands.push(arg); continue }

    if (arg.startsWith('--')) {
      const [name, inline] = arg.split(/=(.*)/s)
      const value = () => (inline !== undefined ? inline : args[++i])
      if (name === '--quiet' || name === '--silent') options.quiet = true
      else if (name === '--regexp-extended') options.extended = true
      else if (name === '--separate') options.separate = true
      else if (name === '--null-data') options.zero = true
      else if (name === '--posix') options.posix = true
      else if (name === '--in-place') { options.inPlace = inline ?? ''; options.separate = true }
      else if (name === '--expression') { const text = value(); if (text === undefined) { err('option requires an argument -- \'e\''); return 1 } scripts.push(toBytes(text)); haveScript = true }
      else if (name === '--file') { if (!addScriptFile(value())) return 1 }
      else if (name === '--line-length') options.lineLength = Number(value())
      else if (['--unbuffered', '--binary', '--debug', '--follow-symlinks', '--sandbox'].includes(name)) { /* no effect here */ }
      else { err(`unrecognized option '${arg}'`); writeAll(2, encoder.encode(usage + '\n')); return 1 }
      continue
    }

    for (let c = 1; c < arg.length; c++) {
      const flag = arg[c]
      if (flag === 'n') options.quiet = true
      else if (flag === 'E' || flag === 'r') options.extended = true
      else if (flag === 's') options.separate = true
      else if (flag === 'z') options.zero = true
      else if (flag === 'u' || flag === 'b') { /* no effect here */ }
      else if (flag === 'i') { options.inPlace = arg.slice(c + 1); options.separate = true; break }
      else if (flag === 'e' || flag === 'f' || flag === 'l') {
        const value = c + 1 < arg.length ? arg.slice(c + 1) : args[++i]
        if (value === undefined) { err(`option requires an argument -- '${flag}'`); writeAll(2, encoder.encode(usage + '\n')); return 1 }
        if (flag === 'e') { scripts.push(toBytes(value)); haveScript = true }
        else if (flag === 'f') { if (!addScriptFile(value)) return 1 }
        else options.lineLength = Number(value)
        break
      } else { err(`invalid option -- '${flag}'`); writeAll(2, encoder.encode(usage + '\n')); return 1 }
    }
  }

  if (!haveScript) {
    if (operands.length === 0) { writeAll(2, encoder.encode(usage + '\n')); return 1 }
    scripts.push(toBytes(operands.shift()))
  }

  let scriptText = scripts.join('\n')
  // A first line of exactly `#n` is the same as -n
  if (/^#n(\n|$)/.test(scriptText)) options.quiet = true

  let program
  try { program = parseScript(scriptText, options.extended, options) } catch (error) {
    if (error instanceof ScriptError) { err(error.message); return 1 }
    throw error
  }

  const cwd = getcwd()
  const inputs = []
  let status = 0
  const names = operands.length ? operands : ['-']
  for (const name of names) {
    try {
      let text
      if (name === '-') text = decode(readFd(0))
      else {
        const fullPath = resolve(cwd, name)
        if (isDirectory(fullPath)) { err(`couldn't edit ${name}: not a regular file`); status = 4; continue }
        const fd = open(fullPath, O_RDONLY)
        try { text = decode(readFd(fd)) } finally { close(fd) }
      }
      inputs.push({ name, text })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      err(`can't read ${name}: ${/ENOENT/.test(message) ? 'No such file or directory' : /EACCES/.test(message) ? 'Permission denied' : message}`)
      status = 2
    }
  }

  const state = { hold: '', lineNumber: 0, lastRegex: undefined, written: new Map(), sideReaders: new Map() }
  // w files are created (emptied) before the script runs
  for (const command of program.commands) {
    if ((command.name === 'w' || command.name === 'W' || (command.name === 's' && command.file)) && command.file !== '/dev/stdout' && command.file !== '/dev/stderr') state.written.set(command.file, '')
  }

  const writeFileText = (path, text) => {
    const fd = open(resolve(cwd, path), O_WRONLY | O_CREAT | O_TRUNC, 0o644)
    try { const bytes = encodeBytes(text); let at = 0; while (at < bytes.length) at += write(fd, bytes.subarray(at), -1) } finally { close(fd) }
  }

  let exitCode = 0
  try {
    if (options.inPlace !== undefined) {
      for (const input of inputs) {
        if (input.name === '-') { err("couldn't edit -: not a regular file"); status = 4; continue }
        state.lineNumber = 0
        const result = execute(program, [input], options, state)
        const text = result.output
        if (options.inPlace) writeFileText(options.inPlace.includes('*') ? options.inPlace.replace(/\*/g, input.name) : input.name + options.inPlace, input.text)
        writeFileText(input.name, text)
        exitCode = result.exitCode
        if (exitCode) break
      }
    } else {
      const result = execute(program, inputs, options, state)
      writeAll(1, encodeBytes(result.output))
      exitCode = result.exitCode
    }
  } catch (error) {
    if (error instanceof ScriptError) { err(error.message); return 1 }
    throw error
  }

  for (const [file, text] of state.written) {
    try { writeFileText(file, text) } catch (error) { err(`couldn't open file ${file}: ${error instanceof Error ? error.message : String(error)}`); status = 4 }
  }
  return exitCode || status
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(4)
}
