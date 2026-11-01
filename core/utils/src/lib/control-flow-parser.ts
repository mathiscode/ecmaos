/**
 * Groups a script's lines into a tree of statements: plain lines, `if`/`while`/`for`/`case` blocks and function
 * definitions. `shell-parser.ts` parses within one logical line; this layer handles constructs that span lines.
 *
 * Grammar (line-oriented):
 * ```
 * Statements := Statement*
 * Statement  := If | While | For | Case | Group | FunctionDef | Simple
 * If         := 'if' Line 'then' Statements ('elif' Line 'then' Statements)* ('else' Statements)? 'fi'
 * While      := 'while' Line 'do' Statements 'done'
 * For        := 'for' NAME 'in' Word* ';'? 'do' Statements 'done'
 * Select     := 'select' NAME ('in' Word*)? ';'? 'do' Statements 'done'
 * ArithFor   := 'for' '((' Arith ';' Arith ';' Arith '))' ';'? 'do' Statements 'done'
 * Case       := 'case' Word 'in' (Pattern ('|' Pattern)* ')' Statements ';;')* 'esac'
 * Group      := '{' Statements '}'
 * FunctionDef:= NAME '()' '{' Statements '}'   |   'function' NAME '{' Statements '}'
 * Simple     := <any other non-blank, non-comment line, handed to Shell.execute verbatim>
 * ```
 *
 * A block's condition line is kept as raw text and goes through `Shell.execute`.
 */

import { endsInContinuation, foldHeredocs, hasOpenQuote, pendingHeredocDelimiter, scanExpansionEnd } from './shell-parser.js'

export interface SimpleStatement extends Positioned {
  type: 'simple'
  line: string
}

/**
 * The text after a compound statement's closing keyword (the `< input.txt` in `while ...; done < input.txt`), kept
 * verbatim for `parseRedirections`.
 */
export interface Redirected {
  redirect?: string
}

/**
 * The 1-based physical line of the script a statement came from, for `$LINENO`. Blank lines and comments count;
 * statements from one compact line share its line.
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

/** `for (( init; cond; step )); do ... done`: the three parts are arithmetic text, any of them may be empty. */
export interface ArithmeticForStatement extends Redirected, Positioned {
  type: 'cfor'
  init: string
  cond: string
  step: string
  body: Statement[]
}

/** `select NAME [in WORDS]; do ...; done`: a numbered menu on standard error, the choice read from standard input. */
export interface SelectStatement extends Redirected, Positioned {
  type: 'select'
  variable: string
  /** The list text as written; absent for `select NAME; do`, which offers the positional parameters. */
  wordsText?: string
  body: Statement[]
}

export interface ForStatement extends Redirected, Positioned {
  type: 'for'
  variable: string
  /** The list text exactly as written (`a "b c" $rest`), unparsed so `Shell` can expand it like command arguments. */
  wordsText: string
  body: Statement[]
}

export interface CaseClause {
  patterns: string[]
  body: Statement[]
  /** `;;` ends the case, `;&` runs the next clause's body too, `;;&` goes on testing the later patterns. */
  terminator?: ';;' | ';&' | ';;&'
}

/**
 * `a|b) body` as its patterns and what follows the `)`. The `)` that ends the patterns is the first one no
 * parenthesis opened inside them, so an extended pattern such as `@(a|b)` stays whole.
 */
function splitCaseClauseHeader(line: string): { patterns: string[], rest: string } | undefined {
  const patterns: string[] = []
  let current = ''
  let depth = 0
  let i = line.startsWith('(') ? 1 : 0
  for (; i < line.length; i++) {
    const c = line[i] as string
    if (c === '\\') { current += c + (line[++i] ?? ''); continue }
    if (c === "'" || c === '"') {
      const end = line.indexOf(c, i + 1)
      const stop = end === -1 ? line.length : end + 1
      current += line.slice(i, stop); i = stop - 1; continue
    }
    if (c === '(') depth++
    else if (c === ')') {
      if (depth === 0) { patterns.push(current.trim()); return { patterns, rest: line.slice(i + 1) } }
      depth--
    } else if (c === '|' && depth === 0) { patterns.push(current.trim()); current = ''; continue }
    current += c
  }
  return undefined
}

function terminatorOf(text: string | undefined): { terminator?: ';;' | ';&' | ';;&' } {
  return text === ';&' || text === ';;&' ? { terminator: text } : {}
}

/** A clause terminator at the end of a line. `;&` cannot be anything else outside a `case`. */
const CASE_TERMINATOR = /(;;&|;;|;&)\s*$/

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

/**
 * A pipeline with a compound command in it (`cmd | while read x; do ...; done`, `{ a; b; } | cmd`, `(a; b) &`). Plain
 * pipelines stay a {@link SimpleStatement}. A compound stage runs in a subshell.
 */
export interface PipelineStatement extends Positioned {
  type: 'pipeline'
  stages: Statement[]
  /** A trailing `&`: the whole pipeline runs as a background job */
  background?: boolean
}

/**
 * `a && b || c` where an operand is a compound command. Evaluated left to right: `&&` runs its operand when the
 * status so far is 0, `||` when it is not.
 */
export interface AndOrStatement extends Positioned {
  type: 'andor'
  first: Statement
  rest: Array<{ op: '&&' | '||', statement: Statement }>
}

export type Statement = AndOrStatement | PipelineStatement | SimpleStatement | IfStatement | WhileStatement | ForStatement | SelectStatement | ArithmeticForStatement | CaseStatement | GroupStatement | SubshellStatement | FunctionDef

/**
 * A parse failure in the statement tree. `incomplete` means the input is only a prefix and more lines would resolve
 * it (see {@link needsMoreInput}).
 */
export class ControlFlowParseError extends Error {
  readonly incomplete: boolean
  /**
   * The statements of a whole script that end on lines before the one that failed. bash reads a script a command at a
   * time, so it has run these when it finds the error; {@link parseStatements} sets it.
   */
  before?: Statement[]
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
 * Splits a script into the non-blank, non-comment logical lines the parser walks, each tagged with its physical line.
 * Normalization is per physical line.
 * @param offset - added to every line number, for a nested parse (a one-line function body)
 */
function preprocessLines(script: string, offset = 0): SourceLine[] {
  const out: SourceLine[] = []
  // A quoted string can run over several physical lines; they are joined (with a stand-in for each newline, so the
  // per-line splitting below leaves the string alone) and the newlines are put back in the finished line.
  let pending = ''
  let pendingAt = 0
  const handle = (physical: string, index: number) => {
    const segments = physical.trim().startsWith('#') ? [physical] : splitTopLevel(physical)
    for (const segment of segments) {
      for (const normalized of normalizeOneLineIfNeededLines(segment)) {
        const text = normalized.trim().replaceAll(QUOTED_NEWLINE, '\n')
        if (text.length > 0 && !text.startsWith('#')) out.push({ text, line: offset || index + 1 })
      }
    }
  }
  // a line continued by a backslash is joined to the next with neither the backslash nor the newline
  let continued = false
  script.split('\n').forEach((physical, index) => {
    const joined = pending ? pending + (continued ? '' : QUOTED_NEWLINE) + physical : physical
    const start = pending ? pendingAt : index
    continued = false
    if (hasOpenQuote(joined)) { pending = joined; pendingAt = start; return }
    if (endsInContinuation(joined)) { pending = joined.slice(0, -1); pendingAt = start; continued = true; return }
    pending = ''
    handle(joined, start)
  })
  if (pending) handle(pending, pendingAt)
  return out
}

/** Stands in for a newline inside a quoted string while a script is split into lines. */
const QUOTED_NEWLINE = '\uE000'

/** {@link normalizeOneLineIfNeeded}'s result as separate lines (a normalization can span several). */
function normalizeOneLineIfNeededLines(segment: string): string[] {
  return normalizeOneLineIfNeeded(segment).split('\n')
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
const COMPOUND_OPENERS = new Set(['if', 'while', 'until', 'for', 'select', 'case'])
/** Words after which a new command starts, so a following `if`/`while`/... opens a compound. */
const COMMAND_STARTERS = new Set(['then', 'do', 'else', 'elif', '!', 'time'])

/**
 * Splits one physical line into its top-level commands at each `;` outside quotes, `( )`, `{ }`, `$( )` and an
 * unfinished compound keyword. A `#` that starts a word begins a comment.
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
      while (j < line.length && line[j] !== '"') {
        if (line[j] === '\\' && j + 1 < line.length) { j += 2; continue }
        // an expansion inside, whose own quotes ("${x-"a"}") do not end the string
        const end = line[j] === '$' ? scanExpansionEnd(line, j, true) : -1
        j = end > 0 ? end : j + 1
      }
      const stop = Math.min(j + 1, line.length)
      current += line.slice(i, stop); i = stop; commandStart = false; continue
    }
    if (char === '$' && line[i + 1] === '{') {
      // a ${...} whole: a quote in its word is not one of the line's
      const end = scanExpansionEnd(line, i)
      if (end > 0) { current += line.slice(i, end); i = end; commandStart = false; continue }
    }
    if (char === '#' && (i === 0 || /\s/.test(line[i - 1] as string))) { current += line.slice(i); i = line.length; continue }

    if (char === '(') { paren++; current += char; i++; commandStart = true; continue }
    if (char === ')') { paren = Math.max(0, paren - 1); current += char; i++; commandStart = false; continue }
    if (char === '{') { brace++; current += char; i++; commandStart = line[i - 2] !== '$' ; continue }
    if (char === '}') { brace = Math.max(0, brace - 1); current += char; i++; commandStart = false; continue }

    if (char === ';') {
      if (line[i + 1] === ';') { const length = line[i + 2] === '&' && line[i + 3] !== '&' ? 3 : 2; current += line.slice(i, i + length); i += length; commandStart = true; continue }
      if (line[i + 1] === '&' && line[i + 2] !== '&') { current += ';&'; i += 2; commandStart = true; continue }
      if (paren === 0 && brace === 0 && keywords.length === 0) { i++; flush(); continue }
      current += char; i++; commandStart = true; continue
    }
    if (char === '&' || char === '|') {
      const pair = line.slice(i, i + 2)
      const length = pair === '&&' || pair === '||' ? 2 : 1
      current += line.slice(i, i + length); i += length
      // `>&`, `<&` and `&>` are redirections, not command separators.
      commandStart = !(char === '&' && (line[i - length - 1] === '>' || line[i - length - 1] === '<' || line[i] === '>'))
      continue
    }

    if (/[A-Za-z!]/.test(char) && (i === 0 || /[\s;&|({]/.test(line[i - 1] as string))) {
      const w = word()
      if (commandStart) {
        if (COMPOUND_OPENERS.has(w)) keywords.push(w)
        else if ((w === 'fi' && keywords[keywords.length - 1] === 'if')
          || (w === 'done' && ['while', 'until', 'for', 'select'].includes(keywords[keywords.length - 1] ?? ''))
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
    if (char === ';' && depth === 0 && (body[i + 1] === ';' || body[i + 1] === '&')) {
      const terminator = body[i + 1] === '&' ? ';&' : body[i + 2] === '&' ? ';;&' : ';;'
      if (current.trim()) clauses.push(current.trim() + ' ' + terminator)
      current = ''
      i += terminator.length - 1
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

/** What may follow a compound command's closing keyword on its line: a redirection, a pipe, a list operator or `&` */
const COMPOUND_TAIL = /^(?:\d*[<>]|&>|&&|\||&(?![&>]))/

/** Reserved words that close or continue a compound command, and so cannot start one: a command there is a syntax error */
const CLOSING_WORDS = new Set(['then', 'elif', 'else', 'fi', 'do', 'done', 'esac', '}', ')'])

/** bash's report of a word where the grammar has no place for it */
const unexpectedToken = (word: string) => new ControlFlowParseError(`syntax error near unexpected token \`${word}'`)

/**
 * The index of the `)` closing the `(` at `start`, skipping quotes, escapes and nested parentheses
 * (so `$(...)` inside the subshell is fine), or -1 when the line ends first.
 */
export function closingParen(text: string, start: number): number {
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

/** A whole group on one physical line, `{ echo a; echo b; } > f`. Greedy, so the last `}` closes it. */
/**
 * The index of the `}` closing the `{` that opens `text`, or -1 when the line ends first. Skips
 * quotes and `${...}`, and counts nested groups, so `{ a; } | { b; }` closes at the first `}`.
 */
function closingBrace(text: string): number {
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string
    if (char === '\\') { i++; continue }
    if (char === "'") { const end = text.indexOf("'", i + 1); if (end === -1) return -1; i = end; continue }
    if (char === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      i = j
      continue
    }
    if (char === '{' && text[i - 1] !== '$' && /\s/.test(text[i + 1] ?? '')) depth++
    else if (char === '}' && (i === 0 || /[\s;]/.test(text[i - 1] as string)) && /^(?:$|[\s;|&<>)])/.test(text.slice(i + 1, i + 2))) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

const KEYWORDS = new Set(['if', 'then', 'elif', 'else', 'fi', 'while', 'until', 'do', 'done', 'for', 'select', 'in', 'case', 'esac', 'function'])

/**
 * Indices of the `|` in `text` that join pipeline stages: not `||`, and not inside quotes, `( )`, `{ }` or `$( )`.
 */
function pipeIndexes(text: string): number[] {
  const found: number[] = []
  let paren = 0
  let brace = 0
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string
    if (char === '\\') { i++; continue }
    if (char === "'") { const end = text.indexOf("'", i + 1); if (end === -1) break; i = end; continue }
    if (char === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      i = j
      continue
    }
    if (char === '(') paren++
    else if (char === ')') paren = Math.max(0, paren - 1)
    else if (char === '{' && text[i - 1] !== '$' && /\s|$/.test(text[i + 1] ?? '')) brace++
    else if (char === '}' && brace > 0 && (i === 0 || /[\s;]/.test(text[i - 1] as string))) brace--
    else if (char === '|' && paren === 0 && brace === 0) {
      if (text[i + 1] === '|') { i++; continue }
      found.push(i)
    }
  }
  return found
}

/** Indices of the `&&` and `||` in `text` outside quotes, `( )`, `{ }` and `$( )`. */
function andOrIndexes(text: string): Array<{ index: number, op: '&&' | '||' }> {
  const found: Array<{ index: number, op: '&&' | '||' }> = []
  let paren = 0
  let brace = 0
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string
    if (char === '\\') { i++; continue }
    if (char === "'") { const end = text.indexOf("'", i + 1); if (end === -1) break; i = end; continue }
    if (char === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      i = j
      continue
    }
    if (char === '(') paren++
    else if (char === ')') paren = Math.max(0, paren - 1)
    else if (char === '{' && text[i - 1] !== '$' && /\s|$/.test(text[i + 1] ?? '')) brace++
    else if (char === '}' && brace > 0 && (i === 0 || /[\s;]/.test(text[i - 1] as string))) brace--
    else if ((char === '&' || char === '|') && text[i + 1] === char && paren === 0 && brace === 0) {
      found.push({ index: i, op: char === '&' ? '&&' : '||' })
      i++
    }
  }
  return found
}

/** Whether `text` starts a compound command, so a `|` before it joins a compound stage. */
function startsCompound(text: string): boolean {
  return /^(?:if|while|until|for|case)(?:\s|$)/.test(text) || BRACE_GROUP_OPEN.test(text) || SUBSHELL_OPEN.test(text)
}

/**
 * The index of the `|` in `text` that starts a compound stage: the first one followed by a compound opener, or a
 * trailing `|` that continues on the next line.
 */
function compoundPipeIndex(text: string): number | undefined {
  const pipes = pipeIndexes(text)
  const trailing = /\|\s*$/.test(text) && !/\|\|\s*$/.test(text)
  return pipes.find(index => {
    const tail = text.slice(index + 1).trim()
    return (trailing && index === pipes[pipes.length - 1] && tail === '') || startsCompound(tail)
  })
}

/**
 * The `&&` and `||` of `text` that separate the operands of a list. When a `|` starts a compound stage, only the ones
 * before it count: what follows it belongs to that stage, and an `&&` in a loop body there (`a | while ...; do b &&
 * c; done`) is the body's own.
 */
function listOperators(text: string): Array<{ index: number, op: '&&' | '||' }> {
  const pipe = compoundPipeIndex(text)
  return andOrIndexes(text).filter(({ index }) => pipe === undefined || index < pipe)
}

/**
 * A plain line that is part of a pipeline with a compound stage in it (see {@link compoundPipeIndex}). `head` is what
 * stays here and `rest` is the remainder, empty when it is on the following lines.
 */
function splitSimplePipe(line: string): { head: string, rest: string } | undefined {
  const index = compoundPipeIndex(line)
  if (index === undefined) return undefined
  return { head: line.slice(0, index).trim(), rest: line.slice(index + 1).trim() }
}

/**
 * What follows a compound statement's closing keyword when it is more than redirections: a `|` that
 * continues the pipeline, and a trailing `&` that backgrounds it. `redirect` keeps what came before.
 */
function splitCompoundTail(text: string): { redirect: string, rest?: string, background: boolean, after?: string } | undefined {
  const pipes = pipeIndexes(text)
  if (pipes.length > 0) {
    const index = pipes[0] as number
    return { redirect: text.slice(0, index).trim(), rest: text.slice(index + 1).trim(), background: false }
  }
  // A lone `&`: not `&&`, and not part of `>&`, `<&`, `&>` or `2>&1`.
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '&') continue
    if (text[i + 1] === '&') { i++; continue }
    if (text[i + 1] === '>' || text[i - 1] === '>' || text[i - 1] === '<') continue
    return { redirect: text.slice(0, i).trim(), background: true, after: text.slice(i + 1).trim() }
  }
  return undefined
}

class LineParser {
  private pos = 0
  constructor(private lines: SourceLine[]) {}

  private peek(): string | undefined { return this.lines[this.pos]?.text }
  private advance(): string { return (this.lines[this.pos++] as SourceLine).text }

  /** Consumes the leading `then`/`do` of the next line and keeps whatever follows it as that line's text. */
  private takeKeyword(): void {
    const line = this.lines[this.pos] as SourceLine
    const rest = line.text.trim().replace(/^\S+/, '').replace(/^\s*;?\s*/, '')
    if (rest.length === 0) { this.pos++; return }
    this.lines[this.pos] = { ...line, text: rest }
  }
  private atEnd(): boolean { return this.pos >= this.lines.length }

  /**
   * Puts text that followed an opening `{` or `(` back in front of the remaining lines. It never went
   * through the per-line normalization, so `( while read x; do ...; done` would otherwise stay one
   * line the parser cannot read.
   */
  private pushBack(text: string, line: number): void {
    // a newline in the text is inside a quoted string (lines were joined across those), so it must survive the split
    const pieces = splitTopLevel(text.replaceAll('\n', QUOTED_NEWLINE)).flatMap(segment => normalizeOneLineIfNeeded(segment).split('\n'))
      .map(piece => piece.trim().replaceAll(QUOTED_NEWLINE, '\n')).filter(piece => piece.length > 0)
    this.lines.splice(this.pos, 0, ...pieces.map(piece => ({ text: piece, line })))
  }
  /** The physical line the next statement starts on, for `$LINENO`. */
  private here(): number | undefined { return this.lines[this.pos]?.line }

  private firstWord(line: string): string {
    return (line.split(/\s+/)[0]) ?? ''
  }

  /** The statements of a whole script; a failure carries the ones that ended before it, as `before` */
  parseScript(): Statement[] {
    const statements: Statement[] = []
    while (!this.atEnd()) {
      const start = this.here()
      try {
        statements.push(this.parsePositionedStatement())
      } catch (error) {
        if (error instanceof ControlFlowParseError) {
          error.before = statements.filter(statement => start === undefined || statement.lineNumber === undefined || statement.lineNumber < start)
        }
        throw error
      }
    }
    return statements
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
    const statement = this.finishPipeline(this.parseStatement(), lineNumber)
    if (lineNumber !== undefined) statement.lineNumber = lineNumber
    return statement
  }

  /**
   * Turns a statement that continues into a pipeline (`a | while ...`, `done | sort`, `(x) &`) into a {@link
   * PipelineStatement}, parsing the remaining stages. Other statements are returned unchanged.
   */
  private finishPipeline(first: Statement, lineNumber: number | undefined): Statement {
    let rest: string | undefined
    let background = false

    if (first.type === 'simple') {
      // `x && for ...` / `x || { ...; }`: the first operator in front of a compound command. `x && a | while ...`:
      // the last operator before the pipeline with the compound stage, which is that operator's operand.
      const line = first.line
      const operators = listOperators(line)
      const lead = operators.find(({ index }) => startsCompound(line.slice(index + 2).trim()))
        ?? (compoundPipeIndex(line) === undefined ? undefined : operators[operators.length - 1])
      if (lead) return this.finishAndOr({ type: 'simple', line: line.slice(0, lead.index).trim() }, lead.op, line.slice(lead.index + 2).trim(), lineNumber)
      const split = splitSimplePipe(line)
      if (!split) return first
      first = { type: 'simple', line: split.head }
      rest = split.rest
    } else if (first.type !== 'function' && first.type !== 'pipeline' && first.type !== 'andor' && first.redirect) {
      // `fi && b`, `done | sort && x`: a list continuing after the closing keyword. What comes before the
      // operator (a pipeline) is finished first and becomes the list's first operand.
      const lead = andOrIndexes(first.redirect)[0]
      if (lead) {
        const tail = first.redirect.slice(lead.index + 2).trim()
        first.redirect = first.redirect.slice(0, lead.index).trim() || undefined
        const left = first.redirect && pipeIndexes(first.redirect).length > 0 ? this.finishPipeline(first, lineNumber) : first
        return this.finishAndOr(left, lead.op, tail, lineNumber)
      }
      const split = splitCompoundTail(first.redirect)
      if (!split) return first
      first.redirect = split.redirect || undefined
      rest = split.rest
      background = split.background
      // `(a) & b`: what follows the `&` is the next statement.
      if (split.after) this.pushBack(split.after, lineNumber ?? 1)
    } else {
      return first
    }

    const stages: Statement[] = [first]
    if (rest !== undefined) {
      if (rest.trim()) this.pushBack(rest.trim(), lineNumber ?? 1)
      if (this.atEnd()) throw new ControlFlowParseError('Expected a command after |', true)
      const next = this.parsePositionedStatement()
      if (next.type === 'function') throw new ControlFlowParseError('A function definition cannot be a pipeline stage')
      // `a | while ...; done && b`: the list after the last stage takes the whole pipeline as its first operand
      const list = next.type === 'andor' ? next : undefined
      const stage = list ? list.first : next
      if (stage.type === 'pipeline') { stages.push(...stage.stages); background = Boolean(stage.background) } else stages.push(stage)
      if (list) return { type: 'andor', first: { type: 'pipeline', stages }, rest: list.rest }
    }
    return { type: 'pipeline', stages, ...(background ? { background: true } : {}) }
  }

  /**
   * Builds the list `first op <tail>...`. A plain operand is taken up to the next `&&`/`||`; one that opens a
   * compound command is parsed as the next statement, and the list that follows is flattened in.
   */
  private finishAndOr(first: Statement, op: '&&' | '||', tail: string, lineNumber: number | undefined): Statement {
    const rest: AndOrStatement['rest'] = []
    let currentOp = op
    let text = tail
    for (;;) {
      if (text === '') {
        // `a &&` at the end of a line: the operand is on the next one
        if (this.atEnd()) throw new ControlFlowParseError(`Expected a command after ${currentOp}`, true)
        const next = this.parsePositionedStatement()
        if (next.type === 'andor') { rest.push({ op: currentOp, statement: next.first }, ...next.rest) } else rest.push({ op: currentOp, statement: next })
        break
      }
      const more = listOperators(text)
      // a compound command, or a pipeline with a compound stage (`a | while ...`), is parsed as the next statement
      if (startsCompound(text) || (more.length === 0 && compoundPipeIndex(text) !== undefined)) {
        this.pushBack(text, lineNumber ?? 1)
        const next = this.parsePositionedStatement()
        if (next.type === 'andor') rest.push({ op: currentOp, statement: next.first }, ...next.rest)
        else rest.push({ op: currentOp, statement: next })
        break
      }
      const stop = more.find(({ index }) => startsCompound(text.slice(index + 2).trim())) ?? more[0]
      if (!stop) { rest.push({ op: currentOp, statement: { type: 'simple', line: text } }); break }
      rest.push({ op: currentOp, statement: { type: 'simple', line: text.slice(0, stop.index).trim() } })
      currentOp = stop.op
      text = text.slice(stop.index + 2).trim()
    }
    return { type: 'andor', first, rest }
  }

  private parseStatement(): Statement {
    const line = this.peek() as string
    const keyword = this.firstWord(line)

    switch (keyword) {
      case 'if': return this.parseIf()
      case 'while': return this.parseWhile()
      case 'until': return this.parseWhile(true)
      case 'for': return this.parseFor()
      case 'select': return this.parseSelect()
      case 'case': return this.parseCase()
      case 'function': return this.parseFunctionKeywordForm()
      case '{': return this.parseGroup()
      default: {
        if (SUBSHELL_OPEN.test(line)) return this.parseSubshell()
        const header = FUNCTION_HEADER.exec(line)
        const inlineFn = header && this.inlineFunction(header[1] as string, header[2] as string)
        if (inlineFn) return inlineFn
        const fnMatch = OPEN_FUNCTION_DEF.exec(line)
        if (fnMatch) {
          this.advance()
          return this.finishFunctionBody(fnMatch[1] as string, line.trim().includes('{'), fnMatch[2])
        }
        if (CLOSING_WORDS.has(keyword)) throw unexpectedToken(keyword)
        this.advance()
        return { type: 'simple', line }
      }
    }
  }

  private restAfterKeyword(line: string, keyword: string): string {
    return line.slice(keyword.length).trim()
  }

  /** `if COND; then` / `if COND` with `then` on its own following line - both are legal. */
  private consumeConditionThroughKeyword(openKeyword: string, throughKeyword: string): string {
    const line = this.restAfterKeyword(this.advance(), openKeyword)
    // Strip a trailing `; then` on the same line.
    const inlineMatch = new RegExp(`;?\\s*${throughKeyword}\\s*$`).exec(line)
    if (inlineMatch) return line.slice(0, inlineMatch.index).replace(/;\s*$/, '').trim()

    // Otherwise `then`/`do` must be the next line by itself (or the tail of this one via more lines -
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
   * it: a redirection run (`done < f`) or empty.
   */
  private expectKeywordLine(keyword: string): string {
    if (this.atEnd() || this.firstWord(this.peek() as string) !== keyword) {
      throw new ControlFlowParseError(
        `Expected '${keyword}', got: ${this.peek() ?? '<end of script>'}`,
        this.atEnd()
      )
    }
    const at = this.here() ?? 1
    return this.compoundTail(this.restAfterKeyword(this.advance(), keyword), at)
  }

  /**
   * What followed a compound command's closing keyword or brace: a redirection or operator stays with it, a closing
   * word (`(a) fi`, `{ b; } done`) goes back to close what encloses it, and anything else is a syntax error.
   */
  private compoundTail(rest: string, at: number): string {
    if (!rest || COMPOUND_TAIL.test(rest)) return rest
    const word = this.firstWord(rest)
    if (!CLOSING_WORDS.has(word)) throw unexpectedToken(word)
    this.pushBack(rest, at)
    return ''
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

  private parseFor(): ForStatement | ArithmeticForStatement {
    const header = this.restAfterKeyword(this.advance(), 'for')
    const arithmetic = /^\(\(\s*(.*?)\s*\)\)\s*;?\s*(do)?$/.exec(header)
    if (arithmetic) {
      const parts = (arithmetic[1] as string).split(';').map(part => part.trim())
      if (parts.length !== 3) throw new ControlFlowParseError(`Malformed for-loop header: for ${header}`)
      if (!arithmetic[2]) {
        if (this.firstWord(this.peek() ?? '') !== 'do') {
          throw new ControlFlowParseError(`Expected 'do' after 'for ${header}'`, this.atEnd())
        }
        this.takeKeyword()
      }
      const body = this.parseStatements(['done'])
      const redirect = this.expectKeywordLine('done')
      return { type: 'cfor', init: parts[0] as string, cond: parts[1] as string, step: parts[2] as string, body, ...(redirect ? { redirect } : {}) }
    }
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

  private parseSelect(): SelectStatement {
    const header = this.restAfterKeyword(this.advance(), 'select')
    const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:\s+in\s+(.*?))?\s*;?\s*((?<![^\s;])do)?$/.exec(header)
    if (!match) throw new ControlFlowParseError(`Malformed select header: select ${header}`)

    const [, variable, wordsPart, inlineDo] = match as unknown as [string, string, string | undefined, string | undefined]
    if (!inlineDo) {
      if (this.firstWord(this.peek() ?? '') !== 'do') {
        throw new ControlFlowParseError(`Expected 'do' after 'select ${header}'`, this.atEnd())
      }
      this.takeKeyword()
    }

    const body = this.parseStatements(['done'])
    const redirect = this.expectKeywordLine('done')
    return { type: 'select', variable, ...(wordsPart === undefined ? {} : { wordsText: wordsPart.trim() }), body, ...(redirect ? { redirect } : {}) }
  }

  private parseGroup(): GroupStatement {
    const at = this.here() ?? 1
    const line = this.advance().trim()
    const close = /^\{\s/.test(line) ? closingBrace(line) : -1
    if (close !== -1) {
      const redirect = this.compoundTail(line.slice(close + 1).trim(), at)
      return { type: 'group', body: parseInlineBody(line.slice(1, close), at), ...(redirect ? { redirect } : {}) }
    }

    // The group opens here and closes on a later line; whatever follows the brace is the body's start.
    const rest = line.replace(/^\{\s*/, '')
    if (rest) this.pushBack(rest, at)
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
      // Split the way a line is: a `;` inside `| while ...; do ...; done` belongs to that loop.
      const pieces = splitTopLevel(rest)
      if (pieces.length > 1) {
        rest = pieces[0] as string
        for (const piece of pieces.slice(1).reverse()) this.pushBack(piece, at)
      }
      rest = this.compoundTail(rest, at)
      return { type: 'subshell', body: parseInlineBody(line.slice(1, close), at), ...(rest ? { redirect: rest } : {}) }
    }

    // The subshell opens here and closes on a later line holding only `)` (and any redirection).
    const rest = line.replace(/^\(\s*/, '')
    if (rest) this.pushBack(rest, at)
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
      // terminator (`a) echo hi ;;`), just the terminator (`*) ;;`), or nothing at all - the
      // common case, with the body on subsequent lines.
      const clauseMatch = splitCaseClauseHeader(clauseHeaderLine)
      if (!clauseMatch) throw new ControlFlowParseError(`Malformed case pattern: ${clauseHeaderLine}`)
      const patterns = clauseMatch.patterns
      const inlineRest = clauseMatch.rest.trim()

      const body: Statement[] = []

      if (inlineRest.length) {
        const inline = CASE_TERMINATOR.exec(inlineRest)
        const inlineBody = inlineRest.replace(CASE_TERMINATOR, '').trim()
        if (inlineBody.length) body.push({ type: 'simple', line: inlineBody })
        if (inline) {
          clauses.push({ patterns, body, ...terminatorOf(inline[1]) })
          continue
        }
      }

      while (!this.atEnd() && !CASE_TERMINATOR.test(this.peek() as string) && this.firstWord(this.peek() as string) !== 'esac') {
        body.push(this.parsePositionedStatement())
      }

      // the terminator may end the last body line inline (`echo hi ;;`) or stand alone on its own line
      let terminator: ReturnType<typeof terminatorOf> = {}
      if (!this.atEnd() && CASE_TERMINATOR.test(this.peek() as string)) {
        const line = this.advance()
        terminator = terminatorOf((CASE_TERMINATOR.exec(line) as RegExpExecArray)[1])
        const trimmed = line.replace(CASE_TERMINATOR, '').trim()
        if (trimmed.length) body.push({ type: 'simple', line: trimmed })
      }

      clauses.push({ patterns, body, ...terminator })
    }

    const redirect = this.expectKeywordLine('esac')
    return { type: 'case', word, clauses, ...(redirect ? { redirect } : {}) }
  }

  private parseFunctionKeywordForm(): FunctionDef {
    const header = this.restAfterKeyword(this.peek() as string, 'function')
    const braced = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\s*\))?\s*(\{.*)$/s.exec(header)
    const inline = braced && this.inlineFunction(braced[1] as string, braced[2] as string)
    if (inline) return inline
    this.advance()
    const open = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\s*\))?\s*\{(.*)$/.exec(header)
    if (open) return this.finishFunctionBody(open[1] as string, true, open[2])
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\s*\))?\s*$/.exec(header)
    if (!match) throw new ControlFlowParseError(`Malformed function definition: function ${header}`)
    return this.finishFunctionBody(match[1] as string, false)
  }

  /**
   * Collects a function body up to its closing `}`. `inlineBodyStart` is what followed the opening brace on the
   * header line; it is pushed back onto the line stream.
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
    while (!this.atEnd() && this.firstWord(this.peek() as string) !== '}') {
      body.push(this.parsePositionedStatement())
    }

    return this.functionDef(name, body, this.expectKeywordLine('}'))
  }

  /**
   * `NAME() { list; }` whole on this line, the `{...` part given as `braced`, and consumes the line; undefined when the
   * body goes on past it. What follows the `}` is a redirection made each time the function is called.
   */
  private inlineFunction(name: string, braced: string): FunctionDef | undefined {
    const text = braced.trim()
    const close = /^\{\s/.test(text) ? closingBrace(text) : -1
    if (close === -1) return undefined
    const at = this.here() ?? 1
    this.advance()
    return this.functionDef(name, parseInlineBody(text.slice(1, close), at), this.compoundTail(text.slice(close + 1).trim(), at))
  }

  /** A redirection on the definition applies to every call: the body becomes a group that carries it */
  private functionDef(name: string, body: Statement[], redirect: string): FunctionDef {
    if (!redirect) return { type: 'function', name, body }
    if (!/^\d*[<>]|^&>/.test(redirect)) throw unexpectedToken(this.firstWord(redirect))
    return { type: 'function', name, body: [{ type: 'group', body, redirect }] }
  }
}

/** `NAME()` and the rest of the line from its opening brace: a definition whose body may close on this line. */
const FUNCTION_HEADER = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)\s*(\{.*)$/s

/** `NAME()` with an opening brace whose body is not closed on this line (`greet() {` or `greet() { echo hi`). */
const OPEN_FUNCTION_DEF = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)\s*(?:\{(.*))?$/s

/**
 * A line that opens a function body with content after the brace. {@link normalizeInlineControlFlow} passes these
 * through untouched.
 */
const ONE_LINE_FUNCTION_BODY = /^(?:function\s+)?[A-Za-z_][A-Za-z0-9_]*\s*(?:\(\s*\))?\s*\{.*\S/s

/**
 * Parses a one-line function body through the same normalization as an interactively typed compound statement.
 * Heredocs are already folded.
 */
function parseInlineBody(text: string, line: number): Statement[] {
  // bash requires the `;` before the closing brace; dropping it here makes the resulting statements
  // identical to the multi-line form's rather than carrying a stray trailing separator.
  const body = text.trim().replace(/;\s*$/, '')
  return new LineParser(preprocessLines(body, line)).parseStatements([])
}

/** Reserved words this parser understands - used by the shell to reject them as command names. */
export const CONTROL_FLOW_KEYWORDS: ReadonlySet<string> = KEYWORDS

/**
 * `then`/`do` must end a line (attached to their condition/header, per `consumeConditionThroughKeyword`),
 * and once attached, the compound "COND then"/"HEADER do" line is complete.
 */
const ATTACH_AND_CLOSE_LINE = new Set(['then', 'do'])
/** Start a new line on their own; the word itself continues to accumulate normally afterward. */
const START_NEW_LINE = new Set(['if', 'while', 'until', 'for', 'select', 'elif'])

/**
 * Closing keywords end a block, so they own their line up to the next top-level `;`; a redirection may follow (`done
 * < input.txt`).
 */
const CLOSE_LINE = new Set(['fi', 'done', 'esac'])
/** Stands alone on its own line, with nothing else - its body starts as a fresh line after it. */
const ISOLATE_ALONE = new Set(['else'])

/**
 * Rewrites a physical line's `;`-joined control flow (`if COND; then BODY; fi`) into the newline-delimited form the
 * line parser understands. Keywords are recognized only after a top-level `;`, so `echo done` is untouched.
 */
export function normalizeInlineControlFlow(text: string): string {
  // A line that opens a function body with content after the brace is passed through untouched; its body is
  // normalized later.
  return text.split('\n')
    .flatMap(line => line.trim().startsWith('#') ? [line] : splitTopLevel(line))
    .map(segment => normalizeOneLineIfNeeded(segment))
    .join('\n')
}

/**
 * `do;`, `then;` and `else;` carry a separator that bash rejects but a history entry joined line by
 * line can contain; it is dropped so the entry still runs.
 */
function skipStraySemicolon(text: string, from: number): number {
  let at = from
  while (at < text.length && /\s/.test(text[at] as string)) at++
  return text[at] === ';' && text[at + 1] !== ';' ? at + 1 : from
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
      if (text[i + 1] === ';') { const length = text[i + 2] === '&' && text[i + 3] !== '&' ? 3 : 2; current += text.slice(i, i + length); i += length; continue }
      if (text[i + 1] === '&' && text[i + 2] !== '&') { current += ';&'; i += 2; continue }

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
        i = skipStraySemicolon(text, k)
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
        i = skipStraySemicolon(text, k)
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
 * Parses a full script into a statement tree. Blank lines and full-line comments are dropped. Heredoc bodies are
 * folded into single tokens first.
 */
export function parseStatements(script: string): Statement[] {
  const lines = preprocessLines(foldHeredocs(script))
  return new LineParser(lines).parseScript()
}

/** A script's statements; when it does not parse, the ones that come before the failure, and the failure. */
export function parseRunnable(script: string): { statements: Statement[], failure?: ControlFlowParseError } {
  try {
    return { statements: parseStatements(script) }
  } catch (error) {
    if (!(error instanceof ControlFlowParseError)) throw error
    return { statements: error.before ?? [], failure: error }
  }
}

/**
 * Whether `text` is only the beginning of a statement, so an interactive prompt should ask for another line. True for
 * an open heredoc and for an open control-flow block (`incomplete` {@link ControlFlowParseError}); a genuine syntax
 * error is not incomplete.
 */
export function needsMoreInput(text: string): boolean {
  if (!text.trim()) return false
  if (pendingHeredocDelimiter(text) !== null) return true
  // an open quote runs on to the next line, as at a bash prompt (a here-document body may hold a lone quote)
  if (!text.includes('<<') && hasOpenQuote(text)) return true
  // a backslash at the end continues the line
  if (endsInContinuation(text)) return true

  try {
    parseStatements(text)
    return false
  } catch (error) {
    return error instanceof ControlFlowParseError && error.incomplete
  }
}
