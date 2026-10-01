import { Interpreter, type InterpreterHost } from '../../../src/lib/shell-core/interpreter.ts'
import { BreakSignal, ContinueSignal, ExitSignal, ReturnSignal } from '../../../src/lib/shell-core/signals.ts'
import { ShellState } from '../../../src/lib/shell-core/state.ts'
import type { Pipeline } from '../../../src/lib/shell-parser.ts'

/**
 * A host with no kernel and no processes: commands are a handful of scripted names, output is
 * collected, and the interrupt flag is a field. Enough to exercise every path of the interpreter.
 */
export class FakeHost implements InterpreterHost {
  readonly state = new ShellState({ pid: () => 1, ppid: () => 0 })
  readonly interpreter = new Interpreter(this, this.state, { maxFunctionDepth: 50 })
  readonly out: string[] = []
  readonly errors: string[] = []
  readonly traced: string[] = []
  status = 0
  interrupted = false
  exited: number | undefined
  /** Called with each simple command's words, so a test can react (`interrupt`, ...). */
  onCommand?: (words: string[]) => void

  async runPipeline(pipeline: Pipeline): Promise<number[]> {
    const statuses: number[] = []
    for (const command of pipeline.commands) statuses.push(await this.command(command.words))
    if (pipeline.negated) return [statuses[statuses.length - 1] === 0 ? 1 : 0]
    return statuses
  }

  async runBackground(pipeline: Pipeline): Promise<number> {
    for (const command of pipeline.commands) this.out.push(`bg:${command.words.join(' ')}`)
    return 0
  }

  private async command(words: string[]): Promise<number> {
    const [name = '', ...args] = words
    this.onCommand?.(words)
    switch (name) {
      case 'true': return 0
      case 'false': return 1
      case 'echo': this.out.push(args.join(' ')); return 0
      case 'status': this.out.push(String(this.status)); return 0
      case 'fail': return Number(args[0] ?? 1)
      case 'break': throw new BreakSignal(Number(args[0] ?? 1))
      case 'continue': throw new ContinueSignal(Number(args[0] ?? 1))
      case 'return': throw new ReturnSignal(args[0] === undefined ? this.status : Number(args[0]))
      case 'exit': throw new ExitSignal(args[0] === undefined ? this.status : Number(args[0]))
      case 'set': for (const arg of args) { if (arg === '-e') this.state.setOption('errexit', true); if (arg === '+e') this.state.setOption('errexit', false); if (arg === '-o') this.state.setOption('pipefail', true) } return 0
      case 'trap': this.state.setTrap(args[0], args[1] ?? 'EXIT'); return 0
      case 'x=': this.state.set(args[0] ?? '', args[1] ?? ''); return 0
      case 'args': this.out.push(`[${[...this.params].join(',')}]`); return 0
    }
    if (this.state.functions.has(name)) return await this.interpreter.callFunction(name, args)
    this.errors.push(`${name}: command not found`)
    return 127
  }

  params: string[] = []

  async withRedirect(_statement: { redirect?: string }, run: () => Promise<number>): Promise<number> { return await run() }
  async expandWords(text: string): Promise<string[]> { return text.split(/\s+/).filter(Boolean) }
  async caseSubject(word: string): Promise<string> { return word }
  matchesPattern(subject: string, pattern: string): boolean {
    return pattern === '*' || pattern === subject
  }
  assign(name: string, value: string): void { this.state.set(name, value) }

  enterParameters(args: string[]): () => void {
    const saved = this.params
    this.params = args
    return () => { this.params = saved }
  }

  snapshot(): () => void {
    const saved = this.state.snapshot()
    return () => this.state.restore(saved)
  }

  getStatus(): number { return this.status }
  setStatus(code: number): void { this.status = code }
  async checkpoint(): Promise<boolean> { return this.interrupted }

  async exitShell(code: number): Promise<never> {
    this.exited = code
    throw new ExitSignal(code)
  }

  writeErr(message: string): void { this.errors.push(message) }
  onStatement(statement: { type: string }): void { this.traced.push(statement.type) }

  /** Runs `text`, returning the status; an `exit` that nobody caught ends it with that code. */
  async run(text: string): Promise<number> {
    try { return await this.interpreter.runText(text) } catch (signal) {
      if (signal instanceof ExitSignal) return signal.code
      throw signal
    }
  }
}
