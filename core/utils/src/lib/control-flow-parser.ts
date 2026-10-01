/**
 * Groups a script's lines into a tree of statements: plain lines plus `if`/`while`/`for`/`case`
 * blocks and function definitions. `shell-parser.ts` still owns everything *within* one logical
 * line (words, redirections, `;`/`&&`/`||`/`|`) -- this is the layer above it, the one that lets a
 * script span multiple lines around a keyword.
 *
 * Grammar (line-oriented; each production consumes whole lines, not characters):
 * ```
 * Statements := Statement*
 * Statement  := If | While | For | Case | Group | FunctionDef | Simple
 * If         := 'if' Line 'then' Statements ('elif' Line 'then' Statements)* ('else' Statements)? 'fi'
 * While      := 'while' Line 'do' Statements 'done'
 * For        := 'for' NAME 'in' Word* ';'? 'do' Statements 'done'
 * Case       := 'case' Word 'in' (Pattern ('|' Pattern)* ')' Statements ';;')* 'esac'
 * Group      := '{' Statements '}'
 * FunctionDef:= NAME '()' '{' Statements '}'   |   'function' NAME '{' Statements '}'
 * Simple     := <any other non-blank, non-comment line, handed to Shell.execute verbatim>
 * ```
 *
 * A block's condition/list line (the text after `if`/`while`/`elif`, or between `case` and `in`)
 * is kept as raw text -- it is a normal shell line and goes through `Shell.execute`/`parseScript`
 * unchanged, so this parser never needs to know about pipes, redirections, or substitutions.
 */

import { foldHeredocs, pendingHeredocDelimiter } from './shell-parser.js'

export interface SimpleStatement extends Positioned {
  type: 'simple'
  line: string
}

/**
 * The text after a compound statement's closing keyword, e.g. the `< input.txt` in
 * `while ...; done < input.txt`. Kept verbatim: this parser deliberately knows nothing about
 * redirections, so `Shell` hands it to `shell-parser.ts`'s `parseRedirections`.
 *
 * It is what makes `while IFS= read -r line; do ...; done < file` work -- the whole statement reads
 * from one open input, so successive `read` calls advance through it.
 */
export interface Redirected {
  redirect?: string
}

/**
 * The 1-based physical line of the script a statement came from, for `$LINENO`.
 *
 * Physical, not logical: blank lines and comments still count, several statements normalized out of
 * one compact line (`if x; then y; fi`) all report that line, and a one-line function body reports
 * the line the definition is on. Heredoc bodies are padded back to their original height by
 * `foldHeredocs` so a statement after one is not shifted.
 */
export interface Positioned {
  lineNumber?: number
}

export interface IfStatement extends Redirected, Positioned {
  type: 'if'
  branches: Array<{ condition: string, body: Statement[] }>
  elseBody: Statement[] | null
}

export interface WhileStatement extends Redirected, Positioned {
  type: 'while'
  condition: string
  body: Statement[]
  /** `until`: the body runs while the condition *fails* */
  until?: boolean
}

export interface ForStatement extends Redirected, Positioned {
  type: 'for'
  variable: string
  /**
   * The list text exactly as written, e.g. `a "b c" $rest`.
   *
   * Deliberately unparsed. This used to be a `string[]` split by a regex with the quotes stripped,
   * which meant `for f in $x` could never word-split (the quoting needed to decide that was already
   * gone) and `for f in *.txt` could never glob. `Shell.executeFor` tokenizes and expands it with the
   * same expander a command's arguments go through.
   */
  wordsText: string
  body: Statement[]
}

export interface CaseClause {
  patterns: string[]
  body: Statement[]
}

export interface CaseStatement extends Redirected, Positioned {
  type: 'case'
  word: string
  clauses: CaseClause[]
}

export interface FunctionDef extends Positioned {
  type: 'function'
  name: string
  body: Statement[]
}

/** `{ list; }`: a brace group. It runs in the current shell and can take a redirection as a whole. */
export interface GroupStatement extends Redirected, Positioned {
  type: 'group'
  body: Statement[]
}

/**
 * `( list )`: a subshell. Its variable, function and directory changes, and any `exit`, stay inside
 * it. Only the standalone form is parsed: a subshell inside a pipeline or an `&&` list is refused
 * with a message, because the stage parser has no notion of a parenthesized command.
 */
export interface SubshellStatement extends Redirected, Positioned {
  type: 'subshell'
  body: Statement[]
}

export type Statement = SimpleStatement | IfStatement | WhileStatement | ForStatement | CaseStatement | GroupStatement | SubshellStatement | FunctionDef

/**
 * A parse failure in the statement tree.
 *
 * `incomplete` distinguishes "this input is wrong" from "this input is only a prefix" -- the parser
 * ran out of lines partway through a construct, so more input would resolve it. An interactive
 * prompt uses that to decide between printing an error and asking for the next line; a script file,
 * which has no more lines coming, treats both the same. See {@link needsMoreInput}.
 */
export class ControlFlowParseError extends Error {
  readonly incomplete: boolean
  constructor(message: string, incomplete = false) {
    super(message)
    this.incomplete = incomplete
  }
}

/** One logical line the parser walks, and the physical line of the script it came from. */
interface SourceLine {
  text: string
  line: number
}

/**
 * Splits a script into the non-blank, non-comment logical lines the parser walks, each tagged with
 * the physical line it came from.
 *
 * Normalization happens here, per physical line, rather than over the whole script: that is what
 * lets every line `if x; then y; fi` expands into report the one line it was written on. Blank and
 * comment lines are dropped from the output but still counted, so `$LINENO` matches what an editor
 * shows.
 *
 * @param offset - Added to every number, for a nested parse (a one-line function body) whose lines
 * all belong to the enclosing definition's line.
 */
function preprocessLines(script: string, offset = 0): SourceLine[] {
  const out: SourceLine[] = []
  script.split('\n').forEach((physical, index) => {
    const segments = physical.trim().startsWith('#') ? [physical] : splitTopLevel(physical)
    for (const segment of segments) {
      for (const normalized of normalizeOneLineIfNeeded(segment).split('\n')) {
        const text = normalized.trim()
        if (text.length > 0 && !text.startsWith('#')) out.push({ text, line: offset || index + 1 })
      }
    }
  })
  return out
}

/** {@link normalizeInlineControlFlow}'s per-line rule, shared with {@link preprocessLines}. */
function normalizeOneLineIfNeeded(line: string): string {
  const trimmed = line.trim()
  if (/^case\s/.test(trimmed)) {
    const normalized = normalizeOneLineCase(trimmed)
    if (normalized) return normalized
  }
  return ONE_LINE_FUNCTION_BODY.test(trimmed) || BRACE_GROUP_OPEN.test(trimmed) || SUBSHELL_OPEN.test(trimmed) ? line : normalizeOneLine(line)
}


/** Words that open a compound command when they stand where a command could start. */
const COMPOUND_OPENERS = new Set(['if', 'while', 'until', 'for', 'case'])
/** Words after which a new command starts, so a following `if`/`while`/... opens a compound. */
const COMMAND_STARTERS = new Set(['then', 'do', 'else', 'elif', '!', 'time'])

/**
 * Splits one physical line into its top-level commands: at each `;` that is not inside quotes, a
 * `( )`, `{ }`, `$( )`, or an unfinished `if`/`while`/`until`/`for`/`case`. This is what lets
 * `f() { a; b; }; x=0; f` become `f() { a; b; }`, `x=0`, `f` instead of one unparseable line, and
 * keeps `if a; then b; fi` and `case $x in a) b;; esac` whole for the keyword-aware normalizer.
 *
 * A `#` that starts a word is a comment, so a `;` after it does not split.
 */
export function splitTopLevel(line: string): string[] {
  const segments: string[] = []
  let current = ''
  let paren = 0
  let brace = 0
  const keywords: string[] = []
  let commandStart = true
  let i = 0

  const word = () => {
    let end = i
    while (end < line.length && /[A-Za-z0-9_!]/.test(line[end] as string)) end++
    return line.slice(i, end)
  }
  const flush = () => {
    if (current.trim().length) segments.push(current.trim())
    current = ''
    commandStart = true
  }

  while (i < line.length) {
    const char = line[i] as string

    if (char === '\\' && i + 1 < line.length) { current += line.slice(i, i + 2); i += 2; commandStart = false; continue }
    if (char === "'") {
      const end = line.indexOf("'", i + 1)
      const stop = end === -1 ? line.length : end + 1
      current += line.slice(i, stop); i = stop; commandStart = false; continue
    }
    if (char === '"') {
      let j = i + 1
      while (j < line.length && line[j] !== '"') j += line[j] === '\\' && j + 1 < line.length ? 2 : 1
      const stop = Math.min(j + 1, line.length)
      current += line.slice(i, stop); i = stop; commandStart = false; continue
    }
    if (char === '#' && (i === 0 || /\s/.test(line[i - 1] as string))) { current += line.slice(i); i = line.length; continue }

    if (char === '(') { paren++; current += char; i++; commandStart = true; continue }
    if (char === ')') { paren = Math.max(0, paren - 1); current += char; i++; commandStart = false; continue }
    if (char === '{') { brace++; current += char; i++; commandStart = line[i - 2] !== '$' ; continue }
    if (char === '}') { brace = Math.max(0, brace - 1); current += char; i++; commandStart = false; continue }

    if (char === ';') {
      if (line[i + 1] === ';') { current += ';;'; i += 2; commandStart = true; continue }
      if (paren === 0 && brace === 0 && keywords.length === 0) { i++; flush(); continue }
      current += char; i++; commandStart = true; continue
    }
    if (char === '&' || char === '|') {
      const pair = line.slice(i, i + 2)
      const length = pair === '&&' || pair === '||' ? 2 : 1
      current += line.slice(i, i + length); i += length
      // `>&` and `&>` are redirections, not command separators.
      commandStart = !(char === '&' && (line[i - length - 1] === '>' || line[i] === '>'))
      continue
    }

    if (/[A-Za-z!]/.test(char) && (i === 0 || /[\s;&|({]/.test(line[i - 1] as string))) {
      const w = word()
      if (commandStart) {
        if (COMPOUND_OPENERS.has(w)) keywords.push(w)
        else if ((w === 'fi' && keywords[keywords.length - 1] === 'if')
          || (w === 'done' && ['while', 'until', 'for'].includes(keywords[keywords.length - 1] ?? ''))
          || (w === 'esac' && keywords[keywords.length - 1] === 'case')) keywords.pop()
      }
      current += w
      i += w.length
      commandStart = COMMAND_STARTERS.has(w) || (commandStart && COMPOUND_OPENERS.has(w) && false)
      continue
    }

    current += char
    i++
    if (!/\s/.test(char)) commandStart = false
  }
  flush()
  return segments
}

/**
 * One-line `case WORD in a|b) cmds;; c) cmds;; esac` as the lines the parser reads: the header, one
 * line per clause (`pattern) body ;;`), and `esac`. Anything that is not a one-line case is returned as is.
 */
function normalizeOneLineCase(segment: string): string | undefined {
  const header = /^case\s+(.*?)\s+in\s+([\s\S]*?)\s*esac\s*(.*)$/.exec(segment)
  if (!header) return undefined
  const [, subject, body, rest] = header as unknown as [string, string, string, string]
  if (rest.trim()) return undefined
  const clauses: string[] = []
  let current = ''
  let depth = 0
  for (let i = 0; i < body.length; i++) {
    const char = body[i] as string
    if (char === '\\') { current += body.slice(i, i + 2); i++; continue }
    if (char === "'" || char === '"') {
      const end = body.indexOf(char, i + 1)
      const stop = end === -1 ? body.length : end + 1
      current += body.slice(i, stop); i = stop - 1; continue
    }
    if (char === '(') depth++
    else if (char === ')') depth = Math.max(0, depth - 1)
    if (char === ';' && body[i + 1] === ';' && depth === 0) {
      if (current.trim()) clauses.push(current.trim() + ' ;;')
      current = ''
      i++
      continue
    }
    current += char
  }
  if (current.trim()) clauses.push(current.trim() + ' ;;')
  return [`case ${subject} in`, ...clauses, 'esac'].join('\n')
}

/** A line that opens a brace group: `{` followed by whitespace or the end of the line. */
const BRACE_GROUP_OPEN = /^\{(?:\s|$)/

/** A line that opens a subshell: `(` but not `((`, which is arithmetic. */
const SUBSHELL_OPEN = /^\((?!\()/

/**
 * The index of the `)` closing the `(` at `start`, skipping quotes, escapes and nested parentheses
 * (so `$(...)` inside the subshell is fine), or -1 when the line ends first.
 */
function closingParen(text: string, start: number): number {
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const char = text[i] as string
    if (char === '\\') { i++; continue }
    if (char === "'") { const end = text.indexOf("'", i + 1); if (end === -1) return -1; i = end; continue }
    if (char === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      if (j >= text.length) return -1
      i = j
      continue
    }
    if (char === '(') depth++
    else if (char === ')' && --depth === 0) return i
  }
  return -1
}

/** The index of the first `;` outside quotes, or -1. */
function firstSemicolon(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string
    if (char === '\\') { i++; continue }
    if (char === "'" || char === '"') {
      const end = text.indexOf(char, i + 1)
      if (end === -1) return -1
      i = end
      continue
    }
    if (char === ';') return i
  }
  return -1
}

/** A whole group on one physical line, `{ echo a; echo b; } > f`. Greedy, so the last `}` closes it. */
const INLINE_GROUP = /^\{\s+(.*)\}\s*(.*)$/

const KEYWORDS = new Set(['if', 'then', 'elif', 'else', 'fi', 'while', 'until', 'do', 'done', 'for', 'in', 'case', 'esac', 'function'])

class LineParser {
  private pos = 0
  constructor(private lines: SourceLine[]) {}

  private peek(): string | undefined { return this.lines[this.pos]?.text }
  private advance(): string { return (this.lines[this.pos++] as SourceLine).text }

  /**
   * Consumes the leading `then`/`do` of the next line, which is on a line of its own after its
   * header, and keeps whatever follows it there as the line's remaining text.
   *
   * `do echo hi` is one line in a script and means `do`, then `echo hi`. This used to consume the
   * whole line, so a `for` body's first command vanished without an error, and the `if`/`while`
   * forms refused the line outright.
   */
  private takeKeyword(): void {
    const line = this.lines[this.pos] as SourceLine
    const rest = line.text.trim().replace(/^\S+/, '').replace(/^\s*;?\s*/, '')
    if (rest.length === 0) { this.pos++; return }
    this.lines[this.pos] = { ...line, text: rest }
  }
  private atEnd(): boolean { return this.pos >= this.lines.length }
  /** The physical line the next statement starts on, for `$LINENO`. */
  private here(): number | undefined { return this.lines[this.pos]?.line }

  private firstWord(line: string): string {
    return (line.split(/\s+/)[0]) ?? ''
  }

  parseStatements(stopWords: string[]): Statement[] {
    const statements: Statement[] = []
    while (!this.atEnd() && !stopWords.includes(this.firstWord(this.peek() as string))) {
      statements.push(this.parsePositionedStatement())
    }
    return statements
  }

  /** {@link parseStatement}, tagged with the physical line it started on. See {@link Positioned}. */
  private parsePositionedStatement(): Statement {
    const lineNumber = this.here()
    const statement = this.parseStatement()
    if (lineNumber !== undefined) statement.lineNumber = lineNumber
    return statement
  }

  private parseStatement(): Statement {
    const line = this.peek() as string
    const keyword = this.firstWord(line)

    switch (keyword) {
      case 'if': return this.parseIf()
      case 'while': return this.parseWhile()
      case 'until': return this.parseWhile(true)
      case 'for': return this.parseFor()
      case 'case': return this.parseCase()
      case 'function': return this.parseFunctionKeywordForm()
      case '{': return this.parseGroup()
      default: {
        if (SUBSHELL_OPEN.test(line)) return this.parseSubshell()
        const inlineFn = INLINE_FUNCTION_DEF.exec(line)
        if (inlineFn) {
          const at = this.here() ?? 1
          this.advance()
          return { type: 'function', name: inlineFn[1] as string, body: parseInlineBody(inlineFn[2] as string, at) }
        }
        const fnMatch = OPEN_FUNCTION_DEF.exec(line)
        if (fnMatch) {
          this.advance()
          return this.finishFunctionBody(fnMatch[1] as string, line.trim().includes('{'), fnMatch[2])
        }
        this.advance()
        return { type: 'simple', line }
      }
    }
  }

  private restAfterKeyword(line: string, keyword: string): string {
    return line.slice(keyword.length).trim()
  }

  /** `if COND; then` / `if COND` with `then` on its own following line -- both are legal. */
  private consumeConditionThroughKeyword(openKeyword: string, throughKeyword: string): string {
    const line = this.restAfterKeyword(this.advance(), openKeyword)
    // Strip a trailing `; then` on the same line.
    const inlineMatch = new RegExp(`;?\\s*${throughKeyword}\\s*$`).exec(line)
    if (inlineMatch) return line.slice(0, inlineMatch.index).replace(/;\s*$/, '').trim()

    // Otherwise `then`/`do` must be the next line by itself (or the tail of this one via more lines --
    // scripts here are line-oriented, so a condition never itself spans multiple lines).
    if (this.firstWord(this.peek() ?? '') === throughKeyword) {
      this.takeKeyword()
      return line.trim()
    }

    throw new ControlFlowParseError(
      `Expected '${throughKeyword}' after '${openKeyword} ${line}'`,
      this.atEnd()
    )
  }

  /**
   * Consumes the line that closes a compound statement and returns whatever followed the keyword on
   * it, which is a redirection run (`done < f`) or empty. It used to be discarded silently, so
   * `done < f` parsed and then read from the terminal.
   */
  private expectKeywordLine(keyword: string): string {
    if (this.atEnd() || this.firstWord(this.peek() as string) !== keyword) {
      throw new ControlFlowParseError(
        `Expected '${keyword}', got: ${this.peek() ?? '<end of script>'}`,
        this.atEnd()
      )
    }
    return this.restAfterKeyword(this.advance(), keyword)
  }

  private parseIf(): IfStatement {
    const branches: IfStatement['branches'] = []
    const condition = this.consumeConditionThroughKeyword('if', 'then')
    branches.push({ condition, body: this.parseStatements(['elif', 'else', 'fi']) })

    while (!this.atEnd() && this.firstWord(this.peek() as string) === 'elif') {
      const elifCondition = this.consumeConditionThroughKeyword('elif', 'then')
      branches.push({ condition: elifCondition, body: this.parseStatements(['elif', 'else', 'fi']) })
    }

    let elseBody: Statement[] | null = null
    if (!this.atEnd() && this.firstWord(this.peek() as string) === 'else') {
      this.advance()
      elseBody = this.parseStatements(['fi'])
    }

    const redirect = this.expectKeywordLine('fi')
    return { type: 'if', branches, elseBody, ...(redirect ? { redirect } : {}) }
  }

  private parseWhile(until = false): WhileStatement {
    const condition = this.consumeConditionThroughKeyword(until ? 'until' : 'while', 'do')
    const body = this.parseStatements(['done'])
    const redirect = this.expectKeywordLine('done')
    return { type: 'while', condition, body, ...(until ? { until: true } : {}), ...(redirect ? { redirect } : {}) }
  }

  private parseFor(): ForStatement {
    const header = this.restAfterKeyword(this.advance(), 'for')
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s+in\s+(.*?);?\s*(do)?$/.exec(header)
    if (!match) throw new ControlFlowParseError(`Malformed for-loop header: for ${header}`)

    const [, variable, wordsPart, inlineDo] = match as unknown as [string, string, string, string | undefined]
    if (!inlineDo) {
      if (this.firstWord(this.peek() ?? '') !== 'do') {
        throw new ControlFlowParseError(`Expected 'do' after 'for ${header}'`, this.atEnd())
      }
      this.takeKeyword()
    }

    const body = this.parseStatements(['done'])
    const redirect = this.expectKeywordLine('done')
    return { type: 'for', variable, wordsText: wordsPart.trim(), body, ...(redirect ? { redirect } : {}) }
  }

  private parseGroup(): GroupStatement {
    const at = this.here() ?? 1
    const line = this.advance().trim()
    const inline = INLINE_GROUP.exec(line)
    if (inline) {
      const redirect = (inline[2] as string).trim()
      return { type: 'group', body: parseInlineBody(inline[1] as string, at), ...(redirect ? { redirect } : {}) }
    }

    // The group opens here and closes on a later line; whatever follows the brace is the body's start.
    const rest = line.replace(/^\{\s*/, '')
    if (rest) this.lines.splice(this.pos, 0, { text: rest, line: at })
    const body = this.parseStatements(['}'])
    const redirect = this.expectKeywordLine('}')
    return { type: 'group', body, ...(redirect ? { redirect } : {}) }
  }

  private parseSubshell(): SubshellStatement {
    const at = this.here() ?? 1
    const line = this.advance().trim()
    const close = closingParen(line, 0)
    if (close !== -1) {
      let rest = line.slice(close + 1).trim()
      // `(a) > f; b`: the redirection ends at the `;`, and what follows it is the next statement.
      const semicolon = firstSemicolon(rest)
      if (semicolon !== -1) {
        const sequel = rest.slice(semicolon + 1).trim()
        rest = rest.slice(0, semicolon).trim()
        if (sequel) this.lines.splice(this.pos, 0, { text: sequel, line: at })
      }
      if (rest && !/^(?:\d*[<>]|&>)/.test(rest)) {
        throw new ControlFlowParseError(`A subshell followed by "${rest.split(/\s/)[0]}" is not supported; put it on its own line`)
      }
      return { type: 'subshell', body: parseInlineBody(line.slice(1, close), at), ...(rest ? { redirect: rest } : {}) }
    }

    // The subshell opens here and closes on a later line holding only `)` (and any redirection).
    const rest = line.replace(/^\(\s*/, '')
    if (rest) this.lines.splice(this.pos, 0, { text: rest, line: at })
    const body = this.parseStatements([')'])
    const redirect = this.expectKeywordLine(')')
    return { type: 'subshell', body, ...(redirect ? { redirect } : {}) }
  }

  private parseCase(): CaseStatement {
    const header = this.restAfterKeyword(this.advance(), 'case')
    const match = /^(.*?)\s+in$/.exec(header)
    if (!match) throw new ControlFlowParseError(`Malformed case header: case ${header}`)
    const word = (match[1] as string).trim()

    const clauses: CaseClause[] = []
    while (!this.atEnd() && this.firstWord(this.peek() as string) !== 'esac') {
      const clauseHeaderLine = this.advance().trim()
      // A clause pattern header (`a|b)`) may be followed on the same line by its entire body and
      // terminator (`a) echo hi ;;`), just the terminator (`*) ;;`), or nothing at all -- the
      // common case, with the body on subsequent lines.
      const clauseMatch = /^(.*?)\)(.*)$/.exec(clauseHeaderLine)
      if (!clauseMatch) throw new ControlFlowParseError(`Malformed case pattern: ${clauseHeaderLine}`)
      const patterns = (clauseMatch[1] as string).split('|').map(p => p.trim())
      const inlineRest = (clauseMatch[2] as string).trim()

      const body: Statement[] = []

      if (inlineRest.length) {
        const inlineTerminated = /;;\s*$/.test(inlineRest)
        const inlineBody = inlineRest.replace(/;;\s*$/, '').trim()
        if (inlineBody.length) body.push({ type: 'simple', line: inlineBody })
        if (inlineTerminated) {
          clauses.push({ patterns, body })
          continue
        }
      }

      while (!this.atEnd() && !/;;\s*$/.test(this.peek() as string) && this.firstWord(this.peek() as string) !== 'esac') {
        body.push(this.parsePositionedStatement())
      }

      // `;;` may terminate the last body line inline (`echo hi ;;`) or stand alone on its own line.
      if (!this.atEnd() && /;;\s*$/.test(this.peek() as string)) {
        const line = this.advance()
        const trimmed = line.replace(/;;\s*$/, '').trim()
        if (trimmed.length) body.push({ type: 'simple', line: trimmed })
      }

      clauses.push({ patterns, body })
    }

    const redirect = this.expectKeywordLine('esac')
    return { type: 'case', word, clauses, ...(redirect ? { redirect } : {}) }
  }

  private parseFunctionKeywordForm(): FunctionDef {
    const at = this.here() ?? 1
    const header = this.restAfterKeyword(this.advance(), 'function')
    const inline = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\s*\))?\s*\{(.+)\}\s*$/.exec(header)
    if (inline) return { type: 'function', name: inline[1] as string, body: parseInlineBody(inline[2] as string, at) }
    const open = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\s*\))?\s*\{(.*)$/.exec(header)
    if (open) return this.finishFunctionBody(open[1] as string, true, open[2])
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\s*\))?\s*$/.exec(header)
    if (!match) throw new ControlFlowParseError(`Malformed function definition: function ${header}`)
    return this.finishFunctionBody(match[1] as string, false)
  }

  /**
   * Collects a function body up to its closing `}`.
   *
   * `inlineBodyStart` is whatever followed the opening brace on the header line, for a definition that
   * begins on one line and ends on a later one (`greet() { echo hi` then `}`). It is pushed back onto
   * the line stream at the current position rather than parsed separately, so it goes through exactly
   * the same `parseStatement` the rest of the body does -- a nested block opened there
   * (`greet() { if true; then`) therefore still works.
   */
  private finishFunctionBody(name: string, openBraceOnHeaderLine: boolean, inlineBodyStart?: string): FunctionDef {
    if (!openBraceOnHeaderLine) {
      if (this.firstWord(this.peek() ?? '') !== '{') {
        throw new ControlFlowParseError(`Expected '{' to open function '${name}'`, this.atEnd())
      }
      this.advance()
    }

    // Pushed back at the current position, carrying the header's own line number: a body started on
    // the header line belongs to that line.
    if (inlineBodyStart && inlineBodyStart.trim()) {
      this.lines.splice(this.pos, 0, { text: inlineBodyStart.trim(), line: this.lines[this.pos - 1]?.line ?? 1 })
    }

    const body: Statement[] = []
    while (!this.atEnd() && this.peek() !== '}') {
      body.push(this.parsePositionedStatement())
    }

    this.expectKeywordLine('}')
    return { type: 'function', name, body }
  }
}

/**
 * A whole function definition on one physical line: `f() { echo hi; }`, the form every rc file and
 * most one-liners use. The body group is greedy, so the `}` matched is the last one on the line and a
 * nested block inside the body (`f() { if x; then y; fi; }`) stays part of it.
 *
 * Without this the line matched nothing and fell through to `{ type: 'simple' }`, so the shell went
 * looking for a command literally named `f()` and reported it as not found.
 */
const INLINE_FUNCTION_DEF = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)\s*\{(.+)\}\s*$/

/**
 * `NAME()` with an opening brace whose body is not closed on this line: either the classic
 * `greet() {` with the body on following lines, or `greet() { echo hi` with the body *started* here
 * and closed later. The second form used to match nothing, so at an interactive prompt it read as a
 * complete plain command and ran immediately instead of asking for the rest.
 */
const OPEN_FUNCTION_DEF = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)\s*(?:\{(.*))?$/

/**
 * A physical line that opens a function body and puts something after the brace -- complete
 * (`f() { echo hi; }`) or not (`f() { echo hi`). {@link normalizeInlineControlFlow} hands these
 * through untouched, because its keyword splitting has no idea the keywords are inside a function
 * body and would tear `f() { if x; then y; fi; }` apart at `then` and `fi`.
 */
const ONE_LINE_FUNCTION_BODY = /^(?:function\s+)?[A-Za-z_][A-Za-z0-9_]*\s*(?:\(\s*\))?\s*\{.*\S/

/**
 * Parses a one-line function body, which is ordinary `;`-joined shell input and so goes through the
 * same normalization an interactively typed compound statement does. `foldHeredocs` is deliberately
 * not repeated: {@link parseStatements} already ran it over the whole script, so any heredoc in this
 * body is already one self-contained token.
 */
function parseInlineBody(text: string, line: number): Statement[] {
  // bash requires the `;` before the closing brace; dropping it here makes the resulting statements
  // identical to the multi-line form's rather than carrying a stray trailing separator.
  const body = text.trim().replace(/;\s*$/, '')
  return new LineParser(preprocessLines(body, line)).parseStatements([])
}

/** Reserved words this parser understands -- used by the shell to reject them as command names. */
export const CONTROL_FLOW_KEYWORDS: ReadonlySet<string> = KEYWORDS

/**
 * `then`/`do` must end a line (attached to their condition/header, per `consumeConditionThroughKeyword`),
 * and once attached, the compound "COND then"/"HEADER do" line is complete.
 */
const ATTACH_AND_CLOSE_LINE = new Set(['then', 'do'])
/** Start a new line on their own; the word itself continues to accumulate normally afterward. */
const START_NEW_LINE = new Set(['if', 'while', 'until', 'for', 'elif'])

/**
 * Close a block, so they own their line up to the next top-level `;` and whatever follows that `;`
 * starts a line of its own.
 *
 * Only up to the `;`, because a closing keyword can legitimately carry a redirection
 * (`done < input.txt`) that belongs on its line. Before this they were treated like `if`/`while` --
 * "start a new line, then keep accumulating" -- which left `done; shift 1` as a single line whose
 * first word was `done;`, so the parser never recognized the block as closed. Unreachable while the
 * only compact form was a whole statement on one line; a one-line function body made it routine.
 */
const CLOSE_LINE = new Set(['fi', 'done', 'esac'])
/** Stands alone on its own line, with nothing else -- its body starts as a fresh line after it. */
const ISOLATE_ALONE = new Set(['else'])

/**
 * Rewrites a single physical line's `;`-joined compact control flow (`if COND; then BODY; fi`, as
 * typed at an interactive prompt) into the newline-delimited form `LineParser` above actually
 * understands (it is strictly line-oriented: `then`/`do` attached to the end of a line, `else` alone
 * on its own line, bodies on the following lines). Already multi-line script text is left untouched
 * -- each of these keywords is only ever recognized right after a top-level `;` (a real statement
 * boundary), never after plain whitespace, so an ordinary argument that happens to spell a keyword
 * (`echo done`, `touch fi`) is never misread as control flow; real shells enforce the same
 * command-position restriction on these reserved words.
 */
export function normalizeInlineControlFlow(text: string): string {
  // A physical line that opens a function body with content after the brace is handed through
  // untouched. Its `;`-joined body is normalized later -- by `parseInlineBody` for a complete
  // one-liner, or by the ordinary line parser once `finishFunctionBody` pushes the started body back
  // onto the stream. Either way the keyword splitting below must not see it first: it has no idea the
  // keywords are inside a function body, and would tear `f() { if x; then y; fi; }` apart.
  //
  // Splitting per physical line changes nothing else: the loop below already flushes at every `\n`,
  // so it never carried state across one.
  return text.split('\n')
    .flatMap(line => line.trim().startsWith('#') ? [line] : splitTopLevel(line))
    .map(segment => normalizeOneLineIfNeeded(segment))
    .join('\n')
}

/** {@link normalizeInlineControlFlow} for exactly one physical line. */
function normalizeOneLine(text: string): string {
  const lines: string[] = []
  let current = ''
  let depth = 0
  let i = 0

  const flush = () => {
    const trimmed = current.trim()
    if (trimmed.length) lines.push(trimmed)
    current = ''
  }

  while (i < text.length) {
    const char = text[i] as string

    if (char === '\\' && i + 1 < text.length) {
      current += text.slice(i, i + 2)
      i += 2
      continue
    }

    if (char === "'") {
      const end = text.indexOf("'", i + 1)
      const stop = end === -1 ? text.length : end + 1
      current += text.slice(i, stop)
      i = stop
      continue
    }

    if (char === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' && j + 1 < text.length ? 2 : 1
      const stop = Math.min(j + 1, text.length)
      current += text.slice(i, stop)
      i = stop
      continue
    }

    if (char === '(') { depth++; current += char; i++; continue }
    if (char === ')') { depth = Math.max(0, depth - 1); current += char; i++; continue }
    if (char === '\n') { flush(); i++; continue }

    if (depth === 0 && char === ';') {
      if (text[i + 1] === ';') { current += ';;'; i += 2; continue }

      let j = i + 1
      while (j < text.length && /\s/.test(text[j] as string)) j++
      let k = j
      while (k < text.length && /[A-Za-z]/.test(text[k] as string)) k++
      const word = text.slice(j, k)
      const boundaryOk = !text[k] || !/[A-Za-z0-9_]/.test(text[k] as string)

      // A subshell after a `;` is a statement of its own (`a; (b; c)`), which the line parser takes.
      if (text[j] === '(' && text[j + 1] !== '(') {
        flush()
        i = j
        continue
      }

      if (boundaryOk && ISOLATE_ALONE.has(word)) {
        flush()
        lines.push(word)
        i = k
        continue
      }

      if (boundaryOk && START_NEW_LINE.has(word)) {
        flush()
        i = j
        continue
      }

      if (boundaryOk && CLOSE_LINE.has(word)) {
        flush()
        // Take the keyword and anything up to the next top-level `;` (its redirection, if it has
        // one) as one line, then carry on after that `;`.
        let end = k
        let nested = 0
        while (end < text.length) {
          const c = text[end] as string
          if (c === '\\') { end += 2; continue }
          if (c === "'" || c === '"') {
            const close = text.indexOf(c, end + 1)
            end = close === -1 ? text.length : close + 1
            continue
          }
          if (c === '(') nested++
          else if (c === ')') nested = Math.max(0, nested - 1)
          else if (c === ';' && nested === 0) break
          end++
        }
        lines.push(text.slice(j, end).trim())
        // Step over the `;` too, so what follows starts a clean line rather than one beginning with
        // a stray separator.
        i = text[end] === ';' ? end + 1 : end
        continue
      }

      if (boundaryOk && ATTACH_AND_CLOSE_LINE.has(word)) {
        current += (current.length && !/\s$/.test(current) ? ' ' : '') + word
        flush()
        i = k
        continue
      }

      current += char
      i++
      continue
    }

    current += char
    i++
  }

  flush()
  return lines.join('\n')
}

/**
 * Parse a full script into a statement tree. Blank lines and full-line comments are dropped.
 * Heredoc bodies (`foldHeredocs`) are lifted out first -- before anything else here goes
 * line-by-line -- so a body that happens to contain `if`/`do`/`;` or a blank line is never
 * mistaken for script structure; each `<<`/`<<-` becomes one self-contained encoded token on its
 * command's own line, exactly like `shell-parser.ts`'s own single-line entry points expect.
 */
export function parseStatements(script: string): Statement[] {
  const lines = preprocessLines(foldHeredocs(script))
  const parser = new LineParser(lines)
  const statements = parser.parseStatements([])
  return statements
}

/**
 * Whether `text` is only the beginning of a shell statement, so an interactive prompt should ask
 * for another line (`> `) instead of running it.
 *
 * Two ways input can be a prefix:
 * - an open heredoc, whose terminator line has not arrived yet ({@link pendingHeredocDelimiter});
 * - an open control-flow block (`if` with no `fi`, `for`/`while` with no `done`, `case` with no
 *   `esac`, a function body with no closing brace), which the statement parser reports as a
 *   {@link ControlFlowParseError} with `incomplete` set.
 *
 * A genuine syntax error -- `fi` with no `if`, a malformed `for` header -- is deliberately *not*
 * incomplete: no amount of further typing fixes it, so the prompt reports it rather than hanging in
 * a continuation the user cannot escape.
 */
export function needsMoreInput(text: string): boolean {
  if (!text.trim()) return false
  if (pendingHeredocDelimiter(text) !== null) return true

  try {
    parseStatements(text)
    return false
  } catch (error) {
    return error instanceof ControlFlowParseError && error.incomplete
  }
}
