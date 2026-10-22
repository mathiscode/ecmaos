/**
 * The shell language's control flow, independent of how a command runs: `if`, `while`, `for`, `case`, `{ }`, `( )`,
 * function calls, `&&`/`||`/`;`/`&` lists, `set -e` with bash's tested-context rule, the `ERR` trap, and
 * `break`/`continue`/`return`/`exit` unwinding. Running a pipeline stays with each host ({@link InterpreterHost}).
 */

import { ControlFlowParseError, parseRunnable, type PipelineStatement, type SelectStatement, type Statement } from '../control-flow-parser.js'
import { ParseError, parseScript, type Command, type Pipeline, type Script, type ScriptStage } from '../shell-parser.js'
import { ArithmeticError } from '../expand-variables.js'
import { GlobNoMatchError, UnboundVariableError } from '../word-expansion.js'
import { parseArrayAssignment } from './prepare.js'
import { formatSelectMenu } from './select-menu.js'
import { BreakSignal, ContinueSignal, ExitSignal, ReturnSignal } from './signals.js'
import type { ShellState } from './state.js'

/** What the interpreter needs from whoever runs the commands. */
export interface InterpreterHost {
  /** Runs one foreground pipeline and reports each stage's status (already negated for `! cmd`). */
  runPipeline(pipeline: Pipeline): Promise<number[]>
  /** Starts a pipeline in the background and returns at once; the status is that of starting it. */
  runBackground(pipeline: Pipeline): Promise<number>

  /**
   * Gets first look at a line before it is parsed as a list: the kernel's assignment forms and
   * `ecmash`'s array assignments live here until a shared preparation step replaces them. Returns a
   * status when it consumed the line.
   */
  runSpecial?(line: string): Promise<number | undefined>
  /** Rewrites any line before it is parsed as a list (the kernel strips comments here). */
  prepareLine?(line: string): string
  /**
   * Rewrites the line of a simple *statement*, once, before it runs. Aliases are expanded here and not
   * in `prepareLine`, because `runSpecial` re-enters with the rest of an already-expanded line.
   */
  expandStatement?(line: string): string
  /** Called before each statement, for `set -v` tracing. */
  onStatement?(statement: Statement): Promise<void> | void

  /** Holds a compound statement's trailing redirection over `run`. */
  withRedirect(statement: { redirect?: string }, run: () => Promise<number>): Promise<number>

  /** The values of a `for` list, expanded the way arguments are. */
  expandWords(text: string): Promise<string[]>
  /** The subject of a `case`. */
  caseSubject(word: string): Promise<string>
  matchesPattern(subject: string, pattern: string): boolean
  assign(name: string, value: string): void

  /**
   * Replaces the positional parameters for a function call or a sourced script. Returns the function
   * that puts them back. `zero` is `$0` where the call changes it.
   */
  enterParameters(args: string[], zero?: string): () => void
  /**
   * True when the shell is running a script or `-c` text rather than reading a prompt, so an error `set -u` raises
   * ends it.
   */
  nonInteractive?(): boolean
  /** Captures what a subshell must not leak (variables, cwd, ...). Returns the restore function. */
  snapshot(): () => void

  getStatus(): number
  setStatus(code: number): void

  /**
   * Called between commands and once per loop iteration: the place a pending signal's trap runs and
   * the kernel's `^C` flag is read. Returns true when the current line has been interrupted.
   */
  checkpoint(): Promise<boolean>
  /** Ends the shell with `code`, running whatever exiting runs (the kernel throws, `ecmash` leaves). */
  exitShell(code: number): Promise<never>
  /** Reports a diagnostic. The host adds its own prefix. */
  writeErr(message: string): Promise<void> | void
}

export interface InterpreterOptions {
  /** Function nesting beyond this reports an error rather than exhausting the stack. */
  maxFunctionDepth?: number
}

export class Interpreter {
  /**
   * How many enclosing constructs will catch each unwind signal. A signal with nobody to catch it is
   * the host's to report, which is why these are visible.
   */
  readonly catchers = { exit: 0, return: 0, loop: 0 }
  /** Nesting of `( )` subshells; `exit` inside one ends only it. */
  subshellDepth = 0
  /** Nesting of contexts where a failure is being tested (`if` conditions, `&&`/`||` operands). */
  private conditional = 0
  private inErrTrap = false
  private depth = 0
  /** The names of the functions being run, innermost first: `FUNCNAME`. */
  private callStack: string[] = []
  private readonly maxFunctionDepth: number

  constructor(
    readonly host: InterpreterHost,
    readonly state: ShellState,
    options: InterpreterOptions = {}
  ) {
    this.maxFunctionDepth = options.maxFunctionDepth ?? 1000
  }

  /** The value of an arithmetic expression, assignments in it taking effect (`x = 3`, `i++`). */
  async arithmetic(expression: string): Promise<number> {
    return Number((await this.host.expandWords(`$(( ${expression} ))`))[0] ?? 0)
  }

  /**
   * Runs `text` as bash reads a script, a command at a time: when a line does not parse, the commands before it have
   * run, and the {@link ControlFlowParseError} is thrown after them.
   */
  async runText(text: string): Promise<number> {
    const { statements, failure } = parsedAhead(parseRunnable(text))
    const status = await this.runStatements(statements)
    if (failure) throw failure
    return status
  }

  private statementDepth = 0

  async runStatements(statements: Statement[]): Promise<number> {
    // A refused assignment skips the rest of its line, not of the shell's life: a fresh top-level run starts clean.
    if (this.statementDepth === 0) this.state.failedLine = undefined
    this.statementDepth++
    try { return await this.runStatementList(statements) } finally { this.statementDepth-- }
  }

  private async runStatementList(statements: Statement[]): Promise<number> {
    let last = 0
    for (const statement of statements) {
      if (await this.host.checkpoint()) return last
      if (statement.lineNumber !== undefined) {
        if (statement.lineNumber === this.state.failedLine) continue
        this.state.failedLine = undefined
        this.state.lineNumber = statement.lineNumber
      }
      await this.host.onStatement?.(statement)
      try {
        last = await this.runStatement(statement)
      } catch (error) {
        // `failglob`: a pattern with no match fails the command it is in, and nothing else
        if (error instanceof GlobNoMatchError) {
          await this.host.writeErr(error.message)
          last = 1
          this.host.setStatus(1)
          continue
        }
        if (error instanceof ArithmeticError) {
          // Like a refused assignment: the command fails and the rest of its line is skipped.
          await this.host.writeErr(error.message)
          this.state.failedLine = this.state.lineNumber
          last = 1
          this.host.setStatus(1)
          continue
        }
        if (!(error instanceof UnboundVariableError)) throw error
        // bash reports it and, in a script, ends the shell with status 1; at the prompt it only fails the command.
        await this.host.writeErr(error.message)
        this.host.setStatus(1)
        if (this.catchers.exit > 0 || this.host.nonInteractive?.()) await this.host.exitShell(1)
        last = 1
      }
      this.host.setStatus(last)
    }
    return last
  }

  async runStatement(statement: Statement): Promise<number> {
    const host = this.host
    switch (statement.type) {
      case 'simple':
        await this.runDebugTrap()
        return await this.runLine(host.expandStatement ? host.expandStatement(statement.line) : statement.line)

      case 'function':
        this.state.functions.set(statement.name, statement.body)
        this.state.recordFunctionDefinition(statement.name)
        return 0

      case 'if': return await host.withRedirect(statement, async () => {
        for (const branch of statement.branches) {
          if (await this.runCondition(branch.condition) === 0) return await this.runStatements(branch.body)
        }
        return statement.elseBody ? await this.runStatements(statement.elseBody) : 0
      })

      case 'while': return await host.withRedirect(statement, async () => {
        let last = 0
        while ((await this.runCondition(statement.condition) === 0) !== Boolean(statement.until)) {
          if (await host.checkpoint()) break
          const turn = await this.runLoopBody(statement.body)
          if (turn.status !== undefined) last = turn.status
          if (turn.stop) break
        }
        return last
      })

      case 'for': return await host.withRedirect(statement, async () => {
        let last = 0
        for (const value of await host.expandWords(statement.wordsText)) {
          if (await host.checkpoint()) break
          host.assign(statement.variable, value)
          const turn = await this.runLoopBody(statement.body)
          if (turn.status !== undefined) last = turn.status
          if (turn.stop) break
        }
        return last
      })

      case 'select': return await host.withRedirect(statement, () => this.runSelect(statement))

      case 'cfor': return await host.withRedirect(statement, async () => {
        let last = 0
        const arithmetic = async (text: string): Promise<number> => Number((await host.expandWords(`$(( ${text} ))`))[0] ?? 0)
        if (statement.init) await arithmetic(statement.init)
        while (!statement.cond || await arithmetic(statement.cond) !== 0) {
          if (await host.checkpoint()) break
          const turn = await this.runLoopBody(statement.body)
          if (turn.status !== undefined) last = turn.status
          if (turn.stop) break
          if (statement.step) await arithmetic(statement.step)
        }
        return last
      })

      case 'case': return await host.withRedirect(statement, async () => {
        const subject = await host.caseSubject(statement.word)
        let last = 0
        let fallThrough = false
        for (const clause of statement.clauses) {
          // `;&` runs the next clause's body without testing it; `;;&` goes on testing the rest
          if (!fallThrough && !clause.patterns.some(pattern => host.matchesPattern(subject, pattern))) continue
          last = await this.runStatements(clause.body)
          fallThrough = clause.terminator === ';&'
          if (clause.terminator === undefined || clause.terminator === ';;') break
        }
        return last
      })

      case 'andor': {
        // Every operand but the last is being tested, so `set -e` does not act on a failure in one
        const run = async (operand: Statement, tested: boolean): Promise<number> => {
          if (tested) this.conditional++
          try { return await this.runStatement(operand) } finally { if (tested) this.conditional-- }
        }
        let status = await run(statement.first, true)
        host.setStatus(status)
        for (const [index, { op, statement: operand }] of statement.rest.entries()) {
          if (op === '&&' ? status !== 0 : status === 0) continue
          status = await run(operand, index < statement.rest.length - 1)
          host.setStatus(status)
        }
        return status
      }

      case 'pipeline': return await this.runPipelineStatement(statement)

      case 'group': return await host.withRedirect(statement, () => this.runStatements(statement.body))
      case 'subshell': {
        const status = await host.withRedirect(statement, () => this.runSubshell(statement.body))
        // A subshell that failed is a failed command in this shell too, so `set -e` ends this one as well.
        if (status !== 0 && this.state.options.errexit && !this.conditional) await host.exitShell(status)
        return status
      }
    }
  }

  /** Runs text whose failure is being tested, so `set -e` must not act on it. */
  async runCondition(text: string): Promise<number> {
    this.conditional++
    try { return await this.runText(text) } finally { this.conditional-- }
  }

  /**
   * One pass over a loop body. `break` and `continue` are the Nth enclosing loop's to act on, so a
   * signal with a level above 1 is counted down and rethrown for the loop outside. The level lives
   * on the signal, which unwinds with it, so a loop that leaves some other way cannot strand it.
   */
  private async runLoopBody(body: Statement[]): Promise<{ status?: number, stop: boolean }> {
    this.catchers.loop++
    try {
      return { status: await this.runStatements(body), stop: false }
    } catch (signal) {
      if (!(signal instanceof BreakSignal) && !(signal instanceof ContinueSignal)) throw signal
      if (signal.level > 1) { signal.level--; throw signal }
      return { stop: signal instanceof BreakSignal }
    } finally {
      this.catchers.loop--
    }
  }

  /**
   * `select NAME in WORDS; do ...; done`. The menu and prompt go to stderr, the reply is read from stdin into
   * `REPLY`, and the body runs with NAME set to the chosen word (empty for an invalid reply). An empty reply redraws
   * the menu; end of input ends the loop with 1.
   */
  private async runSelect(statement: SelectStatement): Promise<number> {
    const host = this.host
    const items = await host.expandWords(statement.wordsText === undefined ? '"$@"' : statement.wordsText)
    if (items.length === 0) return 0

    // One physical line of command text: a newline or tab in the menu travels as an escape for `printf %b`.
    const quote = (text: string) => `'${text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/'/g, `'\\''`)}'`
    const emit = async (text: string): Promise<void> => {
      const line = this.state.lineNumber
      try { await this.runText(`printf %b ${quote(text)} >&2`) } finally { this.state.lineNumber = line }
    }
    const columns = Number(this.state.lookup('COLUMNS')) || 80

    let last = 0
    let draw = true
    for (;;) {
      if (await host.checkpoint()) break
      if (draw) await emit(formatSelectMenu(items, columns))
      draw = false
      await emit(this.state.lookup('PS3') ?? '#? ')

      const line = this.state.lineNumber
      let read: number
      try { read = await this.runText('read -r') } finally { this.state.lineNumber = line }
      // bash ends the abandoned prompt line on standard output, not standard error
      if (read !== 0) { await this.runText("printf '\\n'"); return 1 }

      const reply = this.state.lookup('REPLY') ?? ''
      if (reply === '') { draw = true; continue }

      const choice = /^\s*[+-]?\d+\s*$/.test(reply) ? Number(reply) : 0
      host.assign(statement.variable, choice >= 1 && choice <= items.length ? items[choice - 1] as string : '')
      const turn = await this.runLoopBody(statement.body)
      if (turn.status !== undefined) last = turn.status
      host.setStatus(last)
      if (turn.stop) break
    }
    return last
  }

  /**
   * A `;`/`&&`/`||`/`&` list on one line. `set -e` stops the shell on a failure nothing is testing:
   * not an `if` condition, not the left of `&&`/`||`, not a `!` pipeline. The `ERR` trap fires on the
   * same failures, before `set -e` acts.
   */
  async runLine(line: string): Promise<number> {
    const host = this.host
    // `(( expression ))` is `let 'expression'`: arithmetic as a command, true when the value is not zero
    const prepared = rewriteArithmeticCommands(host.prepareLine ? host.prepareLine(line) : line)
    if (!prepared.trim()) return 0

    const special = await host.runSpecial?.(prepared)
    if (special !== undefined) return special

    return await this.runScript(parseScript(prepared))
  }

  /**
   * A pipeline with compound stages (`cmd | while read x; do ...; done`, `(a; b) &`). Plain stages are command lines,
   * compound ones become stages the host runs through {@link runStage}; the result goes through {@link runScript}.
   */
  private async runPipelineStatement(statement: PipelineStatement): Promise<number> {
    const host = this.host
    const commands: Command[] = []
    let background = Boolean(statement.background)
    // what follows the pipeline on the same line (`(a) | cat & wait`): the last plain stage carries it
    let rest: ScriptStage[] = []
    let lastOperator: ScriptStage['operator'] = null
    for (const [index, stage] of statement.stages.entries()) {
      if (stage.type !== 'simple') {
        commands.push({ type: 'command', words: [], wordsQuoted: [], wordParts: [], redirections: [], compound: stage })
        continue
      }
      const expanded = host.expandStatement ? host.expandStatement(stage.line) : stage.line
      const prepared = host.prepareLine ? host.prepareLine(expanded) : expanded
      const script = parseScript(prepared)
      const only = script.stages[0]
      if (!only || (script.stages.length !== 1 && index !== statement.stages.length - 1)) throw new Error(`unsupported pipeline stage: ${stage.line}`)
      if (only.operator === '&') background = true
      else lastOperator = only.operator
      rest = script.stages.slice(1)
      commands.push(...only.pipeline.commands)
    }
    const pipeline: Pipeline = { type: 'pipeline', commands, negated: false }
    return await this.runScript({ type: 'script', stages: [{ pipeline, operator: background ? '&' : lastOperator }, ...rest] })
  }

  /**
   * Runs one compound stage of a pipeline. It is a subshell, as in bash: what the stage assigns or
   * changes does not outlive it, and `exit` inside it ends only the stage.
   */
  async runStage(statement: Statement): Promise<number> {
    return await this.inSubshell(() => this.runStatements([statement]))
  }

  /** A shell function used as a pipeline stage (`f | cat`, `cat | f`): called in a subshell, as in bash. */
  async runFunctionStage(name: string, args: string[]): Promise<number> {
    return await this.inSubshell(() => this.callFunction(name, args))
  }

  /** A whole pipeline with compound stages, run in the foreground of a forked shell (what `( a ) | b &` starts). */
  async runForkedPipeline(pipeline: Pipeline): Promise<number> {
    return await this.inSubshell(() => this.runScript({ type: 'script', stages: [{ pipeline, operator: null }] }))
  }

  private async runScript(script: Script): Promise<number> {
    const host = this.host
    let status = host.getStatus()
    let skip = false

    for (const stage of script.stages) {
      if (!skip) {
        const tested = stage.operator === '&&' || stage.operator === '||'
        if (stage.operator === '&') {
          status = await host.runBackground(stage.pipeline)
        } else {
          if (tested) this.conditional++
          let statuses: number[]
          try { statuses = await host.runPipeline(stage.pipeline) } finally { if (tested) this.conditional-- }
          this.state.setArray('PIPESTATUS', statuses.map(String))
          status = this.state.options.pipefail
            ? ([...statuses].reverse().find(code => code !== 0) ?? 0)
            : statuses[statuses.length - 1] ?? 0
        }
        host.setStatus(status)

        if (status !== 0 && stage.operator !== '&' && !this.conditional && !stage.pipeline.negated && !tested) {
          await this.runErrTrap(status)
          if (this.state.options.errexit) await host.exitShell(status)
        }
        if (await host.checkpoint()) return status
      }

      // `a && b || c`: a skipped stage leaves the status alone and the next operator decides again.
      if (stage.operator === '&&') skip = status !== 0
      else if (stage.operator === '||') skip = status === 0
      else skip = false
    }
    return status
  }

  /**
   * The `DEBUG` trap runs before each simple command. Like bash without `functrace`, it does not run inside
   * a function, nor inside itself.
   */
  private inDebugTrap = false
  private async runDebugTrap(): Promise<void> {
    const trap = this.state.getTrap('DEBUG')
    if (!trap || this.inDebugTrap || this.depth > 0) return
    this.inDebugTrap = true
    const status = this.host.getStatus()
    try { await this.runText(trap) } finally {
      this.inDebugTrap = false
      this.host.setStatus(status)
    }
  }

  /** The `RETURN` trap runs when a function or a sourced script finishes, keeping its status. */
  private inReturnTrap = false
  private async runReturnTrap(status: number): Promise<void> {
    const trap = this.state.getTrap('RETURN')
    if (!trap || this.inReturnTrap) return
    this.inReturnTrap = true
    try { await this.runText(trap) } finally {
      this.inReturnTrap = false
      this.host.setStatus(status)
    }
  }

  private async runErrTrap(status: number): Promise<void> {
    const trap = this.state.getTrap('ERR')
    if (!trap || this.inErrTrap) return
    this.inErrTrap = true
    try { await this.runText(trap) } finally {
      this.inErrTrap = false
      this.host.setStatus(status)
    }
  }

  /**
   * Calls a registered function with its own `local` frame and positional parameters `args`. `return` unwinds to
   * here; `break` and `continue` stop here, so a function cannot end its caller's loop.
   */
  async callFunction(name: string, args: string[]): Promise<number> {
    const body = this.state.functions.get(name)
    if (!body) throw new Error(`${name}: function not found`)
    if (this.depth >= this.maxFunctionDepth) {
      await this.host.writeErr(`${name}: maximum function nesting exceeded`)
      return 1
    }

    const restoreParameters = this.host.enterParameters(args, name)
    this.depth++
    this.callStack.unshift(name)
    this.state.setArray('FUNCNAME', [...this.callStack, 'main'])
    this.state.pushSourceFrame(this.state.functionFile(name))
    this.state.pushLocalScope()
    this.catchers.return++
    const enclosingLoops = this.catchers.loop
    this.catchers.loop = 0
    let status = 0
    try {
      status = await this.runStatements(body)
      return status
    } catch (signal) {
      if (signal instanceof ReturnSignal) return status = signal.code
      if (signal instanceof BreakSignal || signal instanceof ContinueSignal) {
        await this.host.writeErr(`${signal.message}: only meaningful in a \`for', \`while', or \`until' loop`)
        return 0
      }
      throw signal
    } finally {
      this.catchers.return--
      this.catchers.loop = enclosingLoops
      this.state.popLocalScope()
      await this.runReturnTrap(status).catch(() => undefined)
      this.state.popSourceFrame()
      this.callStack.shift()
      if (this.callStack.length > 0) this.state.setArray('FUNCNAME', [...this.callStack, 'main'])
      else this.state.unsetArray('FUNCNAME')
      this.depth--
      restoreParameters()
    }
  }

  /**
   * Runs `text` in this shell, as `source` and `eval` do: nothing is forked, so variables, functions
   * and `cd` persist. `return` ends it; `exit` is not caught, because `exit` in a sourced file ends
   * the shell that sourced it.
   */
  async runSourced(text: string, positional?: string[], file?: string): Promise<number> {
    const { statements, failure } = parsedAhead(parseRunnable(text))
    const restoreParameters = positional ? this.host.enterParameters(positional) : undefined
    this.catchers.return++
    if (file !== undefined) this.state.pushSourceFrame(file)
    try {
      const status = await this.runStatements(statements)
      if (failure) throw failure
      return status
    } catch (signal) {
      if (signal instanceof ReturnSignal) return signal.code
      throw signal
    } finally {
      if (file !== undefined) this.state.popSourceFrame()
      this.catchers.return--
      restoreParameters?.()
    }
  }

  /**
   * Runs `( list )`. There is no fork, so a subshell is a snapshot put back afterwards, and `exit`
   * ends only the subshell.
   */
  async runSubshell(statements: Statement[]): Promise<number> {
    return await this.inSubshell(() => this.runStatements(statements))
  }

  private async inSubshell(run: () => Promise<number>): Promise<number> {
    const restore = this.host.snapshot()
    this.catchers.exit++
    this.subshellDepth++
    let code: number
    try {
      code = await run()
    } catch (signal) {
      if (!(signal instanceof ExitSignal)) throw signal
      code = signal.code
    } finally {
      this.subshellDepth--
      this.catchers.exit--
      restore()
    }
    this.host.setStatus(code)
    return code
  }
}

/** A line's syntax error, if it has one: parsed as {@link Interpreter.runLine} parses it, array assignments aside. */
function lineError(line: string): ParseError | undefined {
  const prepared = rewriteArithmeticCommands(line)
  if (!prepared.trim() || parseArrayAssignment(prepared)) return undefined
  try {
    parseScript(prepared)
  } catch (error) {
    if (error instanceof ParseError) return error
    throw error
  }
  return undefined
}

/** The first syntax error in the lines a compound statement holds, its conditions included. */
function compoundError(statement: Statement): ParseError | undefined {
  const inBody = (body: Statement[]) => {
    for (const inner of body) {
      const error = inner.type === 'simple' ? lineError(inner.line) : compoundError(inner)
      if (error) return error
    }
    return undefined
  }
  switch (statement.type) {
    case 'simple': return lineError(statement.line)
    case 'if':
      for (const branch of statement.branches) {
        const error = lineError(branch.condition) ?? inBody(branch.body)
        if (error) return error
      }
      return statement.elseBody ? inBody(statement.elseBody) : undefined
    case 'while': return lineError(statement.condition) ?? inBody(statement.body)
    case 'case': {
      for (const clause of statement.clauses) {
        const error = inBody(clause.body)
        if (error) return error
      }
      return undefined
    }
    case 'pipeline': return inBody(statement.stages)
    case 'andor': return inBody([statement.first, ...statement.rest.map(next => next.statement)])
    default: return inBody(statement.body)
  }
}

/**
 * A script's statements checked as bash checks them: a compound command is parsed whole before any of it runs, so a
 * line in it that does not parse (`if false; then echo ); fi`) is a syntax error before the compound starts, where
 * its lines would otherwise be parsed only when reached. A plain line at the top is still parsed as it is reached.
 */
function parsedAhead({ statements, failure }: ReturnType<typeof parseRunnable>): ReturnType<typeof parseRunnable> {
  for (const [index, statement] of statements.entries()) {
    if (statement.type === 'simple') continue
    const error = compoundError(statement)
    if (error) return { statements: statements.slice(0, index), failure: new ControlFlowParseError(error.message) }
  }
  return { statements, failure }
}

/**
 * Rewrites each `(( expression ))` that stands where a command can (the start of the line, or after `;`, `&&`,
 * `||`, `|`, `!` or `(`) as `let 'expression'`, which means the same thing: arithmetic, with a status of 0 when
 * the value is not zero. Quoted text and `$(( ))` are left alone.
 */
export function rewriteArithmeticCommands(line: string): string {
  if (!line.includes('((')) return line
  let out = ''
  let commandStart = true
  let quote: string | undefined
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string
    if (quote) {
      out += c
      if (c === '\\' && quote === '"') { out += line[++i] ?? ''; continue }
      if (c === quote) quote = undefined
      continue
    }
    if (c === "'" || c === '"') { quote = c; out += c; commandStart = false; continue }
    if (c === '\\') { out += c + (line[++i] ?? ''); commandStart = false; continue }
    if (c === '$' && line[i + 1] === '(') {
      // `$(...)` and `$((...))`: copied whole
      let depth = 0
      let j = i + 1
      for (; j < line.length; j++) {
        if (line[j] === '(') depth++
        else if (line[j] === ')' && --depth === 0) break
      }
      out += line.slice(i, j + 1)
      i = j
      commandStart = false
      continue
    }
    if (commandStart && c === '(' && line[i + 1] === '(') {
      let depth = 0
      let j = i
      for (; j < line.length; j++) {
        if (line[j] === '(') depth++
        else if (line[j] === ')' && --depth === 0) break
      }
      // the `((` has to close with `))`, or it is a subshell inside a subshell
      if (j < line.length && line[j - 1] === ')' && depth === 0) {
        const expression = line.slice(i + 2, j - 1)
        out += `let '${expression.replace(/'/g, `'\\''`)}'`
        i = j
        commandStart = false
        continue
      }
    }
    out += c
    if (c === ';' || c === '|' || c === '&' || c === '(' || c === '!') commandStart = true
    else if (c !== ' ' && c !== '\t' && c !== '\n') commandStart = false
  }
  return out
}
