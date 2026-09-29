/**
 * Groups a script's lines into a tree of statements: plain lines plus `if`/`while`/`for`/`case`
 * blocks and function definitions. `shell-parser.ts` still owns everything *within* one logical
 * line (words, redirections, `;`/`&&`/`||`/`|`) -- this is the layer above it, the one that lets a
 * script span multiple lines around a keyword.
 *
 * Grammar (line-oriented; each production consumes whole lines, not characters):
 * ```
 * Statements := Statement*
 * Statement  := If | While | For | Case | FunctionDef | Simple
 * If         := 'if' Line 'then' Statements ('elif' Line 'then' Statements)* ('else' Statements)? 'fi'
 * While      := 'while' Line 'do' Statements 'done'
 * For        := 'for' NAME 'in' Word* ';'? 'do' Statements 'done'
 * Case       := 'case' Word 'in' (Pattern ('|' Pattern)* ')' Statements ';;')* 'esac'
 * FunctionDef:= NAME '()' '{' Statements '}'   |   'function' NAME '{' Statements '}'
 * Simple     := <any other non-blank, non-comment line, handed to Shell.execute verbatim>
 * ```
 *
 * A block's condition/list line (the text after `if`/`while`/`elif`, or between `case` and `in`)
 * is kept as raw text -- it is a normal shell line and goes through `Shell.execute`/`parseScript`
 * unchanged, so this parser never needs to know about pipes, redirections, or substitutions.
 */

import { foldHeredocs, pendingHeredocDelimiter } from '#lib/shell-parser.ts'

export interface SimpleStatement {
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

export interface IfStatement extends Redirected {
  type: 'if'
  branches: Array<{ condition: string, body: Statement[] }>
  elseBody: Statement[] | null
}

export interface WhileStatement extends Redirected {
  type: 'while'
  condition: string
  body: Statement[]
}

export interface ForStatement extends Redirected {
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

export interface CaseStatement extends Redirected {
  type: 'case'
  word: string
  clauses: CaseClause[]
}

export interface FunctionDef {
  type: 'function'
  name: string
  body: Statement[]
}

export type Statement = SimpleStatement | IfStatement | WhileStatement | ForStatement | CaseStatement | FunctionDef

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

/** Split a script into non-blank, non-comment, non-empty-after-trim logical lines. */
function preprocessLines(script: string): string[] {
  return script
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))
}

const KEYWORDS = new Set(['if', 'then', 'elif', 'else', 'fi', 'while', 'do', 'done', 'for', 'in', 'case', 'esac', 'function'])

class LineParser {
  private pos = 0
  constructor(private lines: string[]) {}

  private peek(): string | undefined { return this.lines[this.pos] }
  private advance(): string { return this.lines[this.pos++] as string }
  private atEnd(): boolean { return this.pos >= this.lines.length }

  private firstWord(line: string): string {
    return (line.split(/\s+/)[0]) ?? ''
  }

  parseStatements(stopWords: string[]): Statement[] {
    const statements: Statement[] = []
    while (!this.atEnd() && !stopWords.includes(this.firstWord(this.peek() as string))) {
      statements.push(this.parseStatement())
    }
    return statements
  }

  private parseStatement(): Statement {
    const line = this.peek() as string
    const keyword = this.firstWord(line)

    switch (keyword) {
      case 'if': return this.parseIf()
      case 'while': return this.parseWhile()
      case 'for': return this.parseFor()
      case 'case': return this.parseCase()
      case 'function': return this.parseFunctionKeywordForm()
      default: {
        const inlineFn = INLINE_FUNCTION_DEF.exec(line)
        if (inlineFn) {
          this.advance()
          return { type: 'function', name: inlineFn[1] as string, body: parseInlineBody(inlineFn[2] as string) }
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
      const next = this.advance()
      if (next.trim() !== throughKeyword) {
        throw new ControlFlowParseError(`Expected '${throughKeyword}' alone on its line, got: ${next}`)
      }
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

  private parseWhile(): WhileStatement {
    const condition = this.consumeConditionThroughKeyword('while', 'do')
    const body = this.parseStatements(['done'])
    const redirect = this.expectKeywordLine('done')
    return { type: 'while', condition, body, ...(redirect ? { redirect } : {}) }
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
      this.advance()
    }

    const body = this.parseStatements(['done'])
    const redirect = this.expectKeywordLine('done')
    return { type: 'for', variable, wordsText: wordsPart.trim(), body, ...(redirect ? { redirect } : {}) }
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
        body.push(this.parseStatement())
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
    const header = this.restAfterKeyword(this.advance(), 'function')
    const inline = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\s*\))?\s*\{(.+)\}\s*$/.exec(header)
    if (inline) return { type: 'function', name: inline[1] as string, body: parseInlineBody(inline[2] as string) }
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

    if (inlineBodyStart && inlineBodyStart.trim()) this.lines.splice(this.pos, 0, inlineBodyStart.trim())

    const body: Statement[] = []
    while (!this.atEnd() && this.peek() !== '}') {
      body.push(this.parseStatement())
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
function parseInlineBody(text: string): Statement[] {
  // bash requires the `;` before the closing brace; dropping it here makes the resulting statements
  // identical to the multi-line form's rather than carrying a stray trailing separator.
  const body = text.trim().replace(/;\s*$/, '')
  return new LineParser(preprocessLines(normalizeInlineControlFlow(body))).parseStatements([])
}

/** Reserved words this parser understands -- used by the shell to reject them as command names. */
export const CONTROL_FLOW_KEYWORDS: ReadonlySet<string> = KEYWORDS

/**
 * `then`/`do` must end a line (attached to their condition/header, per `consumeConditionThroughKeyword`),
 * and once attached, the compound "COND then"/"HEADER do" line is complete.
 */
const ATTACH_AND_CLOSE_LINE = new Set(['then', 'do'])
/** Start a new line on their own; the word itself continues to accumulate normally afterward. */
const START_NEW_LINE = new Set(['if', 'while', 'for', 'elif', 'fi', 'done'])
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
  if (text.includes('\n') || ONE_LINE_FUNCTION_BODY.test(text.trim())) {
    return text.split('\n')
      .map(line => ONE_LINE_FUNCTION_BODY.test(line.trim()) ? line : normalizeOneLine(line))
      .join('\n')
  }

  return normalizeOneLine(text)
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
  const lines = preprocessLines(normalizeInlineControlFlow(foldHeredocs(script)))
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
