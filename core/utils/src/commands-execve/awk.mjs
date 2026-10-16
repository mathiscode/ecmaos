/**
 * `awk`: the POSIX awk language as GNU awk runs it (patterns and actions, fields and records, regular expressions, arrays,
 * user functions, the string and math built-ins, `getline` in all its forms, output to files and pipes, `printf`). The
 * program is read into a syntax tree and run by an async tree walker, because starting a command (`system`, `cmd | getline`,
 * `print | cmd`) is asynchronous here.
 *
 * Values are JavaScript numbers and strings, plus `StrNum` (what looks like a number but came from input, so it compares as one)
 * and `UNINIT` (an unset variable: "" and 0 at once).
 */

import { getopt } from './lib/getopt.mjs'
import { readFileBytes } from './lib/bytes.mjs'
import { findProgram, waitFor, statusOf } from './lib/run.mjs'
import { resolve } from './lib/path-utils.mjs'
import { formatPrintf } from '../lib/printf-format.ts'

const sys = globalThis.ecmaosSyscalls
const { argv, exit, writeAll, read, write, open, close, pipe, spawn, getcwd, env, O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC, O_APPEND } = sys

const encoder = new TextEncoder()
const decoder = new TextDecoder()

class AwkError extends Error {}
class SyntaxFailure extends AwkError {}
class LocatedError extends AwkError { constructor(message, where) { super(message); this.where = where } }

// - values ---------------------------------------------------------------------------------------------------------

class StrNum {
  constructor(text, number) { this.text = text; this.number = number }
}
const UNINIT = Object.freeze({ uninit: true })

const NUMBER_PREFIX = /^[ \t\n\f\v\r]*[+-]?(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/
const NUMBER_FULL = /^[ \t\n\f\v\r]*[+-]?(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|inf(?:inity)?|nan)[ \t\n\f\v\r]*$/i

/** What a string is as a number: its numeric prefix (`"12abc"` is 12), `+inf`/`-nan` with a sign, otherwise 0 */
function stringToNumber(text) {
  const match = NUMBER_PREFIX.exec(text)
  if (match) return Number(match[0])
  const special = /^[ \t\n\f\v\r]*([+-])(inf(?:inity)?|nan)/i.exec(text)
  if (special) return special[2].toLowerCase() === 'nan' ? NaN : special[1] === '-' ? -Infinity : Infinity
  return 0
}

/** A string from input: a `StrNum` when it looks like a decimal number (not hex, and `inf`/`nan` only with a sign) */
function fromInput(text) {
  if (NUMBER_FULL.test(text) && !/^[ \t\n\f\v\r]*(?:inf|nan)/i.test(text)) return new StrNum(text, Number(text.trim()))
  if (/^[ \t\n\f\v\r]*[+-](?:inf(?:inity)?|nan)[ \t\n\f\v\r]*$/i.test(text)) return new StrNum(text, stringToNumber(text))
  return text
}

const isNumeric = value => typeof value === 'number' || value instanceof StrNum || value === UNINIT

// - regular expressions --------------------------------------------------------------------------------------------

const CLASSES = {
  alpha: '\\p{L}', digit: '0-9', alnum: '\\p{L}\\p{Nd}', upper: '\\p{Lu}', lower: '\\p{Ll}', space: ' \\t\\n\\v\\f\\r', blank: ' \\t',
  punct: '!-\\/:-@\\[-`{-~', print: ' -~\\u00a0-\\u{10ffff}', graph: '!-~\\u00a1-\\u{10ffff}', cntrl: '\\x00-\\x1f\\x7f', xdigit: '0-9A-Fa-f'
}

/** An extended regular expression as awk reads it, as a JavaScript RegExp (code point aware, `.` takes a newline) */
function compileRegex(source) {
  const key = source
  const cached = regexCache.get(key)
  if (cached) return cached
  let out = ''
  let i = 0
  const n = source.length
  // whether the last thing written can take a quantifier
  let quantifiable = false
  const literal = ch => {
    out += /[\\^$.*+?()[\]{}|/]/.test(ch) ? '\\' + ch : ch
    quantifiable = true
  }
  while (i < n) {
    const ch = source[i]
    if (ch === '\\') {
      const next = source[i + 1]
      if (next === undefined) { literal('\\'); i++; continue }
      i += 2
      if (next === 'n') literal('\n')
      else if (next === 't') literal('\t')
      else if (next === 'r') literal('\r')
      else if (next === 'f') literal('\f')
      else if (next === 'v') literal('\v')
      else if (next === 'a') literal('\x07')
      else if (next === 'b') literal('\b')
      else if (next === 'y') { out += '\\b'; quantifiable = false }
      else if (next === 'B') { out += '\\B'; quantifiable = false }
      else if (next === '<') { out += '\\b(?=\\w)'; quantifiable = false }
      else if (next === '>') { out += '\\b(?<=\\w)'; quantifiable = false }
      else if (next === 'w') { out += '[\\p{L}\\p{Nd}_]'; quantifiable = true }
      else if (next === 'W') { out += '[^\\p{L}\\p{Nd}_]'; quantifiable = true }
      else if (next === 's') { out += '\\s'; quantifiable = true }
      else if (next === 'S') { out += '\\S'; quantifiable = true }
      else if (next === '`') { out += '^'; quantifiable = false }
      else if (next === "'") { out += '$'; quantifiable = false }
      else if (/[0-7]/.test(next)) {
        let digits = next
        while (digits.length < 3 && /[0-7]/.test(source[i] ?? '')) digits += source[i++]
        literal(String.fromCharCode(parseInt(digits, 8)))
      } else if (next === 'x' && /[0-9a-fA-F]/.test(source[i] ?? '')) {
        let digits = ''
        while (digits.length < 2 && /[0-9a-fA-F]/.test(source[i] ?? '')) digits += source[i++]
        literal(String.fromCharCode(parseInt(digits, 16)))
      } else literal(next)
      continue
    }
    if (ch === '[') {
      let j = i + 1
      let negate = false
      if (source[j] === '^') { negate = true; j++ }
      let body = ''
      let first = true
      let closed = false
      while (j < n) {
        const c = source[j]
        if (c === ']' && !first) { j++; closed = true; break }
        first = false
        if (c === '[' && source[j + 1] === ':') {
          const end = source.indexOf(':]', j + 2)
          if (end > 0) {
            const name = source.slice(j + 2, end)
            if (name in CLASSES) { body += CLASSES[name]; j = end + 2; continue }
          }
        }
        if (c === '[' && (source[j + 1] === '.' || source[j + 1] === '=')) {
          const kind = source[j + 1]
          const end = source.indexOf(kind + ']', j + 2)
          if (end > 0) {
            for (const part of source.slice(j + 2, end)) body += /[\\\]^-]/.test(part) ? '\\' + part : part
            j = end + 2
            continue
          }
        }
        if (c === '\\' && j + 1 < n) {
          const e = source[j + 1]
          const map = { n: '\\n', t: '\\t', r: '\\r', f: '\\f', v: '\\v', a: '\\x07', b: '\\b' }
          if (e === 'w') body += '\\p{L}\\p{Nd}_'
          else if (e === 's') body += '\\s'
          else if (e === 'S') body += '\\S'
          else if (e === 'W') body += '\\W'
          else body += map[e] ?? (/[\\\]^\-[]/.test(e) ? '\\' + e : e)
          j += 2
          continue
        }
        if (c === '-' && body !== '' && j + 1 < n && source[j + 1] !== ']') { body += '-'; j++; continue }
        body += /[\\\]^[-]/.test(c) && c !== '-' ? '\\' + c : c === '-' ? '\\-' : c
        j++
      }
      if (!closed) throw new AwkError(`regular expression: Unmatched [ or [^: /${source}/`)
      out += `[${negate ? '^' : ''}${body}]`
      quantifiable = true
      i = j
      continue
    }
    if (ch === '(') { out += '('; quantifiable = false; i++; continue }
    if (ch === ')') { out += ')'; quantifiable = true; i++; continue }
    if (ch === '|') { out += '|'; quantifiable = false; i++; continue }
    if (ch === '^') { out += '^'; quantifiable = false; i++; continue }
    if (ch === '$') { out += '$'; quantifiable = false; i++; continue }
    if (ch === '.') { out += '.'; quantifiable = true; i++; continue }
    if (ch === '*' || ch === '+' || ch === '?') {
      if (!quantifiable && out.endsWith('^') && !out.endsWith('\\^')) { i++; continue }
      if (!quantifiable) literal(ch)
      else {
        out += ch
        // a repeated quantifier (a**) is the same as one
        while (source[i + 1] === '*' || source[i + 1] === '+' || source[i + 1] === '?') i++
      }
      i++
      continue
    }
    if (ch === '{') {
      const match = /^\{(\d+)(?:,(\d*))?\}/.exec(source.slice(i))
      if (match && quantifiable) { out += match[0]; i += match[0].length; continue }
      literal('{')
      i++
      continue
    }
    literal(ch)
    i++
  }
  let regex
  try { regex = new RegExp(out, 'gsu') } catch (error) { throw new AwkError(`regular expression: ${error.message}: /${source}/`) }
  regexCache.set(key, regex)
  return regex
}
const regexCache = new Map()

// - lexer ----------------------------------------------------------------------------------------------------------

const KEYWORDS = new Set(['BEGIN', 'END', 'function', 'func', 'if', 'else', 'while', 'for', 'do', 'break', 'continue', 'next', 'nextfile', 'exit', 'return', 'delete', 'in', 'getline', 'print', 'printf'])
const BUILTINS = new Set(['length', 'substr', 'index', 'split', 'sub', 'gsub', 'match', 'sprintf', 'sin', 'cos', 'atan2', 'exp', 'log', 'sqrt', 'int', 'rand', 'srand', 'tolower', 'toupper', 'system', 'close', 'fflush', 'systime', 'strftime'])

function unescapeString(raw) {
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch !== '\\') { out += ch; continue }
    const next = raw[++i]
    if (next === undefined) { out += '\\'; break }
    switch (next) {
      case 'n': out += '\n'; break
      case 't': out += '\t'; break
      case 'r': out += '\r'; break
      case '\\': out += '\\'; break
      case '"': out += '"'; break
      case '/': out += '/'; break
      case 'a': out += '\x07'; break
      case 'b': out += '\b'; break
      case 'f': out += '\f'; break
      case 'v': out += '\v'; break
      case '\n': break
      default:
        if (/[0-7]/.test(next)) {
          let digits = next
          while (digits.length < 3 && /[0-7]/.test(raw[i + 1] ?? '')) digits += raw[++i]
          out += String.fromCharCode(parseInt(digits, 8))
        } else if (next === 'x' && /[0-9a-fA-F]/.test(raw[i + 1] ?? '')) {
          let digits = ''
          while (digits.length < 2 && /[0-9a-fA-F]/.test(raw[i + 1] ?? '')) digits += raw[++i]
          out += String.fromCharCode(parseInt(digits, 16))
        } else out += next
    }
  }
  return out
}

class Lexer {
  constructor(text) { this.text = text; this.pos = 0; this.line = 1; this.lastSignificant = undefined }

  fail(message) { throw new SyntaxFailure(`cmd. line:${this.line}: ${message}`) }

  /** Reads the next token: `{ type, value, line }` */
  next() {
    const text = this.text
    for (;;) {
      const ch = text[this.pos]
      if (ch === ' ' || ch === '\t' || ch === '\r') { this.pos++; continue }
      if (ch === '\\' && text[this.pos + 1] === '\n') { this.pos += 2; this.line++; continue }
      if (ch === '\\' && text[this.pos + 1] === '\r' && text[this.pos + 2] === '\n') { this.pos += 3; this.line++; continue }
      if (ch === '#') { while (this.pos < text.length && text[this.pos] !== '\n') this.pos++; continue }
      break
    }
    const start = this.pos
    const line = this.line
    const ch = text[start]
    const make = (type, value = type) => ({ type, value, line, start, end: this.pos })
    if (ch === undefined) return make('eof')
    if (ch === '\n') { this.pos++; this.line++; return make('newline') }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(text[start + 1] ?? ''))) {
      let match = /^0[xX][0-9a-fA-F]+/.exec(text.slice(start))
      if (match) { this.pos += match[0].length; return make('number', parseInt(match[0], 16)) }
      match = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(start))
      this.pos += match[0].length
      return make('number', /^0\d+$/.test(match[0]) && /^[0-7]+$/.test(match[0]) ? parseInt(match[0], 8) : Number(match[0]))
    }
    if (/[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(start))
      this.pos += match[0].length
      const word = match[0]
      if (KEYWORDS.has(word)) return make('keyword', word === 'func' ? 'function' : word)
      if (BUILTINS.has(word)) return make('builtin', word)
      // a name followed at once by ( is a function call
      if (text[this.pos] === '(') return make('funcname', word)
      return make('name', word)
    }
    if (ch === '"') {
      let i = start + 1
      let raw = ''
      for (;;) {
        const c = text[i]
        if (c === undefined || c === '\n') this.fail('unterminated string')
        if (c === '\\') { raw += c + (text[i + 1] ?? ''); if (text[i + 1] === '\n') this.line++; i += 2; continue }
        if (c === '"') break
        raw += c
        i++
      }
      this.pos = i + 1
      return make('string', unescapeString(raw))
    }
    const three = text.slice(start, start + 3)
    const two = text.slice(start, start + 2)
    if (three === '**=') { this.pos += 3; return make('^=') }
    if (['&&', '||', '==', '!=', '<=', '>=', '++', '--', '+=', '-=', '*=', '/=', '%=', '^=', '!~', '>>', '**'].includes(two)) {
      this.pos += 2
      return make(two === '**' ? '^' : two)
    }
    if ('{}()[];,+-*/%^!<>|?:~$='.includes(ch)) { this.pos++; return make(ch) }
    this.fail(`syntax error: unexpected character '${ch}'`)
  }

  /** Reads a regular expression that starts at the `/` token already read at `start` */
  regexFrom(start) {
    const text = this.text
    let i = start + 1
    let source = ''
    let inBracket = false
    for (;;) {
      const c = text[i]
      if (c === undefined || c === '\n') this.fail('unterminated regexp')
      if (c === '\\') {
        if (text[i + 1] === '/') { source += '/'; i += 2; continue }
        source += c + (text[i + 1] ?? '')
        i += 2
        continue
      }
      if (c === '[' && !inBracket) { inBracket = true; source += c; i++; if (text[i] === '^') { source += '^'; i++ } if (text[i] === ']') { source += ']'; i++ } continue }
      if (c === ']' && inBracket) inBracket = false
      if (c === '/' && !inBracket) break
      source += c
      i++
    }
    this.pos = i + 1
    return source
  }
}

// - parser ---------------------------------------------------------------------------------------------------------

class Parser {
  constructor(text) {
    this.lexer = new Lexer(text)
    this.token = this.lexer.next()
    this.functions = new Map()
    this.begin = []
    this.end = []
    this.rules = []
    this.locals = undefined
  }

  fail(message = 'syntax error') {
    const near = this.token.type === 'eof' ? 'end of program' : this.token.type === 'newline' ? 'newline' : String(this.token.value)
    throw new SyntaxFailure(`cmd. line:${this.token.line}: ${message} near '${near}'`)
  }

  advance() { const token = this.token; this.token = this.lexer.next(); return token }
  is(type, value) { return this.token.type === type && (value === undefined || this.token.value === value) }
  isOp(op) { return this.token.type === op }
  isKeyword(word) { return this.token.type === 'keyword' && this.token.value === word }
  expectOp(op) { if (!this.isOp(op)) this.fail(); return this.advance() }
  skipNewlines() { while (this.token.type === 'newline') this.advance() }
  skipTerminators() { while (this.token.type === 'newline' || this.token.type === ';') this.advance() }

  save() { return { pos: this.lexer.pos, line: this.lexer.line, token: this.token } }
  restore(state) { this.lexer.pos = state.pos; this.lexer.line = state.line; this.token = state.token }

  parseProgram() {
    this.skipTerminators()
    while (this.token.type !== 'eof') {
      this.parseItem()
      this.skipTerminators()
    }
    return { begin: this.begin, end: this.end, rules: this.rules, functions: this.functions }
  }

  parseItem() {
    if (this.isKeyword('function')) return this.parseFunction()
    if (this.isKeyword('BEGIN')) {
      this.advance()
      this.skipNewlines()
      if (!this.isOp('{')) this.fail()
      this.begin.push(this.parseBlock())
      return
    }
    if (this.isKeyword('END')) {
      this.advance()
      this.skipNewlines()
      if (!this.isOp('{')) this.fail()
      this.end.push(this.parseBlock())
      return
    }
    let pattern
    let patternEnd
    const line = this.token.line
    if (!this.isOp('{')) {
      pattern = this.parseExpression()
      if (this.isOp(',')) {
        this.advance()
        this.skipNewlines()
        patternEnd = this.parseExpression()
      }
    }
    let action
    if (this.isOp('{')) action = this.parseBlock()
    else if (pattern === undefined) this.fail()
    this.rules.push({ pattern, patternEnd, action, active: false, line })
  }

  parseFunction() {
    this.advance()
    let name
    if (this.token.type === 'name' || this.token.type === 'funcname') name = this.advance().value
    else this.fail('syntax error in function definition')
    this.expectOp('(')
    const params = []
    this.skipNewlines()
    while (!this.isOp(')')) {
      if (this.token.type !== 'name') this.fail()
      params.push(this.advance().value)
      this.skipNewlines()
      if (this.isOp(',')) { this.advance(); this.skipNewlines() }
      else if (!this.isOp(')')) this.fail()
    }
    this.advance()
    this.skipNewlines()
    const previous = this.locals
    this.locals = new Map(params.map((param, index) => [param, index]))
    const fn = { name, params, body: undefined }
    this.functions.set(name, fn)
    fn.body = this.parseBlock()
    this.locals = previous
  }

  parseBlock() {
    this.expectOp('{')
    const statements = []
    this.skipTerminators()
    while (!this.isOp('}')) {
      if (this.token.type === 'eof') this.fail('unexpected end of program')
      statements.push(this.parseStatement())
      this.skipTerminators()
    }
    this.advance()
    return { t: 'block', body: statements }
  }

  /** The end of a simple statement: `;`, a newline, or the `}` that closes the block (left in place) */
  endSimple() {
    if (this.isOp(';') || this.token.type === 'newline') { this.advance(); return }
    if (this.isOp('}') || this.token.type === 'eof') return
    this.fail()
  }

  parseStatement() {
    const line = this.token.line
    const node = this.parseStatementInner()
    if (node.line === undefined) node.line = line
    return node
  }

  parseStatementInner() {
    const token = this.token
    if (token.type === '{') return this.parseBlock()
    if (token.type === ';') { this.advance(); return { t: 'block', body: [] } }
    if (token.type === 'keyword') {
      switch (token.value) {
        case 'if': {
          this.advance()
          this.expectOp('(')
          const cond = this.parseExpression()
          this.expectOp(')')
          this.skipNewlines()
          const then = this.parseStatementBody()
          // an `else` may follow after newlines and semicolons
          const state = this.save()
          this.skipTerminators()
          if (this.isKeyword('else')) {
            this.advance()
            this.skipNewlines()
            return { t: 'if', cond, then, otherwise: this.parseStatementBody() }
          }
          this.restore(state)
          return { t: 'if', cond, then }
        }
        case 'while': {
          this.advance()
          this.expectOp('(')
          const cond = this.parseExpression()
          this.expectOp(')')
          if (this.isOp(';')) { this.advance(); return { t: 'while', cond, body: { t: 'block', body: [] } } }
          this.skipNewlines()
          return { t: 'while', cond, body: this.parseStatementBody() }
        }
        case 'do': {
          this.advance()
          this.skipNewlines()
          const body = this.parseStatementBody()
          this.skipTerminators()
          if (!this.isKeyword('while')) this.fail()
          this.advance()
          this.expectOp('(')
          const cond = this.parseExpression()
          this.expectOp(')')
          this.endSimple()
          return { t: 'do', body, cond }
        }
        case 'for': return this.parseFor()
        case 'break': this.advance(); this.endSimple(); return { t: 'break' }
        case 'continue': this.advance(); this.endSimple(); return { t: 'continue' }
        case 'next': this.advance(); this.endSimple(); return { t: 'next' }
        case 'nextfile': this.advance(); this.endSimple(); return { t: 'nextfile' }
        case 'exit': {
          this.advance()
          let value
          if (!this.isOp(';') && !this.isOp('}') && this.token.type !== 'newline' && this.token.type !== 'eof') value = this.parseExpression()
          this.endSimple()
          return { t: 'exit', value }
        }
        case 'return': {
          this.advance()
          let value
          if (!this.isOp(';') && !this.isOp('}') && this.token.type !== 'newline' && this.token.type !== 'eof') value = this.parseExpression()
          this.endSimple()
          return { t: 'return', value }
        }
        case 'delete': {
          this.advance()
          if (this.token.type !== 'name') this.fail()
          const target = this.variable(this.advance().value)
          let subscripts
          if (this.isOp('[')) {
            this.advance()
            subscripts = this.parseExpressionList(']')
            this.expectOp(']')
          }
          this.endSimple()
          return { t: 'delete', target, subscripts }
        }
        case 'print':
        case 'printf': return this.parsePrint()
      }
    }
    const expr = this.parseExpression()
    this.endSimple()
    return { t: 'expr', expr }
  }

  /** The statement after `if (...)`, `while (...)` and the like: a simple statement may end in a newline or `;` */
  parseStatementBody() {
    if (this.isOp(';')) { this.advance(); return { t: 'block', body: [] } }
    return this.parseStatement()
  }

  parseFor() {
    this.advance()
    this.expectOp('(')
    // for (x in array)
    if (this.token.type === 'name') {
      const state = this.save()
      const name = this.advance().value
      if (this.isKeyword('in')) {
        this.advance()
        if (this.token.type === 'name') {
          const array = this.variable(this.advance().value)
          if (this.isOp(')')) {
            this.advance()
            this.skipNewlines()
            return { t: 'forin', variable: this.variable(name), array, body: this.parseStatementBody() }
          }
        }
      }
      this.restore(state)
    }
    let init
    if (!this.isOp(';')) init = this.parseSimpleStatementForHeader()
    this.expectOp(';')
    this.skipNewlines()
    let cond
    if (!this.isOp(';')) cond = this.parseExpression()
    this.expectOp(';')
    this.skipNewlines()
    let step
    if (!this.isOp(')')) step = this.parseSimpleStatementForHeader()
    this.expectOp(')')
    if (this.isOp(';')) { this.advance(); return { t: 'for', init, cond, step, body: { t: 'block', body: [] } } }
    this.skipNewlines()
    return { t: 'for', init, cond, step, body: this.parseStatementBody() }
  }

  parseSimpleStatementForHeader() {
    return { t: 'expr', expr: this.parseExpression() }
  }

  parsePrint() {
    const kind = this.advance().value
    let args = []
    let noGt = true
    const ends = () => this.isOp(';') || this.isOp('}') || this.token.type === 'newline' || this.token.type === 'eof' || this.isOp('>') || this.isOp('>>') || this.isOp('|')
    if (!ends()) {
      // print (a, b) > "file": a parenthesized list is the argument list
      let grouped = false
      if (this.isOp('(')) {
        const state = this.save()
        this.advance()
        const list = this.parseExpressionList(')', false)
        if (this.isOp(')')) {
          this.advance()
          if (ends()) { args = list; grouped = true }
        }
        if (!grouped) this.restore(state)
      }
      if (!grouped) args = this.parseExpressionList(undefined, noGt)
    }
    let redirect
    if (this.isOp('>') || this.isOp('>>') || this.isOp('|')) {
      const op = this.advance().type
      // the target is a primary-ish expression: concatenation without a comparison
      redirect = { op, target: this.parseConcatenation(true) }
    }
    this.endSimple()
    return { t: 'print', kind, args, redirect }
  }

  /** Expressions separated by commas, up to `close` (not consumed) */
  parseExpressionList(close, noGt = false, noIn = false) {
    const list = []
    this.skipNewlines()
    if (close && this.isOp(close)) return list
    for (;;) {
      list.push(this.parseTernary(noGt, noIn))
      if (this.isOp(',')) { this.advance(); this.skipNewlines(); continue }
      break
    }
    this.skipNewlines()
    return list
  }

  variable(name) {
    if (this.locals?.has(name)) return { t: 'local', index: this.locals.get(name), name }
    return { t: 'var', name }
  }

  // expressions: lowest precedence first

  parseExpression(noGt = false, noIn = false) { return this.parseTernary(noGt, noIn) }

  parseTernary(noGt, noIn) {
    const cond = this.parseOr(noGt, noIn)
    if (this.isOp('?')) {
      this.advance()
      this.skipNewlines()
      const a = this.parseTernary(noGt, noIn)
      this.skipNewlines()
      this.expectOp(':')
      this.skipNewlines()
      const b = this.parseTernary(noGt, noIn)
      return { t: 'ternary', cond, a, b }
    }
    if (this.isAssignOp() && this.isLvalue(cond)) {
      const op = this.advance().type
      this.skipNewlines()
      return { t: 'assign', op, target: cond, value: this.parseTernary(noGt, noIn) }
    }
    return cond
  }

  isAssignOp() { return ['=', '+=', '-=', '*=', '/=', '%=', '^='].includes(this.token.type) }
  isLvalue(node) { return node.t === 'var' || node.t === 'local' || node.t === 'index' || node.t === 'field' }

  parseOr(noGt, noIn) {
    let left = this.parseAnd(noGt, noIn)
    while (this.isOp('||')) {
      this.advance()
      this.skipNewlines()
      left = { t: 'or', a: left, b: this.parseAnd(noGt, noIn) }
    }
    return left
  }

  parseAnd(noGt, noIn) {
    let left = this.parseIn(noGt, noIn)
    while (this.isOp('&&')) {
      this.advance()
      this.skipNewlines()
      left = { t: 'and', a: left, b: this.parseIn(noGt, noIn) }
    }
    return left
  }

  parseIn(noGt, noIn) {
    let left = this.parseMatch(noGt, noIn)
    while (!noIn && this.isKeyword('in')) {
      this.advance()
      if (this.token.type !== 'name') this.fail()
      left = { t: 'in', subscripts: left.t === 'grouping' ? left.list : [left], array: this.variable(this.advance().value) }
    }
    return left
  }

  parseMatch(noGt, noIn) {
    let left = this.parseComparison(noGt, noIn)
    while (this.isOp('~') || this.isOp('!~')) {
      const negate = this.advance().type === '!~'
      left = { t: 'match', negate, a: left, b: this.parseComparison(noGt, noIn) }
    }
    return left
  }

  parseComparison(noGt, noIn) {
    let left = this.parseConcatenation(noGt)
    for (;;) {
      const type = this.token.type
      if (type === '<' || type === '<=' || type === '==' || type === '!=' || type === '>=' || (type === '>' && !noGt)) {
        this.advance()
        left = { t: 'compare', op: type, a: left, b: this.parseConcatenation(noGt) }
      } else if (type === '|' && this.pipeGetline()) {
        // cmd | getline [var]
        this.advance()
        this.advance()
        const target = this.parseOptionalLvalue()
        left = { t: 'getline', source: 'cmd', command: left, target }
      } else break
    }
    return left
  }

  /** Whether the `|` at the current token is followed by `getline` */
  pipeGetline() {
    const state = this.save()
    this.advance()
    const result = this.isKeyword('getline')
    this.restore(state)
    return result
  }

  startsOperand() {
    const type = this.token.type
    if (['number', 'string', 'name', 'funcname', 'builtin', '$', '!', '(', '-', '+', '++', '--'].includes(type)) return true
    if (type === 'keyword' && this.token.value === 'getline') return false
    return false
  }

  parseConcatenation(noGt) {
    let left = this.parseAdditive(noGt)
    for (;;) {
      const type = this.token.type
      // concatenation: an operand directly after an operand (not `+` or `-`, which are binary there)
      const starts = ['number', 'string', 'name', 'funcname', 'builtin', '$', '!', '(', '++', '--'].includes(type) || (type === 'keyword' && this.token.value === 'getline' && false)
      if (!starts) break
      if (type === '!' ) break
      if (type === 'builtin' && false) break
      left = { t: 'concat', a: left, b: this.parseAdditive(noGt) }
    }
    return left
  }

  parseAdditive(noGt) {
    let left = this.parseMultiplicative(noGt)
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.advance().type
      left = { t: 'binary', op, a: left, b: this.parseMultiplicative(noGt) }
    }
    return left
  }

  parseMultiplicative(noGt) {
    let left = this.parseUnary(noGt)
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = this.advance().type
      left = { t: 'binary', op, a: left, b: this.parseUnary(noGt) }
    }
    return left
  }

  parseUnary(noGt) {
    if (this.isOp('!')) { this.advance(); return { t: 'not', a: this.parseUnary(noGt) } }
    if (this.isOp('-')) { this.advance(); return { t: 'neg', a: this.parseUnary(noGt) } }
    if (this.isOp('+')) { this.advance(); return { t: 'plus', a: this.parseUnary(noGt) } }
    return this.parsePower(noGt)
  }

  parsePower(noGt) {
    const base = this.parsePostfix(noGt)
    if (this.isOp('^')) {
      this.advance()
      // right associative; the exponent may carry a sign
      let exponent
      if (this.isOp('-')) { this.advance(); exponent = { t: 'neg', a: this.parsePowerOperand(noGt) } }
      else if (this.isOp('+')) { this.advance(); exponent = { t: 'plus', a: this.parsePowerOperand(noGt) } }
      else if (this.isOp('!')) { this.advance(); exponent = { t: 'not', a: this.parsePowerOperand(noGt) } }
      else exponent = this.parsePower(noGt)
      return { t: 'binary', op: '^', a: base, b: exponent }
    }
    return base
  }

  parsePowerOperand(noGt) { return this.parsePower(noGt) }

  parsePostfix(noGt) {
    const node = this.parsePrimary(noGt)
    if ((this.isOp('++') || this.isOp('--')) && this.isLvalue(node)) {
      return { t: 'postinc', op: this.advance().type, target: node }
    }
    return node
  }

  parseOptionalLvalue() {
    // getline var: a name, a subscripted name or a field
    if (this.token.type === 'name') {
      const name = this.advance().value
      if (this.isOp('[')) {
        this.advance()
        const subscripts = this.parseExpressionList(']')
        this.expectOp(']')
        return { t: 'index', array: this.variable(name), subscripts }
      }
      return this.variable(name)
    }
    if (this.isOp('$')) {
      this.advance()
      return { t: 'field', index: this.parseFieldOperand() }
    }
    return undefined
  }

  parseFieldOperand() {
    if (this.isOp('++') || this.isOp('--')) {
      const op = this.advance().type
      const target = this.parsePrimary(false)
      return { t: 'preinc', op, target }
    }
    if (this.isOp('-')) { this.advance(); return { t: 'neg', a: this.parseFieldOperand() } }
    if (this.isOp('+')) { this.advance(); return { t: 'plus', a: this.parseFieldOperand() } }
    if (this.isOp('!')) { this.advance(); return { t: 'not', a: this.parseFieldOperand() } }
    return this.parsePrimary(false)
  }

  parsePrimary(noGt) {
    const token = this.token
    switch (token.type) {
      case 'number': this.advance(); return { t: 'num', value: token.value }
      case 'string': this.advance(); return { t: 'str', value: token.value }
      case '/':
      case '/=': {
        const source = this.lexer.regexFrom(token.start)
        this.token = this.lexer.next()
        return { t: 'regex', source, regex: compileRegex(source) }
      }
      case '(': {
        this.advance()
        const list = this.parseExpressionList(')')
        this.expectOp(')')
        if (list.length === 0) this.fail()
        if (list.length > 1) return { t: 'grouping', list }
        return { t: 'group', a: list[0] }
      }
      case '$': {
        this.advance()
        return { t: 'field', index: this.parseFieldOperand() }
      }
      case '++':
      case '--': {
        this.advance()
        const target = this.parsePrimary(noGt)
        if (!this.isLvalue(target)) this.fail()
        return { t: 'preinc', op: token.type, target }
      }
      case '-': this.advance(); return { t: 'neg', a: this.parseUnary(noGt) }
      case '+': this.advance(); return { t: 'plus', a: this.parseUnary(noGt) }
      case '!': this.advance(); return { t: 'not', a: this.parseUnary(noGt) }
      case 'funcname': {
        this.advance()
        this.expectOp('(')
        const args = this.parseExpressionList(')')
        this.expectOp(')')
        return { t: 'call', name: token.value, args, line: token.line }
      }
      case 'builtin': return this.parseBuiltin()
      case 'keyword':
        if (token.value === 'getline') {
          this.advance()
          const target = this.parseOptionalLvalue()
          if (this.isOp('<')) {
            this.advance()
            return { t: 'getline', source: 'file', file: this.parseConcatenationNoPipe(), target }
          }
          return { t: 'getline', source: 'main', target }
        }
        break
      case 'name': {
        this.advance()
        if (this.isOp('[')) {
          this.advance()
          const subscripts = this.parseExpressionList(']')
          this.expectOp(']')
          return { t: 'index', array: this.variable(token.value), subscripts }
        }
        return this.variable(token.value)
      }
    }
    this.fail()
  }

  /** The file after `getline <`: a primary expression with no concatenation or comparison */
  parseConcatenationNoPipe() { return this.parsePostfix(true) }

  parseBuiltin() {
    const name = this.advance().value
    if (!this.isOp('(')) {
      // `length` alone is length($0)
      if (name === 'length') return { t: 'builtin', name, args: [] }
      this.fail()
    }
    this.advance()
    const args = this.parseExpressionList(')')
    this.expectOp(')')
    return { t: 'builtin', name, args }
  }
}

// - runtime --------------------------------------------------------------------------------------------------------

const FLOW = { NORMAL: 0, BREAK: 1, CONTINUE: 2, NEXT: 3, EXIT: 4, RETURN: 5, NEXTFILE: 6 }

class AwkArray {
  constructor() { this.map = new Map() }
}

/** An unset variable passed to a function: if the function makes it an array, the caller's variable becomes that array */
class Pending {
  constructor(assign) { this.assign = assign }
}

class Reader {
  constructor(fd, close) { this.fd = fd; this.close = close; this.buffer = ''; this.eof = false; this.stream = new TextDecoder('utf-8') }

  fill() {
    if (this.eof) return false
    const chunk = new Uint8Array(65536)
    flushHook()
    const count = read(this.fd, chunk, -1)
    if (count <= 0) { this.eof = true; this.buffer += this.stream.decode(); return false }
    this.buffer += this.stream.decode(chunk.subarray(0, count), { stream: true })
    return true
  }

  /** The next record under `rs`, or null at the end of the input */
  record(rs, rsRegex) {
    if (rs === '\n' || (rs.length === 1 && rs !== '')) {
      for (let from = 0; ;) {
        const at = this.buffer.indexOf(rs, from)
        if (at >= 0) { const text = this.buffer.slice(0, at); this.buffer = this.buffer.slice(at + 1); return text }
        from = this.buffer.length
        if (!this.fill()) break
      }
      if (this.buffer === '') return null
      const text = this.buffer
      this.buffer = ''
      return text
    }
    // paragraph mode and regular expression separators need the whole of the input
    while (this.fill());
    if (rs === '') {
      this.buffer = this.buffer.replace(/^\n+/, '')
      if (this.buffer === '') return null
      const at = this.buffer.search(/\n\n+/)
      if (at < 0) { const text = this.buffer.replace(/\n$/, ''); this.buffer = ''; return text }
      const match = /\n\n+/.exec(this.buffer)
      const text = this.buffer.slice(0, at)
      this.buffer = this.buffer.slice(at + match[0].length)
      return text
    }
    if (this.buffer === '') return null
    rsRegex.lastIndex = 0
    for (;;) {
      const match = rsRegex.exec(this.buffer)
      if (!match) break
      if (match[0] === '') { rsRegex.lastIndex++; continue }
      const text = this.buffer.slice(0, match.index)
      this.buffer = this.buffer.slice(match.index + match[0].length)
      return text
    }
    const text = this.buffer
    this.buffer = ''
    return text
  }
}

let flushHook = () => {}

const MAX_SAFE = 2 ** 53

class Interpreter {
  constructor(program, { assignments, files, fs }) {
    this.program = program
    this.globals = new Map()
    this.arrays = new Map()
    this.frames = []
    this.output = []
    this.outputSize = 0
    this.streams = new Map()
    this.readers = new Map()
    this.commands = new Map()
    this.exitCode = 0
    this.exiting = false
    this.record = ''
    this.fields = []
    this.nf = 0
    this.fieldsValid = true
    this.recordValid = true
    this.mainReader = undefined
    this.argIndex = 1
    this.initialize(files, env)
    for (const [name, value] of assignments) this.assignCommandLine(name, value)
    flushHook = () => this.flush()
    this.seed = 0
    this.randomState = 0
    this.fsRegexCache = undefined
  }

  initialize(files, environment) {
    const set = (name, value) => this.globals.set(name, value)
    set('FS', ' ')
    set('OFS', ' ')
    set('ORS', '\n')
    set('RS', '\n')
    set('NR', 0)
    set('FNR', 0)
    set('SUBSEP', '\x1c')
    set('RSTART', 0)
    set('RLENGTH', -1)
    set('CONVFMT', '%.6g')
    set('OFMT', '%.6g')
    set('FILENAME', '')
    const environ = new AwkArray()
    for (const [key, value] of Object.entries(environment ?? {})) environ.map.set(key, fromInput(String(value)))
    this.arrays.set('ENVIRON', environ)
    const args = new AwkArray()
    args.map.set('0', 'awk')
    files.forEach((file, index) => args.map.set(String(index + 1), fromInput(file)))
    this.arrays.set('ARGV', args)
    set('ARGC', files.length + 1)
  }

  fatal(message) { throw new LocatedError(message, this.location()) }

  warn(message) {
    this.flush()
    writeBytes(2, encoder.encode(`awk: ${this.location()}warning: ${message}\n`))
  }

  location() { return this.line ? `${this.sourceName === undefined ? 'cmd. line:' : this.sourceName + ':'}${this.line}: ` : '' }

  // output

  write(text) {
    this.output.push(text)
    this.outputSize += text.length
    if (this.outputSize > 65536) this.flush()
  }

  flush() {
    if (this.output.length === 0) return
    const bytes = encoder.encode(this.output.join(''))
    this.output = []
    this.outputSize = 0
    let offset = 0
    while (offset < bytes.length) {
      try { offset += write(1, bytes.subarray(offset), -1) } catch (error) {
        if (error?.code === 'EPIPE') { exit(2) }
        throw error
      }
    }
  }

  flushAll() {
    this.flush()
    for (const stream of this.streams.values()) stream.flush?.()
  }

  // type conversion

  toNum(value) {
    if (typeof value === 'number') return value
    if (value instanceof StrNum) return value.number
    if (value === UNINIT) return 0
    if (typeof value === 'string') return stringToNumber(value)
    return 0
  }

  numberToString(number, format) {
    if (Number.isInteger(number)) return Math.abs(number) < 2 ** 53 ? String(number === 0 ? 0 : number) : BigInt(number).toString()
    if (Number.isNaN(number)) return '-nan'
    if (number === Infinity) return '+inf'
    if (number === -Infinity) return '-inf'
    return this.sprintfNumber(format, number)
  }

  toStr(value) {
    if (typeof value === 'string') return value
    if (typeof value === 'number') return this.numberToString(value, this.globals.get('CONVFMT'))
    if (value instanceof StrNum) return value.text
    return ''
  }

  toOutputStr(value) {
    if (typeof value === 'number') return this.numberToString(value, this.globals.get('OFMT'))
    return this.toStr(value)
  }

  toBool(value) {
    if (typeof value === 'number') return value !== 0
    if (typeof value === 'string') return value !== ''
    if (value instanceof StrNum) return value.number !== 0
    return false
  }

  sprintfNumber(format, number) {
    return formatPrintf(typeof format === 'string' ? format : '%.6g', [String(number)])
  }

  // fields and records

  setRecord(text) {
    this.recordFS = this.toStr(this.globals.get('FS'))
    this.record = text
    this.recordValid = true
    this.fieldsValid = false
  }

  splitFields() {
    if (this.fieldsValid) return
    this.fieldsValid = true
    const parts = this.splitString(this.record, this.recordFS ?? this.toStr(this.globals.get('FS')), true)
    this.fields = parts.map(part => fromInput(part))
    this.nf = this.fields.length
  }

  /** `text` cut at the field separator `fs` (a string value of FS or a regular expression); `record` in paragraph mode also cuts at newlines */
  splitString(text, separator, forRecord = false) {
    if (text === '') return []
    const paragraph = forRecord && this.globals.get('RS') === ''
    if (typeof separator !== 'string') {
      // a regular expression
      return this.splitRegex(text, separator)
    }
    if (separator === ' ') {
      const trimmed = text.replace(/^[ \t\n]+|[ \t\n]+$/g, '')
      return trimmed === '' ? [] : trimmed.split(/[ \t\n]+/)
    }
    if (separator === '') return Array.from(text)
    if (separator.length === 1 && separator !== '\\') {
      if (paragraph) return text.split(new RegExp(`[${separator.replace(/[\\\]^-]/g, '\\$&')}\\n]`))
      return text.split(separator)
    }
    const regex = compileRegex(paragraph ? `(${separator})|\\n` : separator)
    return this.splitRegex(text, regex)
  }

  splitRegex(text, regex) {
    const parts = []
    let last = 0
    regex.lastIndex = 0
    for (;;) {
      const match = regex.exec(text)
      if (!match) break
      if (match[0] === '') { regex.lastIndex++; if (regex.lastIndex > text.length) break; continue }
      parts.push(text.slice(last, match.index))
      last = match.index + match[0].length
    }
    parts.push(text.slice(last))
    return parts
  }

  getField(index) {
    if (index === 0) {
      if (!this.recordValid) this.rebuildRecord()
      return fromInput(this.record)
    }
    if (index < 0) this.fatal(`attempt to access field ${index}`)
    this.splitFields()
    return index <= this.nf ? this.fields[index - 1] : UNINIT
  }

  rebuildRecord() {
    const ofs = this.toStr(this.globals.get('OFS'))
    this.record = this.fields.slice(0, this.nf).map(field => this.toStr(field)).join(ofs)
    this.recordValid = true
  }

  setField(index, value) {
    if (index === 0) { this.setRecord(this.toStr(value)); return }
    if (index < 0) this.fatal(`attempt to access field ${index}`)
    this.splitFields()
    while (this.nf < index) { this.fields.push(UNINIT); this.nf++ }
    this.fields[index - 1] = typeof value === 'number' || value instanceof StrNum ? value : this.toStr(value)
    this.recordValid = false
  }

  setNF(count) {
    this.splitFields()
    count = Math.max(0, Math.trunc(count))
    while (this.nf < count) { this.fields.push(UNINIT); this.nf++ }
    this.fields.length = count
    this.nf = count
    this.recordValid = false
  }

  // variables

  getVar(name) {
    if (name === 'NF') { this.splitFields(); return this.nf }
    const value = this.globals.get(name)
    if (value !== undefined) return value
    if (this.arrays.has(name)) this.fatal(`attempt to use array \`${name}' in a scalar context`)
    return UNINIT
  }

  setVar(name, value) {
    if (this.arrays.has(name)) this.fatal(`attempt to use array \`${name}' in a scalar context`)
    if (name === 'NF') { this.setNF(this.toNum(value)); return }
    this.globals.set(name, value)
    if (name === 'FS') this.fsRegexCache = undefined
  }

  getArray(node, frame) {
    if (node.t === 'local') {
      let cell = frame[node.index]
      if (cell instanceof AwkArray) return cell
      if (cell === undefined || cell === UNINIT || cell instanceof Pending) {
        const array = new AwkArray()
        if (cell instanceof Pending) cell.assign(array)
        frame[node.index] = array
        return array
      }
      this.fatal(`attempt to use scalar parameter \`${node.name}' as an array`)
    }
    let array = this.arrays.get(node.name)
    if (array) return array
    if (this.globals.has(node.name)) this.fatal(`attempt to use scalar \`${node.name}' as an array`)
    array = new AwkArray()
    this.arrays.set(node.name, array)
    return array
  }

  assignCommandLine(name, text) {
    this.setVar(name, fromInput(unescapeString(text)))
  }

  // evaluation

  async subscript(subscripts, frame) {
    if (subscripts.length === 1) return this.toStr(await this.evaluate(subscripts[0], frame))
    const sep = this.toStr(this.globals.get('SUBSEP'))
    const parts = []
    for (const sub of subscripts) parts.push(this.toStr(await this.evaluate(sub, frame)))
    return parts.join(sep)
  }

  async load(node, frame) {
    switch (node.t) {
      case 'var': return this.getVar(node.name)
      case 'local': {
        const cell = frame[node.index]
        if (cell instanceof AwkArray) this.fatal(`attempt to use array \`${node.name}' in a scalar context`)
        return cell === undefined || cell instanceof Pending ? UNINIT : cell
      }
      case 'index': {
        const array = this.getArray(node.array, frame)
        const key = await this.subscript(node.subscripts, frame)
        if (!array.map.has(key)) array.map.set(key, UNINIT)
        return array.map.get(key)
      }
      case 'field': return this.getField(Math.trunc(this.toNum(await this.evaluate(node.index, frame))))
    }
    this.fatal('invalid assignment target')
  }

  async store(node, value, frame) {
    switch (node.t) {
      case 'var': this.setVar(node.name, value); return
      case 'local': frame[node.index] = value; return
      case 'index': {
        const array = this.getArray(node.array, frame)
        array.map.set(await this.subscript(node.subscripts, frame), value)
        return
      }
      case 'field': this.setField(Math.trunc(this.toNum(await this.evaluate(node.index, frame))), value); return
    }
    this.fatal('invalid assignment target')
  }

  compare(a, b) {
    if (isNumeric(a) && isNumeric(b)) {
      const x = this.toNum(a), y = this.toNum(b)
      return x < y ? -1 : x > y ? 1 : x === y ? 0 : Number.isNaN(x) && Number.isNaN(y) ? 0 : Number.isNaN(x) ? 1 : -1
    }
    const x = this.toStr(a), y = this.toStr(b)
    return x < y ? -1 : x > y ? 1 : 0
  }

  regexOf(node, frame) {
    return node.t === 'regex' ? Promise.resolve(node.regex) : this.evaluate(node, frame).then(value => this.dynamicRegex(this.toStr(value)))
  }

  dynamicRegex(text) { return compileRegex(text) }

  async evaluate(node, frame) {
    switch (node.t) {
      case 'num': return node.value
      case 'str': return node.value
      case 'group': return await this.evaluate(node.a, frame)
      case 'grouping': this.fatal('syntax error: unexpected list'); break
      case 'var': case 'local': case 'index': case 'field': return await this.load(node, frame)
      case 'regex': {
        node.regex.lastIndex = 0
        return node.regex.test(this.toStr(this.getField(0))) ? 1 : 0
      }
      case 'assign': {
        let value = await this.evaluate(node.value, frame)
        if (node.op !== '=') {
          const left = this.toNum(await this.load(node.target, frame))
          const right = this.toNum(value)
          value = this.arith(node.op[0], left, right, true)
        } else if (value instanceof AwkArray) this.fatal('attempt to use array in a scalar context')
        await this.store(node.target, value, frame)
        return value
      }
      case 'ternary': return this.toBool(await this.evaluate(node.cond, frame)) ? await this.evaluate(node.a, frame) : await this.evaluate(node.b, frame)
      case 'or': return this.toBool(await this.evaluate(node.a, frame)) || this.toBool(await this.evaluate(node.b, frame)) ? 1 : 0
      case 'and': return this.toBool(await this.evaluate(node.a, frame)) && this.toBool(await this.evaluate(node.b, frame)) ? 1 : 0
      case 'in': {
        const key = await this.subscript(node.subscripts, frame)
        return this.getArray(node.array, frame).map.has(key) ? 1 : 0
      }
      case 'match': {
        const text = this.toStr(await this.evaluate(node.a, frame))
        const regex = await this.regexOf(node.b, frame)
        regex.lastIndex = 0
        const found = regex.test(text)
        return found !== node.negate ? 1 : 0
      }
      case 'compare': {
        const a = await this.evaluate(node.a, frame)
        const b = await this.evaluate(node.b, frame)
        const order = this.compare(a, b)
        switch (node.op) {
          case '<': return order < 0 ? 1 : 0
          case '<=': return order <= 0 ? 1 : 0
          case '==': return order === 0 ? 1 : 0
          case '!=': return order !== 0 ? 1 : 0
          case '>': return order > 0 ? 1 : 0
          case '>=': return order >= 0 ? 1 : 0
        }
        return 0
      }
      case 'concat': {
        const a = this.toStr(await this.evaluate(node.a, frame))
        return a + this.toStr(await this.evaluate(node.b, frame))
      }
      case 'binary': {
        const a = this.toNum(await this.evaluate(node.a, frame))
        const b = this.toNum(await this.evaluate(node.b, frame))
        return this.arith(node.op, a, b)
      }
      case 'neg': return -this.toNum(await this.evaluate(node.a, frame))
      case 'plus': return this.toNum(await this.evaluate(node.a, frame))
      case 'not': return this.toBool(await this.evaluate(node.a, frame)) ? 0 : 1
      case 'preinc': {
        const value = this.toNum(await this.load(node.target, frame)) + (node.op === '++' ? 1 : -1)
        await this.store(node.target, value, frame)
        return value
      }
      case 'postinc': {
        const old = this.toNum(await this.load(node.target, frame))
        await this.store(node.target, old + (node.op === '++' ? 1 : -1), frame)
        return old
      }
      case 'call': return await this.callFunction(node, frame)
      case 'builtin': return await this.builtin(node, frame)
      case 'getline': return await this.getline(node, frame)
    }
    this.fatal(`internal error: ${node.t}`)
  }

  arith(op, a, b, compound = false) {
    switch (op) {
      case '+': return a + b
      case '-': return a - b
      case '*': return a * b
      case '/': if (b === 0) this.fatal(`division by zero attempted${compound ? " in `/='" : ''}`); return a / b
      case '%': if (b === 0) this.fatal(`division by zero attempted in \`%${compound ? '=' : ''}'`); return a % b
      case '^': return a ** b
    }
    return 0
  }

  async callFunction(node, frame) {
    const fn = this.program.functions.get(node.name)
    if (!fn) this.fatal(`function \`${node.name}' not defined`)
    if (node.args.length > fn.params.length) this.fatal(`function \`${node.name}' called with ${node.args.length} args, accepts only ${fn.params.length}`)
    if (this.frames.length > 5000) this.fatal('function call nesting too deep')
    const next = new Array(fn.params.length)
    for (let i = 0; i < node.args.length; i++) {
      const arg = node.args[i]
      if (arg.t === 'var' || arg.t === 'local') {
        // a bare name is passed by reference when it is an array, and as a pending array when it is unset
        if (arg.t === 'local') {
          const cell = frame[arg.index]
          if (cell instanceof AwkArray || cell instanceof Pending) { next[i] = cell; continue }
          if (cell === undefined || cell === UNINIT) { next[i] = new Pending(array => { frame[arg.index] = array }); continue }
          next[i] = cell
          continue
        }
        const array = this.arrays.get(arg.name)
        if (array) { next[i] = array; continue }
        if (!this.globals.has(arg.name) && arg.name !== 'NF') { next[i] = new Pending(array => { this.arrays.set(arg.name, array) }); continue }
      }
      next[i] = await this.evaluate(arg, frame)
    }
    this.frames.push(next)
    try {
      const flow = await this.run(fn.body, next)
      if (flow === FLOW.EXIT) throw new ExitSignal()
      if (flow === FLOW.NEXT) throw new NextSignal()
      if (flow === FLOW.NEXTFILE) throw new NextSignal(true)
      const result = this.returnValue
      this.returnValue = undefined
      return result === undefined ? UNINIT : result
    } finally { this.frames.pop() }
  }

  // statements

  async run(node, frame) {
    if (node.line !== undefined) this.line = node.line
    switch (node.t) {
      case 'block': {
        for (const statement of node.body) {
          const flow = await this.run(statement, frame)
          if (flow !== FLOW.NORMAL) return flow
        }
        return FLOW.NORMAL
      }
      case 'expr': await this.evaluate(node.expr, frame); return FLOW.NORMAL
      case 'if': {
        if (this.toBool(await this.evaluate(node.cond, frame))) return await this.run(node.then, frame)
        if (node.otherwise) return await this.run(node.otherwise, frame)
        return FLOW.NORMAL
      }
      case 'while': {
        while (this.toBool(await this.evaluate(node.cond, frame))) {
          const flow = await this.run(node.body, frame)
          if (flow === FLOW.BREAK) break
          if (flow !== FLOW.NORMAL && flow !== FLOW.CONTINUE) return flow
        }
        return FLOW.NORMAL
      }
      case 'do': {
        do {
          const flow = await this.run(node.body, frame)
          if (flow === FLOW.BREAK) break
          if (flow !== FLOW.NORMAL && flow !== FLOW.CONTINUE) return flow
        } while (this.toBool(await this.evaluate(node.cond, frame)))
        return FLOW.NORMAL
      }
      case 'for': {
        if (node.init) await this.run(node.init, frame)
        while (node.cond === undefined || this.toBool(await this.evaluate(node.cond, frame))) {
          const flow = await this.run(node.body, frame)
          if (flow === FLOW.BREAK) break
          if (flow !== FLOW.NORMAL && flow !== FLOW.CONTINUE) return flow
          if (node.step) await this.run(node.step, frame)
        }
        return FLOW.NORMAL
      }
      case 'forin': {
        const array = this.getArray(node.array, frame)
        for (const key of [...array.map.keys()]) {
          if (!array.map.has(key)) continue
          await this.store(node.variable, fromInput(key), frame)
          const flow = await this.run(node.body, frame)
          if (flow === FLOW.BREAK) break
          if (flow !== FLOW.NORMAL && flow !== FLOW.CONTINUE) return flow
        }
        return FLOW.NORMAL
      }
      case 'break': return FLOW.BREAK
      case 'continue': return FLOW.CONTINUE
      case 'next': return FLOW.NEXT
      case 'nextfile': return FLOW.NEXTFILE
      case 'exit': {
        if (node.value) this.exitCode = Math.trunc(this.toNum(await this.evaluate(node.value, frame))) & 0xff
        return FLOW.EXIT
      }
      case 'return': {
        this.returnValue = node.value ? await this.evaluate(node.value, frame) : UNINIT
        return FLOW.RETURN
      }
      case 'delete': {
        const array = this.getArray(node.target, frame)
        if (node.subscripts) array.map.delete(await this.subscript(node.subscripts, frame))
        else array.map.clear()
        return FLOW.NORMAL
      }
      case 'print': await this.print(node, frame); return FLOW.NORMAL
    }
    this.fatal(`internal error: ${node.t}`)
  }

  // output statements

  async print(node, frame) {
    let text
    if (node.kind === 'print') {
      if (node.args.length === 0) text = this.toStr(this.getField(0))
      else {
        const parts = []
        for (const arg of node.args) parts.push(this.toOutputStr(await this.evaluate(arg, frame)))
        text = parts.join(this.toStr(this.globals.get('OFS')))
      }
      text += this.toStr(this.globals.get('ORS'))
    } else {
      if (node.args.length === 0) this.fatal('printf: no format')
      const values = []
      for (const arg of node.args) values.push(await this.evaluate(arg, frame))
      text = this.sprintf(this.toStr(values[0]), values.slice(1))
    }
    if (!node.redirect) { this.write(text); return }
    const target = this.toStr(await this.evaluate(node.redirect.target, frame))
    await this.writeTo(node.redirect.op, target, text)
  }

  async writeTo(op, target, text) {
    if (op !== '|' && (target === '/dev/stdout' || target === '-')) { this.write(text); return }
    let stream = this.streams.get(target)
    if (!stream) {
      if (op === '|') stream = await this.openCommandOut(target)
      else if (target === '/dev/stderr') stream = { write: text => writeBytes(2, encoder.encode(text)), flush() {}, close: () => 0 }
      else {
        this.flush()
        let fd
        try { fd = open(resolve(getcwd(), target), op === '>>' ? O_WRONLY | O_CREAT | O_APPEND : O_WRONLY | O_CREAT | O_TRUNC, 0o666) } catch (error) {
          this.fatal(`can't redirect to \`${target}' (${error?.message ?? error})`)
        }
        const pending = []
        stream = {
          write: text => { pending.push(text); if (pending.length > 256) stream.flush() },
          flush: () => { if (pending.length) { writeBytes(fd, encoder.encode(pending.join(''))); pending.length = 0 } },
          close: () => { stream.flush(); close(fd); return 0 }
        }
      }
      this.streams.set(target, stream)
    }
    stream.write(text)
  }

  async openCommandOut(command) {
    this.flush()
    const [reader, writer] = pipe()
    const shell = findProgram('sh') ?? '/bin/sh'
    const pid = await spawn(shell, ['sh', '-c', command], { cwd: getcwd(), env, fds: { 0: reader, 1: 1, 2: 2 } })
    close(reader)
    const pending = []
    const stream = {
      write: text => { pending.push(text) },
      flush: () => { if (pending.length) { writeBytes(writer, encoder.encode(pending.join(''))); pending.length = 0 } },
      close: async () => { stream.flush(); close(writer); return statusOf(await waitFor(pid)) },
      isCommand: true
    }
    return stream
  }

  sprintf(format, values) {
    let out = ''
    let i = 0
    let next = 0
    const take = () => {
      if (next >= values.length) this.fatal('not enough arguments to satisfy format string')
      return values[next++]
    }
    while (i < format.length) {
      const ch = format[i]
      if (ch !== '%') { out += ch; i++; continue }
      const match = /^%([-+ #0]*)(\*|\d+)?(?:\.(\*|\d*))?(?:hh|h|ll|l|L|q|j|z|t)?([a-zA-Z%])/.exec(format.slice(i))
      if (!match) { out += '%'; i++; continue }
      let [text, flags, width, precision, conversion] = match
      i += text.length
      if (conversion === '%') { out += '%'; continue }
      if (width === '*') { width = String(Math.trunc(this.toNum(take()))); if (width.startsWith('-')) { flags += '-'; width = width.slice(1) } }
      if (precision === '*') { const p = Math.trunc(this.toNum(take())); precision = p < 0 ? undefined : String(p) }
      const widthNumber = width ? Number(width) : 0
      const precisionNumber = precision === undefined ? undefined : Number(precision || 0)
      const left = flags.includes('-')
      const pad = (s, zero = false) => {
        if (s.length >= widthNumber) return s
        if (left) return s.padEnd(widthNumber)
        if (zero) {
          const sign = /^[+\- ]/.test(s) ? s[0] : ''
          const prefix = /^[+\- ]?0[xX]/.test(s) ? s.slice(sign.length, sign.length + 2) : ''
          return sign + prefix + s.slice(sign.length + prefix.length).padStart(widthNumber - sign.length - prefix.length, '0')
        }
        return s.padStart(widthNumber)
      }
      switch (conversion) {
        case 'c': {
          const value = take()
          let char
          if (typeof value === 'number' || (value instanceof StrNum)) {
            const code = Math.trunc(this.toNum(value))
            char = code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '�'
          } else char = Array.from(this.toStr(value))[0] ?? '\0'
          out += pad(char)
          break
        }
        case 's': {
          let s = this.toStr(take())
          if (precisionNumber !== undefined) s = Array.from(s).slice(0, precisionNumber).join('')
          out += pad(s)
          break
        }
        case 'd': case 'i': case 'o': case 'x': case 'X': case 'u': {
          const number = this.toNum(take())
          if (!Number.isFinite(number)) { out += pad(Number.isNaN(number) ? (flags.includes('+') ? '+nan' : '-nan') : number > 0 ? (flags.includes('+') ? '+inf' : 'inf') : '-inf'); break }
          let big = BigInt(Math.trunc(number))
          let negative = false
          let digits
          if (conversion === 'd' || conversion === 'i') { negative = big < 0n; digits = (negative ? -big : big).toString() }
          else {
            if (big < 0n) big = BigInt.asUintN(64, big)
            digits = conversion === 'o' ? big.toString(8) : conversion === 'u' ? big.toString() : conversion === 'x' ? big.toString(16) : big.toString(16).toUpperCase()
          }
          if (precisionNumber !== undefined) digits = digits.padStart(precisionNumber, '0')
          if (precisionNumber === 0 && big === 0n) digits = ''
          if (flags.includes('#')) {
            if (conversion === 'o' && !digits.startsWith('0')) digits = '0' + digits
            else if ((conversion === 'x' || conversion === 'X') && big !== 0n) digits = (conversion === 'x' ? '0x' : '0X') + digits
          }
          const sign = negative ? '-' : (conversion === 'd' || conversion === 'i') ? (flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '') : ''
          out += pad(sign + digits, flags.includes('0') && precisionNumber === undefined)
          break
        }
        case 'e': case 'E': case 'f': case 'F': case 'g': case 'G': case 'a': case 'A': {
          const number = this.toNum(take())
          if (!Number.isFinite(number)) {
            const s = Number.isNaN(number) ? '-nan' : number > 0 ? (flags.includes('+') ? '+inf' : 'inf') : '-inf'
            out += pad(conversion === conversion.toUpperCase() ? s.toUpperCase() : s)
            break
          }
          const spec = `%${flags.replace(/0/g, '').replace(/-/g, '')}${precisionNumber !== undefined ? '.' + precisionNumber : ''}${conversion}`
          let s = formatPrintf(spec, [String(number)])
          out += pad(s, flags.includes('0'))
          break
        }
        default:
          out += text
      }
    }
    return out
  }

  // built-in functions

  async builtin(node, frame) {
    const { name, args } = node
    const evalArg = async index => await this.evaluate(args[index], frame)
    const need = (min, max) => { if (args.length < min || args.length > max) this.fatal(`${name}: called with ${args.length} argument${args.length === 1 ? '' : 's'}`) }
    switch (name) {
      case 'length': {
        if (args.length === 0) return Array.from(this.toStr(this.getField(0))).length
        const arg = args[0]
        if (arg.t === 'var' && this.arrays.has(arg.name)) return this.arrays.get(arg.name).map.size
        if (arg.t === 'local' && frame[arg.index] instanceof AwkArray) return frame[arg.index].map.size
        return Array.from(this.toStr(await evalArg(0))).length
      }
      case 'substr': {
        need(2, 3)
        const text = this.toStr(await evalArg(0))
        const chars = Array.from(text)
        let start = this.toNum(await evalArg(1))
        if (Number.isNaN(start)) return ''
        start = Math.max(1, Math.trunc(start))
        let length = args.length === 3 ? this.toNum(await evalArg(2)) : Infinity
        if (Number.isNaN(length)) return ''
        length = Math.trunc(length)
        if (length < 1) return ''
        return chars.slice(start - 1, start - 1 + length).join('')
      }
      case 'index': {
        need(2, 2)
        const text = this.toStr(await evalArg(0))
        const find = this.toStr(await evalArg(1))
        const at = text.indexOf(find)
        return at < 0 ? 0 : Array.from(text.slice(0, at)).length + 1
      }
      case 'tolower': return this.toStr(await evalArg(0)).toLowerCase()
      case 'toupper': return this.toStr(await evalArg(0)).toUpperCase()
      case 'sprintf': {
        if (args.length === 0) this.fatal('sprintf: no format')
        const values = []
        for (let i = 0; i < args.length; i++) values.push(await evalArg(i))
        return this.sprintf(this.toStr(values[0]), values.slice(1))
      }
      case 'int': return Math.trunc(this.toNum(await evalArg(0)))
      case 'sqrt': {
        const x = this.toNum(await evalArg(0))
        if (x < 0) this.warn(`sqrt: called with negative argument ${this.numberToString(x, '%.6g')}`)
        return Math.sqrt(x)
      }
      case 'exp': {
        const x = this.toNum(await evalArg(0))
        if (x > 709.78) this.warn(`exp: argument ${this.numberToString(x, '%.6g')} is out of range`)
        return Math.exp(x)
      }
      case 'log': {
        const x = this.toNum(await evalArg(0))
        if (x < 0) this.warn(`log: received negative argument ${this.numberToString(x, '%.6g')}`)
        return Math.log(x)
      }
      case 'sin': return Math.sin(this.toNum(await evalArg(0)))
      case 'cos': return Math.cos(this.toNum(await evalArg(0)))
      case 'atan2': return Math.atan2(this.toNum(await evalArg(0)), this.toNum(await evalArg(1)))
      case 'rand': {
        this.randomState = (Math.imul(this.randomState, 1103515245) + 12345) & 0x7fffffff
        return this.randomState / 0x80000000
      }
      case 'srand': {
        const previous = this.seed
        this.seed = args.length ? Math.trunc(this.toNum(await evalArg(0))) : Math.floor(Date.now() / 1000)
        this.randomState = this.seed
        return previous
      }
      case 'systime': return Math.floor(Date.now() / 1000)
      case 'match': {
        need(2, 3)
        const text = this.toStr(await evalArg(0))
        const regex = await this.regexOf(args[1], frame)
        regex.lastIndex = 0
        const found = regex.exec(text)
        let start = 0, length = -1
        if (found) { start = Array.from(text.slice(0, found.index)).length + 1; length = Array.from(found[0]).length }
        this.globals.set('RSTART', start)
        this.globals.set('RLENGTH', length)
        if (args.length === 3) {
          const array = this.getArray(args[2], frame)
          array.map.clear()
          if (found) found.forEach((part, index) => { if (part !== undefined) array.map.set(String(index), fromInput(part)) })
        }
        return start
      }
      case 'split': {
        need(2, 4)
        const text = this.toStr(await evalArg(0))
        const array = this.getArray(args[1], frame)
        let separator
        if (args.length >= 3) {
          const sepNode = args[2]
          if (sepNode.t === 'regex') separator = sepNode.regex
          else {
            const value = this.toStr(await this.evaluate(sepNode, frame))
            separator = value
          }
        } else separator = this.toStr(this.globals.get('FS'))
        array.map.clear()
        const parts = this.splitString(text, typeof separator === 'string' && separator.length > 1 ? compileRegex(separator) : separator)
        parts.forEach((part, index) => array.map.set(String(index + 1), fromInput(part)))
        return parts.length
      }
      case 'sub':
      case 'gsub': {
        need(2, 3)
        const regex = await this.regexOf(args[0], frame)
        const replacement = this.toStr(await evalArg(1))
        const target = args.length === 3 ? args[2] : { t: 'field', index: { t: 'num', value: 0 } }
        if (args.length === 3 && !this.isLvalue(target)) {
          // a non-lvalue target: the substitution is computed and discarded
          const [, count] = this.substitute(regex, replacement, this.toStr(await this.evaluate(target, frame)), name === 'gsub')
          return count
        }
        const current = this.toStr(await this.load(target, frame))
        const [result, count] = this.substitute(regex, replacement, current, name === 'gsub')
        if (count > 0) await this.store(target, result, frame)
        return count
      }
      case 'system': {
        const command = this.toStr(await evalArg(0))
        this.flushAll()
        const shell = findProgram('sh') ?? '/bin/sh'
        const pid = await spawn(shell, ['sh', '-c', command], { cwd: getcwd(), env, fds: { 0: 0, 1: 1, 2: 2 } })
        const done = await waitFor(pid)
        return done.signal ? 256 + done.signal : done.code
      }
      case 'close': {
        const name = this.toStr(await evalArg(0))
        return await this.closeStream(name)
      }
      case 'fflush': {
        this.flushAll()
        return 0
      }
      case 'strftime': return ''
    }
    this.fatal(`function ${name} is not supported`)
  }

  isLvalue(node) { return node.t === 'var' || node.t === 'local' || node.t === 'index' || node.t === 'field' }

  substitute(regex, replacement, text, global) {
    let out = ''
    let position = 0
    let searchFrom = 0
    let count = 0
    let previousEnd = -1
    while (searchFrom <= text.length) {
      regex.lastIndex = searchFrom
      const match = regex.exec(text)
      if (!match) break
      const start = match.index
      const length = match[0].length
      if (length === 0 && start === previousEnd) {
        if (start >= text.length) break
        searchFrom = start + 1
        continue
      }
      out += text.slice(position, start) + expandReplacement(replacement, match[0])
      count++
      position = start + length
      previousEnd = position
      if (!global) break
      if (length === 0) {
        if (start >= text.length) break
        searchFrom = start + 1
      } else searchFrom = position
    }
    out += text.slice(position)
    return [out, count]
  }

  // input

  async getline(node, frame) {
    const assignRecord = async (text, withNR) => {
      if (node.target) await this.store(node.target, fromInput(text), frame)
      else this.setRecord(text)
      if (withNR) {
        this.globals.set('NR', this.toNum(this.globals.get('NR')) + 1)
        if (node.source === 'main') this.globals.set('FNR', this.toNum(this.globals.get('FNR')) + 1)
      }
    }
    if (node.source === 'main') {
      const text = await this.nextMainRecord()
      if (text === null) return 0
      await assignRecord(text, true)
      return 1
    }
    if (node.source === 'file') {
      const name = this.toStr(await this.evaluate(node.file, frame))
      let reader = this.readers.get(name)
      if (!reader) {
        try {
          if (name === '-' || name === '/dev/stdin') reader = new Reader(0, false)
          else {
            const path = resolve(getcwd(), name)
            const fd = open(path, O_RDONLY, 0)
            reader = new Reader(fd, true)
            // a directory opens but cannot be read
            try { reader.fill() } catch { close(fd); return -1 }
          }
        } catch { return -1 }
        this.readers.set(name, reader)
      }
      const text = reader.record(this.toStr(this.globals.get('RS')), this.rsRegex())
      if (text === null) return 0
      await assignRecord(text, false)
      return 1
    }
    // cmd | getline
    const command = this.toStr(await this.evaluate(node.command, frame))
    let reader = this.readers.get(command)
    if (!reader) {
      this.flushAll()
      const [readEnd, writeEnd] = pipe()
      const shell = findProgram('sh') ?? '/bin/sh'
      const pid = await spawn(shell, ['sh', '-c', command], { cwd: getcwd(), env, fds: { 0: 0, 1: writeEnd, 2: 2 } })
      close(writeEnd)
      reader = new Reader(readEnd, true)
      reader.pid = pid
      this.readers.set(command, reader)
    }
    const text = reader.record(this.toStr(this.globals.get('RS')), this.rsRegex())
    if (text === null) return 0
    await assignRecord(text, true)
    // only NR changes for a command's lines
    return 1
  }

  rsRegex() {
    const rs = this.toStr(this.globals.get('RS'))
    if (rs.length <= 1) return undefined
    if (!this.rsCache || this.rsCache.source !== rs) this.rsCache = { source: rs, regex: compileRegex(rs) }
    return this.rsCache.regex
  }

  async closeStream(name) {
    let result = -1
    const stream = this.streams.get(name)
    if (stream) {
      this.streams.delete(name)
      result = await stream.close()
    }
    const reader = this.readers.get(name)
    if (reader) {
      this.readers.delete(name)
      if (reader.close) close(reader.fd)
      result = 0
      if (reader.pid !== undefined) result = statusOf(await waitFor(reader.pid))
    }
    return result
  }

  /** The next record of the main input: the files named in ARGV, or standard input when there are none */
  async nextMainRecord() {
    for (;;) {
      if (!this.mainReader) {
        if (!(await this.openNextFile())) return null
      }
      const text = this.mainReader.record(this.toStr(this.globals.get('RS')), this.rsRegex())
      if (text !== null) return text
      if (this.mainReader.close) close(this.mainReader.fd)
      this.mainReader = undefined
    }
  }

  async openNextFile() {
    const argv = this.arrays.get('ARGV')
    for (;;) {
      const argc = Math.trunc(this.toNum(this.globals.get('ARGC')))
      if (this.argIndex >= argc) {
        if (this.usedFile) return false
        this.usedFile = true
        this.mainReader = new Reader(0, false)
        this.globals.set('FNR', 0)
        return true
      }
      const arg = argv.map.get(String(this.argIndex++))
      if (arg === undefined) continue
      const text = this.toStr(arg)
      if (text === '') continue
      const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(text)
      if (assignment) { this.assignCommandLine(assignment[1], assignment[2]); continue }
      this.usedFile = true
      this.globals.set('FILENAME', text)
      this.globals.set('FNR', 0)
      if (text === '-' || text === '/dev/stdin') { this.mainReader = new Reader(0, false); return true }
      try {
        const fd = open(resolve(getcwd(), text), O_RDONLY, 0)
        const reader = new Reader(fd, true)
        try { reader.fill() } catch (error) {
          close(fd)
          if (error?.code === 'EISDIR' || /is a directory|illegal operation on a directory/i.test(error?.message ?? '')) { writeBytes(2, encoder.encode(`awk: warning: command line argument \`${text}' is a directory: skipped\n`)); continue }
          throw error
        }
        this.mainReader = reader
        return true
      } catch (error) {
        // opening a directory fails outright; gawk skips it with a warning and goes on to the next operand
        if (error?.code === 'EISDIR' || /is a directory|illegal operation on a directory/i.test(error?.message ?? '')) { writeBytes(2, encoder.encode(`awk: warning: command line argument \`${text}' is a directory: skipped\n`)); continue }
        throw new AwkError(`cannot open file \`${text}' for reading: ${error?.code === 'ENOENT' || /no such file/i.test(error?.message ?? '') ? 'No such file or directory' : error?.code === 'EACCES' ? 'Permission denied' : (error?.message ?? error)}`)
      }
    }
  }

  // the main loop

  async runMain() {
    let exited = false
    try {
      for (const block of this.program.begin) {
        const flow = await this.run(block, [])
        if (flow === FLOW.EXIT) { exited = true; break }
      }
    } catch (signal) {
      if (signal instanceof ExitSignal) exited = true
      else if (signal instanceof NextSignal) this.fatal('`next\' used in BEGIN action')
      else throw signal
    }
    if (!exited && (this.program.rules.length > 0 || this.program.end.length > 0)) {
      try {
        for (;;) {
          const text = await this.nextMainRecord()
          if (text === null) break
          this.globals.set('NR', this.toNum(this.globals.get('NR')) + 1)
          this.globals.set('FNR', this.toNum(this.globals.get('FNR')) + 1)
          this.setRecord(text)
          let flow
          try { flow = await this.runRules() } catch (signal) {
            if (signal instanceof NextSignal) { if (signal.file) this.skipFile(); continue }
            throw signal
          }
          if (flow === FLOW.EXIT) { exited = true; break }
          if (flow === FLOW.NEXTFILE) this.skipFile()
        }
      } catch (signal) {
        if (signal instanceof ExitSignal) exited = true
        else throw signal
      }
    }
    // END runs after exit in BEGIN or in a rule, but not after exit in END itself
    try {
      for (const block of this.program.end) {
        const flow = await this.run(block, [])
        if (flow === FLOW.EXIT) break
      }
    } catch (signal) {
      if (!(signal instanceof ExitSignal)) throw signal
    }
  }

  skipFile() {
    if (this.mainReader) {
      if (this.mainReader.close) close(this.mainReader.fd)
      this.mainReader = undefined
    }
  }

  async runRules() {
    for (const rule of this.program.rules) {
      this.line = rule.line
      let matched
      if (rule.pattern === undefined) matched = true
      else if (rule.patternEnd) {
        if (!rule.active) {
          if (this.toBool(await this.evaluate(rule.pattern, []))) {
            matched = true
            rule.active = !this.toBool(await this.evaluate(rule.patternEnd, []))
          } else matched = false
        } else {
          matched = true
          if (this.toBool(await this.evaluate(rule.patternEnd, []))) rule.active = false
        }
      } else matched = this.toBool(await this.evaluate(rule.pattern, []))
      if (!matched) continue
      if (!rule.action) { this.write(this.toStr(this.getField(0)) + this.toStr(this.globals.get('ORS'))); continue }
      const flow = await this.run(rule.action, [])
      if (flow === FLOW.NEXT) return FLOW.NORMAL
      if (flow !== FLOW.NORMAL) return flow
    }
    return FLOW.NORMAL
  }

  async finish() {
    for (const name of [...this.streams.keys()]) {
      try { await this.closeStream(name) } catch { /* leaving anyway */ }
    }
    for (const name of [...this.readers.keys()]) {
      try { await this.closeStream(name) } catch { /* leaving anyway */ }
    }
    this.flush()
  }
}

class ExitSignal extends Error {}
class NextSignal extends Error { constructor(file = false) { super('next'); this.file = file } }

/** The replacement text of `sub`/`gsub` for one match: `&` is the match, `\&` a literal `&`, as gawk reads it */
function expandReplacement(replacement, matched) {
  if (!replacement.includes('&') && !replacement.includes('\\')) return replacement
  let out = ''
  for (let i = 0; i < replacement.length; i++) {
    const ch = replacement[i]
    if (ch === '&') out += matched
    else if (ch === '\\') {
      if (replacement.startsWith('\\\\\\&', i)) { out += '\\&'; i += 3 }
      else if (replacement.startsWith('\\\\&', i)) { out += '\\' + matched; i += 2 }
      else if (replacement[i + 1] === '&') { out += '&'; i++ }
      else out += '\\'
    } else out += ch
  }
  return out
}

function writeBytes(fd, bytes) {
  let offset = 0
  while (offset < bytes.length) offset += write(fd, bytes.subarray(offset), -1)
}

// - command line ---------------------------------------------------------------------------------------------------

const usage = `Usage: awk [POSIX or GNU style options] -f progfile [--] file ...
Usage: awk [POSIX or GNU style options] [--] 'program' file ...
POSIX options:		GNU long options: (standard)
	-f progfile		--file=progfile
	-F fs			--field-separator=fs
	-v var=val		--assign=var=val
Short options:		GNU long options: (extensions)
	-h			--help
	-V			--version`

async function main() {
  const args = argv.slice(1)
  const programFiles = []
  const assignments = []
  let fieldSeparator
  let i = 0
  const message = text => writeBytes(2, encoder.encode(`awk: ${text}\n`))
  for (; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { i++; break }
    if (arg === '-' || !arg.startsWith('-')) break
    const take = (flag, long) => {
      if (long) { const eq = arg.indexOf('='); if (eq >= 0) return arg.slice(eq + 1); return args[++i] }
      return arg.length > 2 ? arg.slice(2) : args[++i]
    }
    if (arg === '--version' || arg === '-V' || arg === '-version') { writeBytes(1, encoder.encode('GNU Awk compatible 5.3 (ecmaOS awk)\n')); return 0 }
    if (arg === '--help' || arg === '-h') { writeBytes(1, encoder.encode(usage + '\n')); return 0 }
    if (arg.startsWith('-F') || arg.startsWith('--field-separator')) { fieldSeparator = take('F', arg.startsWith('--')); if (fieldSeparator === undefined) { message('option requires an argument -- F'); return 2 } continue }
    if (arg.startsWith('-v') || arg.startsWith('--assign')) {
      const value = take('v', arg.startsWith('--'))
      if (value === undefined) { message('option requires an argument -- v'); return 2 }
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(value)
      if (!match) { message(`improper assignment: -v ${value}`); return 2 }
      assignments.push([match[1], match[2]])
      continue
    }
    if (arg.startsWith('-f') || arg.startsWith('--file')) {
      const value = take('f', arg.startsWith('--'))
      if (value === undefined) { message('option requires an argument -- f'); return 2 }
      programFiles.push(value)
      continue
    }
    message(`warning: unknown option ${arg} ignored`)
  }
  let text
  if (programFiles.length) {
    const parts = []
    for (const file of programFiles) {
      try { parts.push(decoder.decode(file === '-' || file === '/dev/stdin' ? readFileBytes('/dev/stdin') : readFileBytes(resolve(getcwd(), file)))) } catch {
        message(`fatal: cannot open source file \`${file}' for reading: No such file or directory`)
        return 2
      }
    }
    text = parts.join('\n')
  } else {
    if (i >= args.length) { writeBytes(2, encoder.encode(usage + '\n')); return 1 }
    text = args[i++]
  }
  const files = args.slice(i)
  let program
  try { program = new Parser(text).parseProgram() } catch (error) {
    if (error instanceof AwkError) { message(error.message); return 1 }
    throw error
  }
  const interpreter = new Interpreter(program, { assignments: [], files })
  if (programFiles.length) interpreter.sourceName = programFiles[0]
  if (fieldSeparator !== undefined) {
    const value = fieldSeparator === 't' ? 't' : unescapeString(fieldSeparator)
    interpreter.globals.set('FS', value)
  }
  for (const [name, value] of assignments) interpreter.assignCommandLine(name, value)
  try {
    await interpreter.runMain()
    await interpreter.finish()
    return interpreter.exitCode
  } catch (error) {
    try { await interpreter.finish() } catch { /* the error is the news */ }
    if (error instanceof LocatedError) { message(`${error.where}fatal: ${error.message}`); return 2 }
    if (error instanceof AwkError) { message(`fatal: ${error.message}`); return 2 }
    throw error
  }
}

try {
  exit(await main())
} catch (error) {
  writeBytes(2, encoder.encode(`awk: ${error?.message ?? String(error)}\n`))
  exit(2)
}
