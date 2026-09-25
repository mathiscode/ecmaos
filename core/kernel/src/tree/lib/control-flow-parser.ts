/**
 * Groups a script's lines into a tree of statements: plain lines plus `if`/`while`/`for`/`case`
 * blocks and function definitions. `shell-parser.ts` still owns everything *within* one logical
 * line (words, redirections, `;`/`&&`/`||`/`|`) -- this is the layer above it, the one that lets a
 * script span multiple lines around a keyword the way `Kernel.executeScript`'s old flat
 * `line.split('\n')` + one `shell.execute(line)` per line never could.
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

export interface SimpleStatement {
  type: 'simple'
  line: string
}

export interface IfStatement {
  type: 'if'
  branches: Array<{ condition: string, body: Statement[] }>
  elseBody: Statement[] | null
}

export interface WhileStatement {
  type: 'while'
  condition: string
  body: Statement[]
}

export interface ForStatement {
  type: 'for'
  variable: string
  words: string[]
  body: Statement[]
}

export interface CaseClause {
  patterns: string[]
  body: Statement[]
}

export interface CaseStatement {
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

class ControlFlowParseError extends Error {}

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
        const fnMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)\s*\{?\s*$/.exec(line)
        if (fnMatch) return this.parseFunctionParenForm(fnMatch[1] as string, line)
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
    let line = this.restAfterKeyword(this.advance(), openKeyword)
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

    throw new ControlFlowParseError(`Expected '${throughKeyword}' after '${openKeyword} ${line}'`)
  }

  private expectKeywordLine(keyword: string): void {
    if (this.atEnd() || this.firstWord(this.peek() as string) !== keyword) {
      throw new ControlFlowParseError(`Expected '${keyword}', got: ${this.peek() ?? '<end of script>'}`)
    }
    this.advance()
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

    this.expectKeywordLine('fi')
    return { type: 'if', branches, elseBody }
  }

  private parseWhile(): WhileStatement {
    const condition = this.consumeConditionThroughKeyword('while', 'do')
    const body = this.parseStatements(['done'])
    this.expectKeywordLine('done')
    return { type: 'while', condition, body }
  }

  private parseFor(): ForStatement {
    const header = this.restAfterKeyword(this.advance(), 'for')
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s+in\s+(.*?);?\s*(do)?$/.exec(header)
    if (!match) throw new ControlFlowParseError(`Malformed for-loop header: for ${header}`)

    const [, variable, wordsPart, inlineDo] = match as unknown as [string, string, string, string | undefined]
    if (!inlineDo) {
      if (this.firstWord(this.peek() ?? '') !== 'do') {
        throw new ControlFlowParseError(`Expected 'do' after 'for ${header}'`)
      }
      this.advance()
    }

    const words = wordsPart.trim().length ? (wordsPart.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map(w =>
      (w.startsWith('"') && w.endsWith('"')) || (w.startsWith("'") && w.endsWith("'")) ? w.slice(1, -1) : w
    ) : []

    const body = this.parseStatements(['done'])
    this.expectKeywordLine('done')
    return { type: 'for', variable, words, body }
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

    this.expectKeywordLine('esac')
    return { type: 'case', word, clauses }
  }

  private parseFunctionKeywordForm(): FunctionDef {
    const header = this.restAfterKeyword(this.advance(), 'function')
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\s*\))?\s*\{?\s*$/.exec(header)
    if (!match) throw new ControlFlowParseError(`Malformed function definition: function ${header}`)
    return this.finishFunctionBody(match[1] as string, header.trim().endsWith('{'))
  }

  private parseFunctionParenForm(name: string, line: string): FunctionDef {
    this.advance()
    return this.finishFunctionBody(name, line.trim().endsWith('{'))
  }

  private finishFunctionBody(name: string, openBraceOnHeaderLine: boolean): FunctionDef {
    if (!openBraceOnHeaderLine) {
      if (this.firstWord(this.peek() ?? '') !== '{') {
        throw new ControlFlowParseError(`Expected '{' to open function '${name}'`)
      }
      this.advance()
    }

    const body: Statement[] = []
    while (!this.atEnd() && this.peek() !== '}') {
      body.push(this.parseStatement())
    }

    this.expectKeywordLine('}')
    return { type: 'function', name, body }
  }
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

/** Parse a full script into a statement tree. Blank lines and full-line comments are dropped. */
export function parseStatements(script: string): Statement[] {
  const lines = preprocessLines(normalizeInlineControlFlow(script))
  const parser = new LineParser(lines)
  const statements = parser.parseStatements([])
  return statements
}
