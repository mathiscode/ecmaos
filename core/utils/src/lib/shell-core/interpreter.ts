/**
 * The shell language's control flow, independent of how a command is run.
 *
 * The kernel shell and `/bin/ecmash` each used to walk a statement tree of their own. This walks it
 * once: `if`/`while`/`for`/`case`, `{ }` and `( )`, function calls, `&&`/`||`/`;`/`&` lists, `set -e`
 * with bash's rule for what counts as tested, the `ERR` trap, and the `break`/`continue`/`return`/
 * `exit` unwinding. What it does not do is run a pipeline: that is wiring (streams against file
 * descriptors) and stays with each host, reached through {@link InterpreterHost}.
 */

import { parseStatements, type PipelineStatement, type Statement } from '../control-flow-parser.js'
import { parseScript, type Command, type Pipeline, type Script } from '../shell-parser.js'
import { UnboundVariableError } from '../word-expansion.js'
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
  /** True when the shell is running a script or `-c` text rather than reading a prompt, so an error `set -u` raises ends it. */
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
  private readonly maxFunctionDepth: number

  constructor(
    readonly host: InterpreterHost,
    readonly state: ShellState,
    options: InterpreterOptions = {}
  ) {
    this.maxFunctionDepth = options.maxFunctionDepth ?? 1000
  }

  async runText(text: string): Promise<number> {
    return await this.runStatements(parseStatements(text))
  }

  async runStatements(statements: Statement[]): Promise<number> {
    let last = 0
    for (const statement of statements) {
      if (await this.host.checkpoint()) return last
      if (statement.lineNumber !== undefined) this.state.lineNumber = statement.lineNumber
      await this.host.onStatement?.(statement)
      try {
        last = await this.runStatement(statement)
      } catch (error) {
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
      case 'simple': return await this.runLine(host.expandStatement ? host.expandStatement(statement.line) : statement.line)

      case 'function':
        this.state.functions.set(statement.name, statement.body)
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
        for (const clause of statement.clauses) {
          if (clause.patterns.some(pattern => host.matchesPattern(subject, pattern))) return await this.runStatements(clause.body)
        }
        return 0
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
   * A `;`/`&&`/`||`/`&` list on one line. `set -e` stops the shell on a failure nothing is testing:
   * not an `if` condition, not the left of `&&`/`||`, not a `!` pipeline. The `ERR` trap fires on the
   * same failures, before `set -e` acts.
   */
  async runLine(line: string): Promise<number> {
    const host = this.host
    const prepared = host.prepareLine ? host.prepareLine(line) : line
    if (!prepared.trim()) return 0

    const special = await host.runSpecial?.(prepared)
    if (special !== undefined) return special

    return await this.runScript(parseScript(prepared))
  }

  /**
   * A pipeline with compound stages in it (`cmd | while read x; do ...; done`, `(a; b) &`). The plain
   * stages are parsed as ordinary command lines and the compound ones become stages the host runs
   * through {@link runStage}; the result goes through {@link runScript}, so the status, `PIPESTATUS`,
   * `set -e` and the `ERR` trap treat it like any other pipeline.
   */
  private async runPipelineStatement(statement: PipelineStatement): Promise<number> {
    const host = this.host
    const commands: Command[] = []
    let background = Boolean(statement.background)
    for (const stage of statement.stages) {
      if (stage.type !== 'simple') {
        commands.push({ type: 'command', words: [], wordsQuoted: [], wordParts: [], redirections: [], compound: stage })
        continue
      }
      const expanded = host.expandStatement ? host.expandStatement(stage.line) : stage.line
      const prepared = host.prepareLine ? host.prepareLine(expanded) : expanded
      const script = parseScript(prepared)
      const only = script.stages[0]
      if (script.stages.length !== 1 || !only) throw new Error(`unsupported pipeline stage: ${stage.line}`)
      if (only.operator === '&') background = true
      commands.push(...only.pipeline.commands)
    }
    const pipeline: Pipeline = { type: 'pipeline', commands, negated: false }
    return await this.runScript({ type: 'script', stages: [{ pipeline, operator: background ? '&' : null }] })
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
   * Calls a registered function: a `local` frame of its own, positional parameters set to `args`.
   *
   * `return` unwinds to here. `break`/`continue` stop here too, deliberately: a loop is only
   * breakable from the function it is written in, so a stray `break` in a function called from a loop
   * must not end the caller's loop.
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
    this.state.pushLocalScope()
    this.catchers.return++
    const enclosingLoops = this.catchers.loop
    this.catchers.loop = 0
    try {
      return await this.runStatements(body)
    } catch (signal) {
      if (signal instanceof ReturnSignal) return signal.code
      if (signal instanceof BreakSignal || signal instanceof ContinueSignal) {
        await this.host.writeErr(`${signal.message}: only meaningful in a \`for', \`while', or \`until' loop`)
        return 0
      }
      throw signal
    } finally {
      this.catchers.return--
      this.catchers.loop = enclosingLoops
      this.state.popLocalScope()
      this.depth--
      restoreParameters()
    }
  }

  /**
   * Runs `text` in this shell, as `source` and `eval` do: nothing is forked, so variables, functions
   * and `cd` persist. `return` ends it; `exit` is not caught, because `exit` in a sourced file ends
   * the shell that sourced it.
   */
  async runSourced(text: string, positional?: string[]): Promise<number> {
    const statements = parseStatements(text)
    const restoreParameters = positional ? this.host.enterParameters(positional) : undefined
    this.catchers.return++
    try {
      return await this.runStatements(statements)
    } catch (signal) {
      if (signal instanceof ReturnSignal) return signal.code
      throw signal
    } finally {
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
