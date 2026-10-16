/**
 * A recursive-descent shell parser: tokenizer, AST, and the shapes `Shell.execute` walks.
 *
 * Grammar:
 * ```
 * Script      := Pipeline (( ';' | '&' | '&&' | '||' ) Pipeline)*
 * Pipeline    := ['!'] Command ('|' Command)*
 * Command     := Conditional Redirection* | (Word | Redirection)+
 * Conditional := '[[' <expression> ']]'
 * Redirection := [n] ('>' | '>>' | '<' | '>&' | '<<' | '<<<') Word
 * ```
 *
 * Each word is a list of {@link WordPart}s, one per run with the same quoting, since expansion depends on it.
 * `$(...)`, `$((...))`, `${...}` and backticks are kept whole and expanded later (`word-expansion.ts`). Heredoc
 * bodies are folded onto their command's line first (`foldHeredocs`).
 */

import type { Statement } from './control-flow-parser.js'

export type RedirectionType = '>' | '>>' | '>|' | '<' | '<<' | '<<<' | '>&'

/** How a run of characters inside a word was quoted. */
export type Quoting = 'unquoted' | 'single' | 'double' | 'escaped'

/** One run of a word's text sharing the same quoting. */
export interface WordPart {
  text: string
  quoting: Quoting
  /** Set on a whole-word part that is a process substitution, `<(cmd)` or `>(cmd)`. `text` keeps the source. */
  procSub?: { direction: '<' | '>', command: string }
}

/** A heredoc's body and whether it undergoes expansion (its delimiter was unquoted). */
export interface Heredoc {
  body: string
  expand: boolean
}

export interface Redirection {
  type: RedirectionType
  /** The file descriptor being redirected, e.g. 2 for `2>`. Defaults to 1 for '>'/'>>', 0 for '<'/'<<'/'<<<' */
  fd: number
  /** The target: a word for `>`/`>>`/`<`/`<<<`, the body for `<<`, or another fd for `>&` */
  target: string
  /** The target word's parts, for expansion (absent for `<<` and a `>&` fd target) */
  targetParts?: WordPart[]
  /** Whether the target of `>&` is a file descriptor number (`2>&1`) rather than a word */
  targetIsFd?: boolean
  /** For `<<`: the body and whether to expand it */
  heredoc?: Heredoc
}

export interface Command {
  type: 'command'
  words: string[]
  /** Whether each word in `words` (by index) was fully quoted - an unquoted word may still glob */
  wordsQuoted: boolean[]
  /** Each word's parts, by index, for quote-aware expansion */
  wordParts: WordPart[][]
  redirections: Redirection[]
  /** For a `[[ ... ]]` command: the raw text between the brackets */
  conditional?: string
  /**
   * Set on a stage that is a compound statement (`... | while read x; do ...; done`, `{ ...; } | cmd`):
   * `words` is empty and the host runs this instead of a program.
   */
  compound?: Statement
}

export interface Pipeline {
  type: 'pipeline'
  commands: Command[]
  /** Whether the whole pipeline is negated with a leading `!` */
  negated: boolean
}

export type ScriptOperator = ';' | '&' | '&&' | '||'

export interface ScriptStage {
  pipeline: Pipeline
  /** The operator that follows this stage, or null for the last stage */
  operator: ScriptOperator | null
}

export interface Script {
  type: 'script'
  stages: ScriptStage[]
}

export class ParseError extends Error {}

const OPERATORS = ['&&', '||', ';', '&', '|'] as const

export interface Token {
  kind: 'word' | 'operator' | 'redirect' | 'conditional'
  value: string
  /** For 'redirect' tokens: the fd prefix, if any (e.g. 2 in `2>`) */
  fd?: number
  /** For 'word' tokens: whether every character came from inside quotes (so it should not glob) */
  quoted?: boolean
  /** For 'word' tokens: the word's parts */
  parts?: WordPart[]
}

/** Marks a heredoc token `foldHeredocs` produced; never typed by a user. */
const HEREDOC_MARK = '\u0000'

/**
 * Index just past the expansion (`$(...)`, `$((...))`, `${...}`) or backtick span starting at
 * `start`, honoring nesting and quotes inside it; `-1` if `start` doesn't open one or it never
 * closes.
 */
export function scanExpansionEnd(text: string, start: number): number {
  if (text[start] === '`') {
    let j = start + 1
    while (j < text.length && text[j] !== '`') j += text[j] === '\\' ? 2 : 1
    return j < text.length ? j + 1 : -1
  }

  if (text[start] !== '$') return -1
  const open = text[start + 1]
  if (open !== '(' && open !== '{') return -1
  const close = open === '(' ? ')' : '}'

  let depth = 0
  let j = start + 1
  while (j < text.length) {
    const c = text[j] as string
    if (c === '\\') { j += 2; continue }
    if (c === "'" && open === '(') {
      const end = text.indexOf("'", j + 1)
      if (end === -1) return -1
      j = end + 1
      continue
    }
    if (c === '"') {
      let k = j + 1
      while (k < text.length && text[k] !== '"') {
        if (text[k] === '\\') { k += 2; continue }
        const inner = text[k] === '$' || text[k] === '`' ? scanExpansionEnd(text, k) : -1
        k = inner > 0 ? inner : k + 1
      }
      if (k >= text.length) return -1
      j = k + 1
      continue
    }
    if (c === '`' || (c === '$' && (text[j + 1] === '(' || text[j + 1] === '{') && j !== start)) {
      const end = scanExpansionEnd(text, j)
      if (end === -1) return -1
      j = end
      continue
    }
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return j + 1
    }
    j++
  }
  return -1
}

const ANSI_C_ESCAPES: Record<string, string> = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' }

/** The text of a `$'...'` body with its backslash sequences replaced by what they stand for. */
export function decodeAnsiC(body: string): string {
  let out = ''
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string
    if (c !== '\\' || i + 1 >= body.length) { out += c; continue }
    const next = body[++i] as string
    if (next in ANSI_C_ESCAPES) { out += ANSI_C_ESCAPES[next]; continue }
    if (/[0-7]/.test(next)) {
      let digits = next
      while (digits.length < 3 && /[0-7]/.test(body[i + 1] ?? '')) digits += body[++i]
      out += String.fromCharCode(parseInt(digits, 8) & 0xff)
      continue
    }
    const hex = next === 'x' ? 2 : next === 'u' ? 4 : next === 'U' ? 8 : 0
    if (hex) {
      let digits = ''
      while (digits.length < hex && /[0-9a-fA-F]/.test(body[i + 1] ?? '')) digits += body[++i]
      if (digits) { out += String.fromCodePoint(parseInt(digits, 16)); continue }
    }
    if (next === 'c' && i + 1 < body.length) { out += String.fromCharCode((body[++i] as string).charCodeAt(0) & 0x1f); continue }
    out += '\\' + next
  }
  return out
}

/**
 * Reads one word starting at `start`: quotes, escapes and expansions are consumed whole; the word
 * ends at unquoted whitespace, an operator character, or (when `stopAt` says so) something else.
 */
function readWord(line: string, start: number, isStop: (i: number) => boolean): { parts: WordPart[], end: number } {
  const parts: WordPart[] = []
  const push = (text: string, quoting: Quoting) => {
    const last = parts[parts.length - 1]
    if (last && last.quoting === quoting && quoting !== 'escaped') last.text += text
    else parts.push({ text, quoting })
  }

  // An extended pattern (`@(a|b)`, `!(x)`, `*(y)`) is one word whatever is in its parentheses. Nothing else puts a
  // parenthesis straight after one of those characters, so this does not need to know whether `extglob` is on.
  const extglobOpen = (j: number) => line[j] === '(' && j > start && '?*+@!'.includes(line[j - 1] as string)

  let i = start
  while (i < line.length && (!isStop(i) || extglobOpen(i))) {
    const char = line[i] as string

    if (char === '(' && extglobOpen(i)) {
      let depth = 0
      let j = i
      for (; j < line.length; j++) {
        const d = line[j] as string
        if (d === '\\') { j++; continue }
        if (d === "'" || d === '"') { const end = line.indexOf(d, j + 1); if (end === -1) break; j = end; continue }
        if (d === '(') depth++
        else if (d === ')' && --depth === 0) break
      }
      if (j < line.length) { push(line.slice(i, j + 1), 'unquoted'); i = j + 1; continue }
    }

    if (char === '\\') {
      if (i + 1 >= line.length) { push('\\', 'unquoted'); i++; continue }
      if (line[i + 1] === '\n') { i += 2; continue } // line continuation
      push(line[i + 1] as string, 'escaped')
      i += 2
      continue
    }

    // `$'...'`: single quotes in which backslash sequences (`\n`, `\t`, `\x41`, `\u00e9`) mean characters
    if (char === '$' && line[i + 1] === "'") {
      let j = i + 2
      while (j < line.length && line[j] !== "'") j += line[j] === '\\' ? 2 : 1
      if (j >= line.length) throw new ParseError('Unterminated single quote')
      push(decodeAnsiC(line.slice(i + 2, j)), 'single')
      i = j + 1
      continue
    }

    if (char === "'") {
      const end = line.indexOf("'", i + 1)
      if (end === -1) throw new ParseError('Unterminated single quote')
      push(line.slice(i + 1, end), 'single')
      i = end + 1
      continue
    }

    if (char === '"') {
      let j = i + 1
      let text = ''
      const flushDouble = () => { if (text) { push(text, 'double'); text = '' } }
      // An empty "" still makes a (quoted, empty) word.
      let sawAny = false
      while (j < line.length && line[j] !== '"') {
        sawAny = true
        const c = line[j] as string
        if (c === '\\' && j + 1 < line.length && '"\\$`\n'.includes(line[j + 1] as string)) {
          flushDouble()
          if (line[j + 1] !== '\n') push(line[j + 1] as string, 'escaped')
          j += 2
          continue
        }
        if (c === '$' || c === '`') {
          const end = scanExpansionEnd(line, j)
          if (end > 0) { text += line.slice(j, end); j = end; continue }
        }
        text += c
        j++
      }
      if (j >= line.length) throw new ParseError('Unterminated double quote')
      flushDouble()
      if (!sawAny) push('', 'double')
      i = j + 1
      continue
    }

    if (char === '$' || char === '`') {
      const end = scanExpansionEnd(line, i)
      if (end > 0) {
        push(line.slice(i, end), 'unquoted')
        i = end
        continue
      }
      if (char === '`') throw new ParseError('Unterminated backquote')
    }

    push(char, 'unquoted')
    i++
  }

  return { parts, end: i }
}

const isWordBoundary = (line: string, i: number) => {
  const c = line[i] as string
  return /\s/.test(c) || c === ';' || c === '&' || c === '|' || c === '<' || c === '>'
}

/**
 * Index of the `)` closing the `(` at `open`, skipping quoted text and nested parentheses, or -1.
 */
function scanProcessSubstitution(line: string, open: number): number {
  let depth = 0
  for (let i = open; i < line.length; i++) {
    const c = line[i] as string
    if (c === '\\') { i++; continue }
    if (c === "'") { const end = line.indexOf("'", i + 1); if (end === -1) return -1; i = end; continue }
    if (c === '"') {
      for (i++; i < line.length && line[i] !== '"'; i++) if (line[i] === '\\') i++
      continue
    }
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i
  }
  return -1
}

/** Concatenated text of a word's parts: what the word says once quotes are removed. */
export function partsText(parts: WordPart[]): string {
  return parts.map(p => p.text).join('')
}

/**
 * Finds the end of a `[[ ... ]]` starting at `start` (which points at `[[`): the index just past
 * the closing `]]`, which must itself stand as a word. Returns -1 if it never closes.
 */
function scanConditionalEnd(line: string, start: number): number {
  let i = start + 2
  while (i < line.length) {
    if (/\s/.test(line[i] as string)) {
      i++
      if (line.startsWith(']]', i) && (i + 2 >= line.length || /[\s;&|)]/.test(line[i + 2] as string))) return i + 2
      continue
    }
    const { end } = readWord(line, i, j => /\s/.test(line[j] as string))
    i = end === i ? i + 1 : end
  }
  return -1
}

/**
 * Split a line into words, operators, and redirection tokens, respecting quotes, escapes and
 * expansions. Quoted content is never mistaken for an operator. An unquoted `#` at the start of a
 * word begins a comment that runs to the end of the line.
 */
export function tokenize(line: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const atCommandStart = () => {
    const last = tokens[tokens.length - 1]
    return !last || (last.kind === 'operator') || (last.kind === 'word' && last.value === '!' && tokens.length === 1)
  }

  while (i < line.length) {
    const char = line[i] as string

    if (/\s/.test(char)) { i++; continue }
    if (char === '#') break

    // [[ ... ]] in command position is one compound token: its && || < > ( ) are its own.
    if (atCommandStart() && line.startsWith('[[', i) && (i + 2 >= line.length || /\s/.test(line[i + 2] as string))) {
      const end = scanConditionalEnd(line, i)
      if (end === -1) throw new ParseError("Unterminated '[[': expected ']]'")
      tokens.push({ kind: 'conditional', value: line.slice(i + 2, end - 2).trim() })
      i = end
      continue
    }

    // Process substitution: `<(cmd)` / `>(cmd)` where a word can begin. It is one word, so `cat <(a)` is
    // a command with an argument, while `cat < (a)` stays a redirection followed by a syntax error.
    if ((char === '<' || char === '>') && line[i + 1] === '(' && (i === 0 || /[\s<>|&;(]/.test(line[i - 1] as string))) {
      const close = scanProcessSubstitution(line, i + 1)
      if (close === -1) throw new ParseError(`Unterminated process substitution: expected ')'`)
      const source = line.slice(i, close + 1)
      const part: WordPart = { text: source, quoting: 'unquoted', procSub: { direction: char, command: line.slice(i + 2, close) } }
      // Glued to more word text (`<(a)b`) is not a form worth supporting; the tail is its own word.
      tokens.push({ kind: 'word', value: source, quoted: false, parts: [part] })
      i = close + 1
      continue
    }

    // Redirections: [n]<<< [n]<< [n]>> [n]>& [n]>| [n]> [n]<
    // `>|` is `>` with `set -C` (noclobber) explicitly overridden, so it has to be its own operator
    // rather than a `>` followed by a word starting with `|`.
    const fdMatch = /^(\d*)(<<<|<<|>>|>&|>\||>|<)/.exec(line.slice(i))
    if (fdMatch) {
      const [full, fdStr, op] = fdMatch
      tokens.push({ kind: 'redirect', value: op as string, fd: fdStr ? Number(fdStr) : undefined })
      i += (full as string).length
      continue
    }

    // Operators: && || ; & |  (checked longest-first so && doesn't split into two &)
    const opMatch = OPERATORS.find(op => line.startsWith(op, i))
    if (opMatch) {
      tokens.push({ kind: 'operator', value: opMatch })
      i += opMatch.length
      continue
    }

    const { parts, end } = readWord(line, i, j => isWordBoundary(line, j))
    // A digit-only word glued to a redirection (`2>`) was handled above; anything else is a word.
    const value = partsText(parts)
    tokens.push({ kind: 'word', value, quoted: parts.every(p => p.quoting !== 'unquoted'), parts })
    i = end
  }

  return tokens
}

class Parser {
  private pos = 0
  constructor(private tokens: Token[]) {}

  private peek(): Token | undefined { return this.tokens[this.pos] }
  private advance(): Token | undefined { return this.tokens[this.pos++] }
  private atEnd(): boolean { return this.pos >= this.tokens.length }

  parseScript(): Script {
    const stages: ScriptStage[] = []
    while (!this.atEnd()) {
      const pipeline = this.parsePipeline()
      const next = this.peek()
      if (next?.kind === 'operator' && (next.value === ';' || next.value === '&' || next.value === '&&' || next.value === '||')) {
        this.advance()
        stages.push({ pipeline, operator: next.value as ScriptOperator })
        if (this.atEnd()) break
      } else {
        stages.push({ pipeline, operator: null })
        break
      }
    }
    return { type: 'script', stages }
  }

  private parsePipeline(): Pipeline {
    let negated = false
    if (this.peek()?.kind === 'word' && this.peek()?.value === '!' && !this.peek()?.quoted) {
      negated = true
      this.advance()
    }

    const commands: Command[] = [this.parseCommand()]
    while (this.peek()?.kind === 'operator' && this.peek()?.value === '|') {
      this.advance()
      commands.push(this.parseCommand())
    }
    return { type: 'pipeline', commands, negated }
  }

  private parseCommand(): Command {
    const words: string[] = []
    const wordsQuoted: boolean[] = []
    const wordParts: WordPart[][] = []
    const redirections: Redirection[] = []
    let conditional: string | undefined

    if (this.peek()?.kind === 'conditional') conditional = (this.advance() as Token).value

    while (!this.atEnd()) {
      const token = this.peek() as Token
      if (token.kind === 'operator') break
      if (token.kind === 'conditional') throw new ParseError("Unexpected '[['")

      if (token.kind === 'redirect') {
        this.advance()
        const targetToken = this.advance()
        if (!targetToken || targetToken.kind !== 'word') {
          throw new ParseError(`Expected a target after ${token.value}`)
        }

        redirections.push(this.buildRedirection(token, targetToken))
        continue
      }

      if (conditional !== undefined) throw new ParseError(`Unexpected word after ']]': ${token.value}`)

      this.advance()
      words.push(token.value)
      wordsQuoted.push(token.quoted ?? false)
      wordParts.push(token.parts ?? [{ text: token.value, quoting: token.quoted ? 'single' : 'unquoted' }])
    }

    if (words.length === 0 && redirections.length === 0 && conditional === undefined) {
      throw new ParseError('Expected a command')
    }

    return { type: 'command', words, wordsQuoted, wordParts, redirections, ...(conditional !== undefined ? { conditional } : {}) }
  }

  /** {@link buildRedirection}, reachable from {@link parseRedirections} for a bare redirection run. */
  redirectionFrom(token: Token, targetToken: Token): Redirection {
    return this.buildRedirection(token, targetToken)
  }

  private buildRedirection(token: Token, targetToken: Token): Redirection {
    const defaultFd = token.value === '<' || token.value === '<<' || token.value === '<<<' ? 0 : 1
    const fd = token.fd ?? defaultFd
    const target = targetToken.value

    if (token.value === '>&') {
      const targetIsFd = /^\d+$/.test(target)
      return targetIsFd ? { type: '>&', fd, target, targetIsFd } : { type: '>&', fd, target, targetParts: targetToken.parts, targetIsFd }
    }

    if (token.value === '<<') {
      const heredoc = target.startsWith(HEREDOC_MARK) ? decodeHeredoc(target) : { body: '', expand: false }
      return { type: '<<', fd, target: heredoc.body, heredoc }
    }

    return { type: token.value as RedirectionType, fd, target, targetParts: targetToken.parts }
  }
}

/** Parse a fully preprocessed shell line into a Script AST. */
export function parseScript(line: string): Script {
  const tokens = tokenize(line)
  return new Parser(tokens).parseScript()
}

/**
 * Parses a bare run of redirections, such as the `< input.txt` after a compound statement's closing keyword. Empty
 * text gives an empty array; anything else throws `ParseError`.
 */
export function parseRedirections(text: string): Redirection[] {
  const trimmed = text.trim()
  if (trimmed === '') return []

  const tokens = tokenize(trimmed)
  const redirections: Redirection[] = []
  const parser = new Parser(tokens)

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as Token
    if (token.kind !== 'redirect') throw new ParseError(`Expected a redirection, got: ${token.value}`)
    const target = tokens[++i]
    if (!target || target.kind !== 'word') throw new ParseError(`Expected a target after '${token.value}'`)
    redirections.push(parser.redirectionFrom(token, target))
  }

  return redirections
}

// ---------------------------------------------------------------------------------------------
// Heredocs
// ---------------------------------------------------------------------------------------------

function encodeHeredoc(heredoc: Heredoc): string {
  const bytes = new TextEncoder().encode(JSON.stringify(heredoc))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return HEREDOC_MARK + btoa(binary)
}

function decodeHeredoc(token: string): Heredoc {
  const binary = atob(token.slice(HEREDOC_MARK.length))
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes)) as Heredoc
}

interface HeredocOperator {
  /** Where `<<` starts and where the delimiter word ends, in the line */
  start: number
  end: number
  delimiter: string
  /** `<<-`: strip leading tabs from body lines and the terminator */
  stripTabs: boolean
  /** Whether any part of the delimiter was quoted, which turns off expansion of the body */
  quoted: boolean
}

/** Every `<<`/`<<-` heredoc operator on one physical line, left to right, skipping quoted text. */
function findHeredocOperators(line: string): HeredocOperator[] {
  const found: HeredocOperator[] = []
  let i = 0
  while (i < line.length) {
    const c = line[i] as string
    if (c === '\\') { i += 2; continue }
    if (c === "'") { const end = line.indexOf("'", i + 1); i = end === -1 ? line.length : end + 1; continue }
    if (c === '"') {
      let j = i + 1
      while (j < line.length && line[j] !== '"') j += line[j] === '\\' ? 2 : 1
      i = j + 1
      continue
    }
    if (c === '$' || c === '`') {
      const end = scanExpansionEnd(line, i)
      if (end > 0) { i = end; continue }
    }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1] as string))) break
    if (line.startsWith('<<', i) && line[i + 2] !== '<' && line[i - 1] !== '<') {
      let j = i + 2
      const stripTabs = line[j] === '-'
      if (stripTabs) j++
      while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++
      const { parts, end } = readWord(line, j, k => isWordBoundary(line, k))
      if (parts.length === 0) throw new ParseError("Expected a delimiter after '<<'")
      found.push({ start: i, end, delimiter: partsText(parts), stripTabs, quoted: parts.some(p => p.quoting !== 'unquoted') })
      i = end
      continue
    }
    i++
  }
  return found
}

/**
 * Folds every heredoc body, encoded, into its `<<` operator on the command's own line, so line-based processing never
 * sees the body. A body with no terminator runs to the end of the text.
 */
export function foldHeredocs(text: string): string {
  if (!text.includes('<<')) return text
  const lines = text.split('\n')
  const out: string[] = []

  for (let n = 0; n < lines.length; n++) {
    const startedAt = n
    let line = lines[n] as string
    const operators = line.includes('<<') ? findHeredocOperators(line) : []
    if (operators.length === 0) { out.push(line); continue }

    const encoded: string[] = []
    for (const op of operators) {
      const body: string[] = []
      while (++n < lines.length) {
        const raw = lines[n] as string
        const candidate = op.stripTabs ? raw.replace(/^\t+/, '') : raw
        if (candidate === op.delimiter) break
        body.push(candidate)
      }
      encoded.push(encodeHeredoc({ body: body.length ? body.join('\n') + '\n' : '', expand: !op.quoted }))
    }

    for (let k = operators.length - 1; k >= 0; k--) {
      const op = operators[k] as HeredocOperator
      line = line.slice(0, op.start) + '<< ' + encoded[k] + line.slice(op.end)
    }
    out.push(line)
    // The body and its terminator collapsed into the line above. Pad the gap back so the output has
    // the same number of lines as the input, which is what keeps `$LINENO` right after a heredoc.
    // `preprocessLines` drops blank lines, so the padding costs nothing else.
    for (let pad = startedAt; pad < n; pad++) out.push('')
  }

  return out.join('\n')
}

/**
 * The delimiter of the first heredoc in `text` still waiting for its terminator line, or `null`
 * if every heredoc is complete - what the interactive prompt checks to decide whether Enter should
 * run the line or ask for another (`> `).
 */
export function pendingHeredocDelimiter(text: string): string | null {
  if (!text.includes('<<')) return null
  const lines = text.split('\n')
  const pending: HeredocOperator[] = []

  for (const line of lines) {
    const waiting = pending[0]
    if (waiting) {
      const candidate = waiting.stripTabs ? line.replace(/^\t+/, '') : line
      if (candidate === waiting.delimiter) pending.shift()
      continue
    }
    try {
      pending.push(...findHeredocOperators(line))
    } catch {
      return null
    }
  }

  return pending[0]?.delimiter ?? null
}

/** Whether `line` ends inside a quoted string (single, double or `$'...'`), ignoring quotes in a trailing comment. */
export function hasOpenQuote(line: string): boolean {
  let state: '' | "'" | '"' | '$' = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string
    if (state === "'") { if (c === "'") state = '' }
    else if (state === '$') { if (c === '\\') i++; else if (c === "'") state = '' }
    else if (state === '"') { if (c === '\\') i++; else if (c === '"') state = '' }
    else if (c === '\\') i++
    else if (c === "'") state = line[i - 1] === '$' ? '$' : "'"
    else if (c === '"') state = '"'
    else if (c === '#' && (i === 0 || /[\s;|&()]/.test(line[i - 1] as string))) break
  }
  return state !== ''
}

/**
 * Removes comments from multi-line shell text: on each line, an unquoted `#` at the start of a word
 * begins a comment. Quotes, escapes and expansions are respected, so `echo "a # b"`, `a#b` and
 * `$(( 1 ))#` keep their `#`.
 */
export function stripComments(text: string): string {
  // a quoted string can run over several lines; they are handled as one so a `#` inside it is not a comment
  const groups: string[] = []
  let pending = ''
  text.split('\n').forEach((physical, index) => {
    const joined = index === 0 || pending === '' ? physical : pending + '\n' + physical
    if (hasOpenQuote(joined)) { pending = joined; return }
    pending = ''
    groups.push(joined)
  })
  if (pending) groups.push(pending)
  return groups.map(line => {
    let i = 0
    while (i < line.length) {
      const c = line[i] as string
      if (c === '\\') { i += 2; continue }
      if (c === "'") { const end = line.indexOf("'", i + 1); if (end === -1) return line; i = end + 1; continue }
      if (c === '"') {
        let j = i + 1
        while (j < line.length && line[j] !== '"') {
          if (line[j] === '\\') { j += 2; continue }
          const inner = line[j] === '$' || line[j] === '`' ? scanExpansionEnd(line, j) : -1
          j = inner > 0 ? inner : j + 1
        }
        if (j >= line.length) return line
        i = j + 1
        continue
      }
      if (c === '$' || c === '`') {
        const end = scanExpansionEnd(line, i)
        if (end > 0) { i = end; continue }
      }
      if (c === '#' && (i === 0 || /[\s;&|]/.test(line[i - 1] as string))) return line.slice(0, i).trimEnd()
      i++
    }
    return line
  }).join('\n')
}

// ---------------------------------------------------------------------------------------------
// [[ ... ]] conditional expressions
// ---------------------------------------------------------------------------------------------

export type ConditionalToken =
  | { kind: 'op', value: '&&' | '||' | '!' | '(' | ')' | '<' | '>' }
  | { kind: 'word', parts: WordPart[] }

/**
 * Splits the text between `[[` and `]]` into words and the operators special there (`&&`, `||`, `!`, `(`, `)`, `<`,
 * `>`). Words are kept whole with their quoting; the right-hand side of `=~` runs to the next whitespace.
 */
export function tokenizeConditional(text: string): ConditionalToken[] {
  const tokens: ConditionalToken[] = []
  let i = 0
  let regexNext = false

  while (i < text.length) {
    const c = text[i] as string
    if (/\s/.test(c)) { i++; continue }

    if (regexNext) {
      const { parts, end } = readWord(text, i, j => /\s/.test(text[j] as string))
      tokens.push({ kind: 'word', parts })
      i = end
      regexNext = false
      continue
    }

    if (text.startsWith('&&', i) || text.startsWith('||', i)) {
      tokens.push({ kind: 'op', value: text.slice(i, i + 2) as '&&' | '||' })
      i += 2
      continue
    }
    if (c === '(' || c === ')' || c === '<' || c === '>' || (c === '!' && (i + 1 >= text.length || /\s/.test(text[i + 1] as string)))) {
      tokens.push({ kind: 'op', value: c as '(' | ')' | '<' | '>' | '!' })
      i++
      continue
    }

    const { parts, end } = readWord(text, i, j => {
      const d = text[j] as string
      return /\s/.test(d) || d === '(' || d === ')' || d === '<' || d === '>' || text.startsWith('&&', j) || text.startsWith('||', j)
    })
    if (end === i) throw new ParseError(`Unexpected '${c}' in [[ ]]`)
    tokens.push({ kind: 'word', parts })
    if (partsText(parts) === '=~' && parts.every(p => p.quoting === 'unquoted')) regexNext = true
    i = end
  }

  return tokens
}
