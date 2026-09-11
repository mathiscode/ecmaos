/**
 * A recursive-descent shell parser: tokenizer -> AST -> the shapes `Shell.execute` walks.
 *
 * Grammar:
 * ```
 * Script      := Pipeline (( ';' | '&' | '&&' | '||' ) Pipeline)*
 * Pipeline    := Command ('|' Command)*
 * Command     := Word+ Redirection*
 * Redirection := [n] ('>' | '>>' | '<' | '>&' | '<<' | '<<<') Word
 * ```
 *
 * Quoting, tilde expansion, command substitution, and history-bang expansion all happen on the raw
 * line before it reaches this parser (`Shell.execute`'s existing whole-line preprocessing) — the
 * tokenizer's job is word-splitting and operator recognition once that is done, the same division
 * a real shell draws between expansion and parsing.
 */

export type RedirectionType = '>' | '>>' | '<' | '<<' | '<<<' | '>&'

export interface Redirection {
  type: RedirectionType
  /** The file descriptor being redirected, e.g. 2 for `2>`. Defaults to 1 for '>'/'>>', 0 for '<'/'<<'/'<<<' */
  fd: number
  /** The target: a word for `>`/`>>`/`<`, a heredoc body for `<<`, a literal string for `<<<`, or another fd for `>&` */
  target: string
  /** Whether the target of `>&` is a file descriptor number (`2>&1`) rather than a word */
  targetIsFd?: boolean
}

export interface Command {
  type: 'command'
  words: string[]
  /** Whether each word in `words` (by index) was fully quoted — an unquoted word may still glob */
  wordsQuoted: boolean[]
  redirections: Redirection[]
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

class ParseError extends Error {}

const OPERATORS = ['&&', '||', ';', '&', '|'] as const

interface Token {
  kind: 'word' | 'operator' | 'redirect'
  value: string
  /** For 'redirect' tokens: the fd prefix, if any (e.g. 2 in `2>`) */
  fd?: number
  /** For 'word' tokens: whether every character came from inside quotes (so it should not glob) */
  quoted?: boolean
}

/**
 * Split a line into words, operators, and redirection tokens, respecting single quotes, double
 * quotes, and backslash escapes the same way `expandTilde`/`parseCommandSubstitution` already do
 * elsewhere in the shell. Quoted content is never mistaken for an operator.
 */
export function tokenize(line: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  let current = ''
  let currentHasContent = false
  /** True only if every character appended to `current` so far came from inside quotes */
  let currentAllQuoted = true

  const flush = () => {
    if (currentHasContent) {
      tokens.push({ kind: 'word', value: current, quoted: currentAllQuoted })
      current = ''
      currentHasContent = false
      currentAllQuoted = true
    }
  }

  while (i < line.length) {
    const char = line[i] as string

    if (char === '\\' && i + 1 < line.length) {
      current += line[i + 1]
      currentHasContent = true
      currentAllQuoted = false
      i += 2
      continue
    }

    if (char === "'") {
      const end = line.indexOf("'", i + 1)
      if (end === -1) throw new ParseError(`Unterminated single quote`)
      current += line.slice(i + 1, end)
      currentHasContent = true
      i = end + 1
      continue
    }

    if (char === '"') {
      let j = i + 1
      let value = ''
      while (j < line.length && line[j] !== '"') {
        if (line[j] === '\\' && j + 1 < line.length && '"\\$`'.includes(line[j + 1] as string)) {
          value += line[j + 1]
          j += 2
        } else {
          value += line[j]
          j++
        }
      }
      if (j >= line.length) throw new ParseError(`Unterminated double quote`)
      current += value
      currentHasContent = true
      i = j + 1
      continue
    }

    if (/\s/.test(char)) {
      flush()
      i++
      continue
    }

    // Redirections: [n]> [n]>> [n]< [n]<< [n]<<< [n]>&
    const fdMatch = /^(\d*)(<<<|<<|>>|>&|>|<)/.exec(line.slice(i))
    if (fdMatch && !currentHasContent) {
      const [full, fdStr, op] = fdMatch
      flush()
      tokens.push({ kind: 'redirect', value: op as string, fd: fdStr ? Number(fdStr) : undefined })
      i += (full as string).length
      continue
    }

    // Operators: && || ; & |  (checked longest-first so && doesn't split into two &)
    const opMatch = OPERATORS.find(op => line.startsWith(op, i))
    if (opMatch) {
      flush()
      tokens.push({ kind: 'operator', value: opMatch })
      i += opMatch.length
      continue
    }

    current += char
    currentHasContent = true
    currentAllQuoted = false
    i++
  }

  flush()
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
    if (this.peek()?.kind === 'word' && this.peek()?.value === '!') {
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
    const redirections: Redirection[] = []

    while (!this.atEnd()) {
      const token = this.peek() as Token
      if (token.kind === 'operator') break

      if (token.kind === 'redirect') {
        this.advance()
        const targetToken = this.advance()
        if (!targetToken || targetToken.kind === 'operator') {
          throw new ParseError(`Expected a target after ${token.value}`)
        }

        redirections.push(this.buildRedirection(token, targetToken.value))
        continue
      }

      this.advance()
      words.push(token.value)
      wordsQuoted.push(token.quoted ?? false)
    }

    if (words.length === 0 && redirections.length === 0) {
      throw new ParseError('Expected a command')
    }

    return { type: 'command', words, wordsQuoted, redirections }
  }

  private buildRedirection(token: Token, target: string): Redirection {
    const defaultFd = token.value === '<' || token.value === '<<' || token.value === '<<<' ? 0 : 1
    const fd = token.fd ?? defaultFd

    if (token.value === '>&') {
      const targetIsFd = /^\d+$/.test(target)
      return { type: '>&', fd, target, targetIsFd }
    }

    return { type: token.value as RedirectionType, fd, target }
  }
}

/** Parse a fully preprocessed shell line (post substitution/tilde/history expansion) into a Script AST. */
export function parseScript(line: string): Script {
  const tokens = tokenize(line)
  return new Parser(tokens).parseScript()
}
