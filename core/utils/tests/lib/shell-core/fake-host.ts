import { Interpreter, type InterpreterHost } from '../../../src/lib/shell-core/interpreter.ts'
import { BreakSignal, ContinueSignal, ExitSignal, ReturnSignal } from '../../../src/lib/shell-core/signals.ts'
import { runSharedBuiltin, sharedBuiltinNames, type BuiltinHost } from '../../../src/lib/shell-core/builtins.ts'
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

  /** When set, the shared builtins run for their names, over an in-memory file system. */
  shared = false
  readonly files = new Map<string, string>()
  readonly directories = new Set<string>(['/'])
  stdin: string[] = []
  cwd = '/'

  builtinHost(): BuiltinHost {
    return {
      state: this.state,
      interpreter: this.interpreter,
      cwd: () => this.cwd,
      chdir: async target => {
        if (!this.directories.has(target)) return 'No such file or directory'
        this.cwd = target
        return undefined
      },
      resolvePath: path => path.startsWith('/') ? path : `${this.cwd === '/' ? '' : this.cwd}/${path}`,
      stat: async path => {
        if (this.directories.has(path)) return { file: false, directory: true, size: 0 }
        const body = this.files.get(path)
        return body === undefined ? undefined : { file: true, directory: false, size: body.length }
      },
      readFile: async path => this.files.get(path) ?? '',
      positional: () => this.params,
      setPositional: args => { this.params = args },
      getStatus: () => this.status,
      describe: async name => {
        if (this.state.aliases.has(name)) return { kind: 'alias' }
        if (sharedBuiltinNames.has(name)) return { kind: 'builtin' }
        if (this.state.functions.has(name)) return { kind: 'function' }
        return this.files.has(`/bin/${name}`) ? { kind: 'file', path: `/bin/${name}` } : undefined
      },
      runArgv: argv => this.run(argv.join(' ')),
    }
  }

  private async command(words: string[]): Promise<number> {
    const [name = '', ...args] = words
    this.onCommand?.(words)
    if (this.shared) {
      const assignment = /^([A-Za-z_]\w*)=(.*)$/.exec(name)
      if (assignment) { this.state.set(assignment[1] as string, assignment[2] as string); return 0 }
      if (name === 'echo') {
        this.out.push(args.map(word => word.replace(/\$(\w+|\?)/g, (_, key: string) => key === '?' ? String(this.status) : (this.state.lookup(key) ?? ''))).join(' '))
        return 0
      }
    }
    if (this.shared && sharedBuiltinNames.has(name)) {
      return await runSharedBuiltin(this.builtinHost(), name, args, {
        write: text => { this.out.push(text) },
        writeln: text => { this.out.push(text) },
        writeErr: text => { this.errors.push(text) },
        writelnErr: text => { this.errors.push(text) },
        readLine: async () => this.stdin.shift(),
      })
    }
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
