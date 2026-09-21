/**
  * @experimental
  * @author Jay Mathis <code@mathis.network> (https://github.com/mathiscode)
  * 
  * The Shell class handles the Terminal environment and interaction with the Kernel.
  * 
 */

import path from 'path'
import { parse } from 'smol-toml'
import { bindContext } from '@zenfs/core'
import type { BoundContext, Credentials } from '@zenfs/core'
import { Signal } from '@zenfs/linux'
import type {
  Filesystem, Job, JobProcessHandle, JobStatus, KernelContext,
  Shell as IShell, ShellCreatePipeStream, ShellExecute, ShellOptions, ShellConfig as IShellConfig, Terminal as ITerminal, Users
} from '@ecmaos/types' // TODO: Consistency
import { ThemePresets } from '@ecmaos/types'

import { parseScript } from '#lib/shell-parser.ts'
import type { Command as ParsedCommand, Pipeline, Redirection, Script } from '#lib/shell-parser.ts'
import { parseStatements } from '#lib/control-flow-parser.ts'
import type { CaseStatement, ForStatement, IfStatement, Statement, WhileStatement } from '#lib/control-flow-parser.ts'
import { expandWord } from '#lib/expand-variables.ts'
import { runTrueBuiltin, trueBuiltinNameFor } from '#lib/shell-builtins.ts'

/** Internal unwind signals for `break`/`continue` inside `Shell.executeStatements`'s loop nodes. */
class BreakSignal extends Error {}
class ContinueSignal extends Error {}

/**
 * A tracked pipeline job. See `@ecmaos/types`' `Job` for the field-by-field contract; this class
 * only adds the bookkeeping `Shell` needs to resolve `done` once every stage settles and to mark
 * itself `done` with the right exit codes exactly once.
 */
class JobImpl implements Job {
  id: number
  commandLine: string
  status: JobStatus = 'running'
  exitCodes?: number[]
  processes: JobProcessHandle[] = []
  background: boolean
  /**
   * Assigned by `Shell.createJob` right after construction, once `runPipeline` has actually been
   * started against this job -- not in the constructor, so `runPipeline` can close over `this` and
   * push process handles onto `processes` as they appear while it's still running.
   */
  done!: Promise<number[]>

  constructor(id: number, commandLine: string, background: boolean) {
    this.id = id
    this.commandLine = commandLine
    this.background = background
  }
}

const DefaultShellPath = '$HOME/bin:/bin:/usr/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/sbin'
const DefaultShellOptions = {
  cwd: '/',
  env: {
    PATH: DefaultShellPath,
    SHELL: 'ecmaos',
    TERM: 'xterm.js',
    USER: 'root',
    HOME: '/root',
  }
}

/**
  * @experimental
  * @author Jay Mathis <code@mathis.network> (https://github.com/mathiscode)
  * 
  * The Shell class handles the Terminal environment and interaction with the Kernel.
  * 
 */
export class Shell implements IShell {
  private _createPipeStream: ShellCreatePipeStream
  private _ctx: KernelContext
  private _cwd: string
  private _env: Map<string, string>
  private _execute: ShellExecute
  private _filesystem: Filesystem
  private _id: string = crypto.randomUUID()
  private _terminal: ITerminal
  private _terminalWriter?: WritableStreamDefaultWriter<Uint8Array>
  private _tty: number
  private _users: Users

  /** `name() { ... }` / `function name { ... }` bodies registered by `executeStatements`. */
  private _functions = new Map<string, Statement[]>()
  /**
   * `local` overlays pushed per function call: each frame is checked before falling through to
   * `_env` on read, and `local NAME=VALUE` writes only ever touch the top frame. Empty outside a
   * function call, so top-level `env.get`/`env.set` behavior is completely unchanged by this.
   */
  private _localScopes: Map<string, string>[] = []
  /** `set -e` / `set -u` / `set -o pipefail`, off by default (matches ecmaOS's prior behavior). */
  private _shellOptions = { errexit: false, nounset: false, pipefail: false }

  /**
   * All jobs this shell has ever launched, insertion order (oldest first), keyed by job number.
   * Entries are never removed automatically -- `jobs` in a real shell keeps showing a `Done` job
   * until the next prompt reaps it; this implementation just keeps it, which `listJobs()` callers
   * (the `jobs` coreutil) can filter/trim for display if that behavior is ever wanted.
   */
  private _jobs: JobImpl[] = []
  private _nextJobId = 1
  /**
   * The job currently occupying the foreground, if any. Simplified single-foreground-process model:
   * `@zenfs/linux` has no process-group concept, so this is one `Job` reference, not a real pgid.
   * Set when a pipeline starts running in the foreground (`execute()`'s non-`&` path), cleared when
   * it finishes; a job moved to the background (via trailing `&`, or `bg`) is never foreground here.
   */
  private _foregroundJob: Job | undefined

  public readonly config: ShellConfig

  public credentials: Credentials = { uid: 0, gid: 0, suid: 0, sgid: 0, euid: 0, egid: 0, groups: [] }
  public context: BoundContext = bindContext({ root: '/', pwd: '/', credentials: this.credentials })

  get cwd() { return this._cwd }
  set cwd(path: string) { this._cwd = path === '/' ? path : path.endsWith('/') ? path.slice(0, -1) : path }
  get env() { return this._env }
  set env(env: Map<string, string>) { this._env = env; globalThis.process.env = { ...globalThis.process.env, ...Object.fromEntries(env) } }
  get envObject() { return Object.fromEntries(this._env) }
  get id() { return this._id }
  get terminal() { return this._terminal }
  get username() { return this._users.get(this.credentials.uid)?.username || 'root' }
  get tty() { return this._tty }
  get shellOptions() { return this._shellOptions }
  get functions() { return this._functions }
  get foregroundJob() { return this._foregroundJob }
  /** The real user registry -- needed by `su` (a true shell builtin, see `lib/shell-builtins.ts`). */
  get users() { return this._users }
  /** Translated strings -- needed by `su`'s error messages, the same way `resolveCommand` uses it. */
  get i18n() { return this._ctx.i18n }

  /**
   * Resolve a variable by name the way `local` scoping requires: the innermost active function
   * frame first, falling through to the shell's real environment. This is what `expandWord`'s
   * `lookup` is bound to everywhere a word is expanded, so `local`-declared variables shadow outer
   * ones exactly where a real shell would.
   */
  private lookupVariable(name: string): string | undefined {
    for (let i = this._localScopes.length - 1; i >= 0; i--) {
      const frame = this._localScopes[i] as Map<string, string>
      if (frame.has(name)) return frame.get(name)
    }
    return this._env.get(name)
  }

  /** `set NAME=VALUE`: writes to the innermost `local` frame if one is active, else the real env. */
  setVariable(name: string, value: string): void {
    const frame = this._localScopes[this._localScopes.length - 1]
    if (frame) frame.set(name, value)
    else this._env.set(name, value)
  }

  /** Declare `name` as local to the current function call, defaulting to '' until assigned. */
  declareLocal(name: string, value?: string): void {
    const frame = this._localScopes[this._localScopes.length - 1]
    if (!frame) throw new Error('local: can only be used inside a function')
    frame.set(name, value ?? '')
  }

  /** Apply `set -e` / `-u` / `-o pipefail` style flags. Matches the subset scripts here use. */
  applyShellOption(flag: 'errexit' | 'nounset' | 'pipefail', enabled: boolean): void {
    this._shellOptions[flag] = enabled
  }

  constructor(_options: ShellOptions & { tty?: number }) {
    const options = { ...DefaultShellOptions, ..._options }
    globalThis.shells?.set(this.id, this)

    this._tty = options.tty ?? 0
    this._cwd = options.cwd || localStorage.getItem(`cwd:${this.credentials.uid}`) || DefaultShellOptions.cwd
    this._env = new Map([...Object.entries(DefaultShellOptions.env), ...Object.entries(options.env)])
    this._ctx = options.context
    this._createPipeStream = options.createPipeStream
    this._execute = options.execute
    this._filesystem = options.filesystem
    this._users = options.users
    this._terminal = options.terminal as ITerminal
    this._terminalWriter = this._terminal?.stdout.getWriter() || new WritableStream().getWriter()
    this.config = new ShellConfig(this)

    process.env = Object.fromEntries(this._env)
  }

  /**
   * Loads environment variables from /etc/env and ~/.env
   */
  async loadEnvFile() {
    // Load global /etc/env first
    try {
      if (await this.context.fs.promises.exists('/etc/env')) {
        const globalContent = await this.context.fs.promises.readFile('/etc/env', 'utf-8')
        const globalEnvVars = this.parseEnvFile(globalContent)
        for (const [key, value] of Object.entries(globalEnvVars)) {
          this._env.set(key, value)
        }
      }
    } catch {}

    // Load user ~/.env second (overwrites global values)
    const home = this._env.get('HOME')
    if (!home) return

    const envFilePath = path.join(home, '.env')
    try {
      if (!await this.context.fs.promises.exists(envFilePath)) return

      const content = await this.context.fs.promises.readFile(envFilePath, 'utf-8')
      const envVars = this.parseEnvFile(content)
      for (const [key, value] of Object.entries(envVars)) {
        this._env.set(key, value)
      }

      process.env = Object.fromEntries(this._env)
    } catch {}
  }

  /**
   * Loads shell configuration from config files and applies to terminal
   */
  async loadConfig() {
    await this.config.load()
    this.terminal.updateConfig()
  }

  /**
   * Parses environment variables from a string
   */
  parseEnvFile(content: string): Record<string, string> {
    const envVars: Record<string, string> = {}
    const lines = content.split('\n')

    for (const line of lines) {
      const trimmed = line.trim()
      
      if (!trimmed || trimmed.startsWith('#')) continue

      const match = trimmed.match(/^([^=#\s]+)=(.*)$/)
      if (match) {
        const [, key, value] = match
        if (!key || !value) continue
        let parsedValue = value.trim()

        if ((parsedValue.startsWith('"') && parsedValue.endsWith('"')) ||
            (parsedValue.startsWith("'") && parsedValue.endsWith("'")))
          parsedValue = parsedValue.slice(1, -1)

        envVars[key] = parsedValue
      }
    }

    return envVars
  }
  
  /**
   * Attaches a terminal to the shell
   */
  attach(terminal: ITerminal) {
    if (this._terminalWriter) {
      try { this._terminalWriter.releaseLock() } catch {}
    }
    
    this._terminal = terminal
    this._terminalWriter = terminal.stdout.getWriter()
  }

  /**
   * Clears positional parameters
   */
  clearPositionalParameters() {
    for (const key of this.env.keys()) {
      if (!isNaN(parseInt(key))) this.env.delete(key)
    }
  }

  /**
   * Parses and executes command substitutions in the format $(command)
   * Supports nested substitutions
   */
  private async parseCommandSubstitution(commandLine: string): Promise<string> {
    let result = commandLine
    let hasSubstitution = true
    
    // Process substitutions iteratively to handle nested cases
    while (hasSubstitution) {
      hasSubstitution = false
      const matches: Array<{ match: string; command: string; start: number; end: number }> = []
      
      // Find all $(...) patterns by tracking parentheses depth
      // Need to track quote state to skip substitutions inside single quotes
      let inSingleQuote = false
      let inDoubleQuote = false
      let escaped = false
      
      for (let i = 0; i < result.length - 1; i++) {
        const char = result[i]
        
        // Track quote state
        if (escaped) {
          escaped = false
          continue
        }
        
        if (char === '\\') {
          escaped = true
          continue
        }
        
        if (char === "'" && !inDoubleQuote) {
          inSingleQuote = !inSingleQuote
        } else if (char === '"' && !inSingleQuote) {
          inDoubleQuote = !inDoubleQuote
        }
        
        // Only process substitutions outside single quotes. `$((` is arithmetic expansion
        // (`expand-variables.ts`'s job, applied later in `prepareCommand`/`tryExecuteAssignment`),
        // not command substitution -- without this guard, `$((I + 1))` gets misread as `$(...)`
        // with body `(I + 1)`, executed as a command, and silently replaced with '' when it fails.
        if (!inSingleQuote && char === '$' && result[i + 1] === '(' && result[i + 2] !== '(') {
          // Found start of substitution, find matching closing paren
          let depth = 1
          let j = i + 2
          let subInString = false
          let subStringChar = ''
          let subEscaped = false
          
          while (j < result.length && depth > 0) {
            const subChar = result[j]
            
            if (subEscaped) {
              subEscaped = false
              j++
              continue
            }
            
            if (subChar === '\\') {
              subEscaped = true
              j++
              continue
            }
            
            if (!subInString && (subChar === '"' || subChar === "'")) {
              subInString = true
              subStringChar = subChar
            } else if (subInString && subChar === subStringChar) {
              subInString = false
              subStringChar = ''
            } else if (!subInString) {
              if (subChar === '(') {
                depth++
              } else if (subChar === ')') {
                depth--
              }
            }
            
            j++
          }
          
          if (depth === 0) {
            // Found complete substitution
            hasSubstitution = true
            const command = result.slice(i + 2, j - 1)
            matches.push({
              match: result.slice(i, j),
              command,
              start: i,
              end: j
            })
            i = j - 1 // Skip past this substitution
          }
        }
      }
      
      // Process matches from right to left to preserve indices
      matches.reverse()
      
      for (const { command, start, end } of matches) {
        // Execute the command substitution
        const output = await this.executeCommandSubstitution(command)
        
        // Replace the substitution with the output
        // Ensure the output is treated as a separate word by checking boundaries
        const beforeChar = start > 0 ? result[start - 1] : ' '
        const afterChar = end < result.length ? result[end] : ' '
        const needsSpaceBefore = beforeChar !== ' ' && beforeChar !== '\t' && beforeChar !== '\n'
        const needsSpaceAfter = afterChar !== ' ' && afterChar !== '\t' && afterChar !== '\n' && afterChar !== ''
        
        const replacement = (needsSpaceBefore ? ' ' : '') + output + (needsSpaceAfter ? ' ' : '')
        result = result.slice(0, start) + replacement + result.slice(end)
      }
    }
    
    return result
  }

  /**
   * Executes a command substitution and returns its output
   */
  private async executeCommandSubstitution(command: string): Promise<string> {
    // Create a temporary stream to capture output
    const chunks: Uint8Array[] = []
    const outputStream = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk)
      }
    })
    
    // Create a dummy error stream (we'll ignore stderr for substitutions)
    const errorStream = new WritableStream<Uint8Array>({
      write() {
        // Ignore stderr in command substitutions
      }
    })
    
    // Execute the command
    try {
      // Parse the command to get command name and args
      const script = parseScript(command)
      const parsedCommand = script.stages[0]?.pipeline.commands[0]
      const [commandName, ...rawWords] = parsedCommand?.words ?? []
      if (!commandName) return ''

      const args = await this.expandGlobWords(rawWords, parsedCommand?.wordsQuoted.slice(1) ?? [])
      const finalCommand = await this.resolveCommand(commandName)
      if (!finalCommand) return ''
      
      // Execute the command
      await this._execute({
        command: finalCommand,
        args,
        shell: this,
        terminal: this._terminal,
        stdin: new ReadableStream<Uint8Array>(),
        stdout: outputStream,
        stderr: errorStream
      })
      
      // Combine all chunks and convert to string
      const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
      const combined = new Uint8Array(totalLength)
      let offset = 0
      for (const chunk of chunks) {
        combined.set(chunk, offset)
        offset += chunk.length
      }
      
      // Decode and trim trailing newlines (standard shell behavior)
      const output = new TextDecoder().decode(combined)
      return output.replace(/\n+$/, '')
    } catch {
      return ''
    }
  }

  /**
   * Expands tilde (~) to the user's home directory
   * Handles ~, ~/, and ~/path patterns
   * Respects quotes: no expansion inside single quotes, expansion inside double quotes
   */
  expandTilde(input: string): string {
    const home = this._env.get('HOME')
    if (!home) return input

    let result = ''
    let inSingleQuote = false
    let inDoubleQuote = false
    let escaped = false
    let i = 0

    while (i < input.length) {
      const char = input[i]
      const nextChar = input[i + 1]

      if (escaped) {
        result += char
        escaped = false
        i++
        continue
      }

      if (char === '\\') {
        escaped = true
        result += char
        i++
        continue
      }

      if (char === "'" && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote
        result += char
        i++
        continue
      }

      if (char === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote
        result += char
        i++
        continue
      }

      // Only expand tilde outside single quotes
      // Tilde can be expanded inside double quotes (standard shell behavior)
      if (!inSingleQuote && char === '~') {
        // Check if this is a word boundary (start of string, after whitespace, or after =)
        const isWordStart = i === 0 || (i > 0 && /\s|=/.test(input[i - 1] ?? ' '))
        
        if (isWordStart) {
          // Check if it's ~/path or just ~
          if (nextChar === '/' || nextChar === undefined || /\s/.test(nextChar)) {
            result += home
            i++
            continue
          }
        }
      }

      result += char
      i++
    }

    return result
  }

  /**
   * Expands a glob pattern to matching file paths
   * @param pattern - Glob pattern (e.g., "bin/*", "*.js")
   * @returns Array of matching file paths
   */
  private async expandGlob(pattern: string): Promise<string[]> {
    if (!pattern.includes('*') && !pattern.includes('?')) {
      return [pattern]
    }

    const lastSlashIndex = pattern.lastIndexOf('/')
    const searchDir = lastSlashIndex !== -1
      ? path.resolve(this.cwd, pattern.substring(0, lastSlashIndex + 1))
      : this.cwd
    const globPattern = lastSlashIndex !== -1
      ? pattern.substring(lastSlashIndex + 1)
      : pattern

    try {
      const entries = await this.context.fs.promises.readdir(searchDir)
      const regexPattern = globPattern
        .replace(/\./g, '\\.')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.')
      const regex = new RegExp(`^${regexPattern}$`)
      
      const matches = entries.filter(entry => regex.test(entry))
      
      if (lastSlashIndex !== -1) {
        const dirPart = pattern.substring(0, lastSlashIndex + 1)
        return matches.map(match => dirPart + match)
      }
      return matches
    } catch {
      // If directory doesn't exist or can't be read, return empty array
      // This matches standard shell behavior where non-matching globs are passed as-is
      return []
    }
  }

  /**
   * Expands glob patterns in a command's words, in place of the file(s) they match.
   * A word only globs if it is not fully quoted (`echo *.txt` globs; `echo "*.txt"` does not),
   * matching `parseScript`'s per-word quote tracking.
   * @param words - The command's words, already quote-stripped by the parser
   * @param wordsQuoted - Whether each word (by index) was fully quoted
   * @returns The words with any eligible glob patterns expanded to matching paths
   */
  private async expandGlobWords(words: string[], wordsQuoted: boolean[]): Promise<string[]> {
    const expanded: string[] = []
    for (let i = 0; i < words.length; i++) {
      const word = words[i] as string
      const quoted = wordsQuoted[i] ?? false
      if (!quoted && (word.includes('*') || word.includes('?'))) {
        const matches = await this.expandGlob(word)
        expanded.push(...(matches.length > 0 ? matches : [word]))
      } else {
        expanded.push(word)
      }
    }
    return expanded
  }

  /**
   * Expands history bang syntax (e.g., !10) to the corresponding command from history
   * Supports patterns like !N where N is a history line number (1-indexed)
   * Recursively expands history bangs until no more expansions are possible
   */
  private async expandHistoryBang(commandLine: string): Promise<string> {
    const home = this._env.get('HOME') || '/root'
    const historyPath = path.join(home, '.history')

    try {
      if (!await this.context.fs.promises.exists(historyPath)) {
        return commandLine
      }

      const content = await this.context.fs.promises.readFile(historyPath, 'utf-8')
      const historyLines = content.split('\n').filter(line => line.length > 0)

      if (historyLines.length === 0) {
        return commandLine
      }

      let result = commandLine
      let hasExpansion = true
      const maxIterations = 100
      let iterations = 0

      while (hasExpansion && iterations < maxIterations) {
        iterations++
        hasExpansion = false
        let inSingleQuote = false
        let inDoubleQuote = false
        let escaped = false
        let i = 0

        while (i < result.length) {
          const char = result[i]

          if (escaped) {
            escaped = false
            i++
            continue
          }

          if (char === '\\') {
            escaped = true
            i++
            continue
          }

          if (char === "'" && !inDoubleQuote) {
            inSingleQuote = !inSingleQuote
            i++
            continue
          }

          if (char === '"' && !inSingleQuote) {
            inDoubleQuote = !inDoubleQuote
            i++
            continue
          }

          if (!inSingleQuote && char === '!') {
            const nextChar = result[i + 1]
            
            if (nextChar && /[0-9]/.test(nextChar)) {
              let numStr = ''
              let j = i + 1
              
              while (j < result.length) {
                const char = result[j]
                if (char && /[0-9]/.test(char)) {
                  numStr += char
                  j++
                } else {
                  break
                }
              }

              const historyNum = parseInt(numStr, 10)
              
              if (historyNum >= 1 && historyNum <= historyLines.length) {
                const historyCommand = historyLines[historyNum - 1]
                if (historyCommand) {
                  result = result.slice(0, i) + historyCommand + result.slice(j)
                  hasExpansion = true
                  break
                }
              }
              
              throw new Error(`!${historyNum}: event not found`)
            }
          }

          i++
        }
      }

      if (iterations >= maxIterations) {
        throw new Error('History expansion exceeded maximum iterations (possible circular reference)')
      }

      return result
    } catch (error) {
      if (error instanceof Error && (error.message.includes('event not found') || error.message.includes('maximum iterations'))) {
        throw error
      }
      return commandLine
    }
  }

  /**
   * Builds the (fd -> writable stream) map for one pipeline command, following its redirections in
   * order so later ones win — the same left-to-right rule real shells apply (`> f 2>&1` and
   * `2>&1 > f` mean different things, and both are expressible this way).
   *
   * fd 1 and fd 2 default to the terminal (or the pipe, mid-pipeline) when nothing redirects them;
   * any other fd a script names is left for a caller that cares about it — this shell doesn't open
   * arbitrary fds yet.
   */
  private async buildOutputStreams(
    redirections: Redirection[],
    isLastCommand: boolean,
    pipeWritable: WritableStream<Uint8Array> | undefined
  ): Promise<{ stdout: WritableStream<Uint8Array>, stderr: WritableStream<Uint8Array> }> {
    const fdStreams = new Map<number, WritableStream<Uint8Array>>()
    const fdFiles = new Map<number, { path: string, append: boolean }>()

    const defaultFor = (fd: number): WritableStream<Uint8Array> => {
      const existing = fdStreams.get(fd)
      if (existing) return existing
      const created = fd === 1
        ? (isLastCommand ? this.createTerminalOutputStream() : (pipeWritable as WritableStream<Uint8Array>))
        : this.createTerminalErrorStream()
      fdStreams.set(fd, created)
      return created
    }

    for (const redirection of redirections) {
      if (redirection.type === '>&') {
        if (redirection.targetIsFd) {
          const sourceFd = Number(redirection.target)
          // Resolve what the source fd points to right now, so `2>&1 > f` and `> f 2>&1` differ
          const sourceFile = fdFiles.get(sourceFd)
          if (sourceFile) {
            fdStreams.set(redirection.fd, this.createFileWriteStream(sourceFile.path, sourceFile.append))
            fdFiles.set(redirection.fd, sourceFile)
          } else {
            fdStreams.set(redirection.fd, defaultFor(sourceFd))
            fdFiles.delete(redirection.fd)
          }
        }
        continue
      }

      if (redirection.type === '>' || redirection.type === '>>') {
        const targetPath = path.resolve(this.cwd, redirection.target)
        const append = redirection.type === '>>'
        fdStreams.set(redirection.fd, this.createFileWriteStream(targetPath, append))
        fdFiles.set(redirection.fd, { path: targetPath, append })
      }
    }

    // Two fds that both resolved to the same underlying file need one shared, serialized writer,
    // not two independent ones racing each other -- this is what &> and 2>&1 > f actually need.
    const stdoutFile = fdFiles.get(1)
    const stderrFile = fdFiles.get(2)
    if (stdoutFile && stderrFile && stdoutFile.path === stderrFile.path) {
      const shared = this.createSharedFileStreams(stdoutFile.path, stdoutFile.append || stderrFile.append)
      fdStreams.set(1, shared.stdout)
      fdStreams.set(2, shared.stderr)
    }

    return {
      stdout: defaultFor(1),
      stderr: defaultFor(2)
    }
  }

  /**
   * Resolves one pipeline stage's words (substitution, history-bang, tilde, variables, arithmetic,
   * glob) into a runnable command. Single-quoted words are exempt from variable/arithmetic
   * expansion the same way they are from globbing (`wordsQuoted`, tracked by the parser) --
   * `echo '$HOME'` must print the literal text, not the expanded path.
   */
  private async prepareCommand(command: ParsedCommand): Promise<{ finalCommand: string, args: string[] }> {
    const words = await Promise.all(command.words.map(async (word, index) => {
      let expanded = await this.parseCommandSubstitution(word)
      expanded = await this.expandHistoryBang(expanded)
      expanded = this.expandTilde(expanded)
      if (!command.wordsQuoted[index]) expanded = expandWord(expanded, (name) => this.lookupVariable(name))
      if (this._shellOptions.nounset) this.assertNoUnsetReferences(word)
      return expanded
    }))

    const [commandName, ...rawWords] = words
    if (!commandName) {
      throw new Error(this._ctx.i18n.t('commandNotFound', { ns: 'kernel', command: command.words.join(' ') }))
    }

    const args = await this.expandGlobWords(rawWords, command.wordsQuoted.slice(1))
    const finalCommand = await this.resolveCommand(commandName)
    if (!finalCommand) {
      throw new Error(this._ctx.i18n.t('commandNotFound', { ns: 'kernel', command: commandName }))
    }

    return { finalCommand, args }
  }

  /**
   * `set -u`: throws if `original` referenced a plain `$VAR`/`${VAR}` whose name resolves to
   * `undefined`. Only plain references count -- `${VAR:-default}`/`${VAR:+alt}` are explicitly
   * about tolerating an unset variable, so they're exempt, matching bash's own `set -u` semantics.
   */
  private assertNoUnsetReferences(original: string): void {
    const pattern = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(original))) {
      const name = match[1] ?? match[2]
      if (name && this.lookupVariable(name) === undefined) {
        throw new Error(`${name}: unbound variable`)
      }
    }
  }

  /**
   * Runs one pipeline (`a | b | c`), wiring each stage's stdout to the next's stdin, and returns
   * each stage's exit code in order -- `${PIPESTATUS[@]}`, not "last non-zero wins".
   *
   * @param job - When given, every stage that produces a real `@zenfs/linux` Process (only the
   * `js`/`node` binfmt path today) registers its handle on `job.processes` as soon as it exists,
   * via `onProcess` -- this is how a backgrounded or foregrounded pipeline becomes signalable by
   * `^C`/`^Z`/`fg`/`bg` before it has finished running.
   */
  private async runPipeline(pipeline: Pipeline, job?: JobImpl): Promise<number[]> {
    const currentCmd = this._terminal.cmd
    try {
      const stages: Array<{
        finalCommand: string
        args: string[]
        stdin: ReadableStream<Uint8Array>
        stdinIsTTY: boolean
        stdout: WritableStream<Uint8Array>
        stdoutIsTTY: boolean
        stderr: WritableStream<Uint8Array>
      }> = []

      let prevReadable: ReadableStream<Uint8Array> | undefined

      for (let i = 0; i < pipeline.commands.length; i++) {
        const command = pipeline.commands[i] as ParsedCommand
        const { finalCommand, args } = await this.prepareCommand(command)
        const isFirstCommand = i === 0
        const isLastCommand = i === pipeline.commands.length - 1

        let stdin: ReadableStream<Uint8Array>
        let stdinIsTTY = false
        const inputRedirect = command.redirections.find(r => r.type === '<' && r.fd === 0)
        if (isFirstCommand && inputRedirect) {
          const sourcePath = path.resolve(this.cwd, inputRedirect.target)
          if (!await this.context.fs.promises.exists(sourcePath)) {
            throw new Error(`File not found: ${sourcePath}`)
          }
          stdin = this.createFileReadStream(sourcePath, this.env, this._filesystem)
        } else if (isFirstCommand) {
          stdin = this._terminal.getInputStream()
          stdinIsTTY = true
        } else {
          if (!prevReadable) throw new Error('Pipeline error: missing previous stream')
          stdin = prevReadable
        }

        let pipeWritable: WritableStream<Uint8Array> | undefined
        if (!isLastCommand) {
          const pipe = this._createPipeStream()
          pipeWritable = pipe.writable
          prevReadable = pipe.readable
        }

        const { stdout, stderr } = await this.buildOutputStreams(command.redirections, isLastCommand, pipeWritable)
        const stdoutIsTTY = isLastCommand && !command.redirections.some(r => (r.type === '>' || r.type === '>>' || r.type === '>&') && r.fd === 1)
        stages.push({ finalCommand, args, stdin, stdinIsTTY, stdout, stdoutIsTTY, stderr })
      }

      const results = await Promise.all(stages.map(({ finalCommand, args, stdin, stdinIsTTY, stdout, stdoutIsTTY, stderr }) =>
        this._execute({
          command: finalCommand,
          args,
          shell: this,
          terminal: this._terminal,
          stdin,
          stdinIsTTY,
          stdout,
          stdoutIsTTY,
          stderr,
          onProcess: job ? (process => { job.processes.push(process) }) : undefined,
          foreground: job ? !job.background : true
        })
      ))

      return pipeline.negated ? results.map(code => code === 0 ? 1 : 0) : results
    } catch (error) {
      this._terminal.restoreCommand(currentCmd)
      throw error
    }
  }

  /** All tracked jobs, oldest first. See `_jobs`'s doc comment for retention behavior. */
  listJobs(): Job[] {
    return [...this._jobs]
  }

  /**
   * The most recently started job still worth targeting by a bare job spec -- background or
   * stopped, never a plain foreground command that already ran to completion (`jobs`/`fg`/`bg`
   * themselves included, since they always run in the foreground). This is what bash calls the
   * "current job" (`%%`/`%+`), and what bare `fg`/`bg` (no argument) target.
   */
  private get currentJob(): Job | undefined {
    for (let i = this._jobs.length - 1; i >= 0; i--) {
      const job = this._jobs[i]
      if (job && (job.background || job.status === 'stopped')) return job
    }
    return undefined
  }

  /**
   * Resolves a job spec the way bash does: `%N`, `%%`/`%+` (current == most recently started
   * background/stopped job), `%-` (previous such job), a bare pid (matched against any job's
   * process handles), or no argument at all (also the current job, matching bare `fg`/`bg`).
   * Returns `undefined` if nothing matches.
   */
  getJob(spec?: string): Job | undefined {
    if (!spec) return this.currentJob

    if (spec.startsWith('%')) {
      const rest = spec.slice(1)
      if (rest === '' || rest === '%' || rest === '+') return this.currentJob
      if (rest === '-') {
        const backgroundable = this._jobs.filter(job => job.background || job.status === 'stopped')
        return backgroundable[backgroundable.length - 2]
      }

      const id = Number(rest)
      if (!Number.isNaN(id)) return this._jobs.find(job => job.id === id)

      // %name: the most recent job whose command line starts with `name`, e.g. `%sleep`
      return [...this._jobs].reverse().find(job => job.commandLine.startsWith(rest))
    }

    const pid = Number(spec)
    if (!Number.isNaN(pid)) return this._jobs.find(job => job.processes.some(process => process.pid === pid))

    return undefined
  }

  /**
   * Resumes a stopped job's real processes with `SIGCONT`, or promotes an already-running
   * background job to the foreground -- either way, waits for it to finish. A job with no real
   * process handles (a pure-coreutil pipeline) has nothing to send `SIGCONT` to, but is still
   * waited on and reported the same way.
   */
  async fg(spec?: string): Promise<number | undefined> {
    const job = this.getJob(spec)
    if (!job) return undefined

    this._terminal.writeln(job.commandLine)

    if (job.status === 'stopped') {
      for (const process of job.processes) process.kill(Signal.CONT)
      job.status = 'running'
    }

    // Reclaim the controlling terminal for this job's real process(es) -- it gave it up (or never
    // had it) while backgrounded/stopped; see `JobProcessHandle.setForeground`'s doc comment.
    for (const process of job.processes) process.setForeground?.(true)

    this._foregroundJob = job
    try {
      const codes = await job.done
      return codes[codes.length - 1]
    } finally {
      if (this._foregroundJob === job) this._foregroundJob = undefined
    }
  }

  /** Resumes a stopped job with `SIGCONT` in the background, without waiting for it. */
  bg(spec?: string): Job | undefined {
    const job = this.getJob(spec)
    if (!job || job.status !== 'stopped') return job

    for (const process of job.processes) process.kill(Signal.CONT)
    for (const process of job.processes) process.setForeground?.(false)
    job.status = 'running'
    job.background = true
    this._terminal.writeln(`[${job.id}]+ ${job.commandLine} &`)
    return job
  }

  /**
   * Waits for one job/pid, or (with no argument) every currently-running/stopped background job,
   * to finish. Mirrors bash's `wait`: the single-target form returns that target's exit code; the
   * no-argument form waits for all of them and returns `undefined` (bash's `wait` with no args
   * always exits 0 unless interrupted, which this shell has no equivalent signal for yet).
   */
  async wait(spec?: string): Promise<number | undefined> {
    if (!spec) {
      await Promise.all(this._jobs.filter(job => job.status !== 'done').map(job => job.done))
      return undefined
    }

    const job = this.getJob(spec)
    if (!job) return undefined

    const codes = await job.done
    return codes[codes.length - 1]
  }

  /**
   * A pipeline whose sole command names a registered function is dispatched to `callFunction`
   * instead of `runPipeline`/`_execute` -- functions are shell-local, not real executables, and
   * have no `finalCommand` a binfmt could resolve. Piping into/out of a function, or calling one
   * as a non-final pipeline stage, is out of scope here (real shells restrict this too without a
   * subshell), so only a single-command pipeline qualifies.
   */
  private functionNameFor(pipeline: Pipeline): string | undefined {
    if (pipeline.commands.length !== 1) return undefined
    const name = pipeline.commands[0]?.words[0]
    return name && this._functions.has(name) ? name : undefined
  }

  /**
   * A pipeline whose sole command names a true shell builtin (`cd`, `export`, ... -- see
   * `lib/shell-builtins.ts`'s own doc comment for why these are permanent, not migration-pending).
   * Same single-command restriction as `functionNameFor`, for the same reason: piping into/out of
   * something that mutates this shell's own state isn't meaningful the way it is for a real process.
   */
  private trueBuiltinNameFor(pipeline: Pipeline): string | undefined {
    if (pipeline.commands.length !== 1) return undefined
    return trueBuiltinNameFor(pipeline.commands[0]?.words[0])
  }

  /** Calls a registered function: its own `local` scope, positional parameters set to `argv`. */
  private async callFunction(name: string, argv: string[]): Promise<number> {
    const body = this._functions.get(name)
    if (!body) throw new Error(`${name}: function not found`)

    const savedPositional = new Map<string, string>()
    for (const key of this.env.keys()) if (!isNaN(parseInt(key))) savedPositional.set(key, this.env.get(key) as string)

    this._localScopes.push(new Map())
    // `setPositionalParameters` sets $0 to its first element (matching the device-CLI convention
    // at Kernel.executeDevice, where $0 is the invoked name and $1.. are the real arguments) -- so
    // the function's own name goes first, keeping $1 as the caller's first argument like bash.
    this.setPositionalParameters([name, ...argv])
    try {
      return await this.executeStatements(body)
    } finally {
      this._localScopes.pop()
      this.clearPositionalParameters()
      for (const [key, value] of savedPositional) this.env.set(key, value)
    }
  }

  /**
   * `VAR=value` (and `VAR=` for an empty assignment) as a bare statement -- not `env VAR=value cmd`,
   * which already works today by other means, but a whole line whose only content is an assignment.
   * A real shell recognizes this at the parser level (it's not a command at all, and `=` is not an
   * operator); recognizing it here, at the same point `execute` decides what kind of line this is,
   * avoids teaching `shell-parser.ts` a whole new statement kind for something that never pipes,
   * redirects, or chains with `&&`. Returns the exit code if `line` was an assignment, else
   * `undefined` so `execute` falls through to normal pipeline parsing.
   */
  private async tryExecuteAssignment(line: string): Promise<number | undefined> {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!match) return undefined

    const [, name, rawValue] = match as unknown as [string, string, string]
    let value = await this.parseCommandSubstitution(rawValue)
    value = this.expandTilde(value)
    value = expandWord(value, (varName) => this.lookupVariable(varName))
    // Strip one layer of surrounding quotes the way word-splitting elsewhere in this file does --
    // `X="a b"` should store `a b`, not `"a b"`.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }

    this.setVariable(name, value)
    return 0
  }

  /**
   * Executes a command line: comment-stripped, parsed into a `Script`, and walked stage by stage
   * honoring `;`, `&&`, `||`, and `&`. A stage whose trailing operator is `&` is registered as a
   * background `Job` (see `@ecmaos/types`' `Job`) and *not* awaited here -- `execute()` returns to
   * the caller (the prompt) immediately after printing `[<job-id>] <pid>`, the same way bash reports
   * a backgrounded pipeline. Every other stage runs in the foreground: tracked as `foregroundJob`
   * for the duration (so `^C`/`^Z` in `Terminal.keyHandler` have something to signal) and awaited
   * before the next stage of the line runs. `set -e` aborts the whole line on the first foreground
   * stage that fails without being consumed by `&&`/`||`/negation; `set -o pipefail` changes a
   * pipeline's reported exit code to its last *non-zero* stage rather than strictly its last stage.
   * A backgrounded stage's exit code never affects `$?`/`errexit`/`&&`/`||` on this line -- exactly
   * like bash, which reports it only later via `wait`/the "Done" line in `jobs`.
   */
  async execute(line: string) {
    const lineWithoutComments = line.split('#')[0]?.trim()
    if (!lineWithoutComments) return 0

    const assignmentExitCode = await this.tryExecuteAssignment(lineWithoutComments)
    if (assignmentExitCode !== undefined) return assignmentExitCode

    const script: Script = parseScript(lineWithoutComments)
    let lastPipelineExit = 0
    let skipNext = false

    for (const stage of script.stages) {
      if (skipNext) {
        skipNext = false
      } else if (stage.operator === '&') {
        this.runInBackground(stage.pipeline)
      } else {
        const builtinName = this.trueBuiltinNameFor(stage.pipeline)
        const fnName = builtinName ? undefined : this.functionNameFor(stage.pipeline)
        let pipeStatus: number[]

        if (builtinName) {
          // True builtins (see `lib/shell-builtins.ts`'s own doc comment) always win over a
          // same-named function or real file, the same way bash's POSIX "special builtins"
          // (cd/export/set/...) can never be shadowed -- checked before `functionNameFor` so a
          // script that happens to define e.g. `function cd { ... }` can't silently break `cd`.
          const command = stage.pipeline.commands[0] as ParsedCommand
          const args = await this.expandGlobWords(command.words.slice(1), command.wordsQuoted.slice(1))
          const code = await runTrueBuiltin(this, builtinName, args)
          pipeStatus = [stage.pipeline.negated ? (code === 0 ? 1 : 0) : code]
        } else if (fnName) {
          const command = stage.pipeline.commands[0] as ParsedCommand
          const args = await this.expandGlobWords(command.words.slice(1), command.wordsQuoted.slice(1))
          const code = await this.callFunction(fnName, args)
          pipeStatus = [stage.pipeline.negated ? (code === 0 ? 1 : 0) : code]
        } else {
          pipeStatus = await this.runForeground(stage.pipeline)
        }

        lastPipelineExit = this._shellOptions.pipefail
          ? ([...pipeStatus].reverse().find(code => code !== 0) ?? 0)
          : pipeStatus[pipeStatus.length - 1] ?? 0

        this.env.set('PIPESTATUS', pipeStatus.join(' '))
        this.env.set('?', String(lastPipelineExit))

        if (this._shellOptions.errexit && lastPipelineExit !== 0 && stage.operator !== '&&' && stage.operator !== '||') {
          return lastPipelineExit
        }
      }

      // && only runs its next stage on success; || only on failure. A skipped stage's own trailing
      // operator still governs what comes after it, so `a && b || c` runs c when a fails too.
      if (stage.operator === '&&' && lastPipelineExit !== 0) skipNext = true
      else if (stage.operator === '||' && lastPipelineExit === 0) skipNext = true
    }

    return lastPipelineExit
  }

  /**
   * Runs a pipeline in the foreground: registered as `foregroundJob` for the duration so `^C`/`^Z`
   * have a real process to signal, cleared unconditionally once it settles (success, failure, or a
   * thrown error) so a later `^C` at an idle prompt doesn't find a stale foreground job.
   */
  private async runForeground(pipeline: Pipeline): Promise<number[]> {
    const job = this.createJob(pipeline, false, /* rethrow */ true)
    this._foregroundJob = job
    try {
      return await job.done
    } finally {
      if (this._foregroundJob === job) this._foregroundJob = undefined
    }
  }

  /**
   * Launches a pipeline in the background (`&`): registers a `Job`, prints bash's `[<id>] <pid>`
   * line, and does *not* await it here -- `job.done` is what `wait`/`jobs` observe later.
   */
  private runInBackground(pipeline: Pipeline): void {
    const job = this.createJob(pipeline, true, /* rethrow */ false)

    // Give the pipeline's first stage a tick to construct its real Process (if it has one) before
    // reporting the job's pid, matching bash's `[1] <pid>` -- falls back to the job id if the stage
    // never produces a real process handle (an all-coreutils pipeline has nothing to report here).
    queueMicrotask(() => {
      const pid = job.processes[0]?.pid
      this._terminal.writeln(`[${job.id}] ${pid ?? job.id}`)
    })
  }

  /**
   * Registers a new `Job` for `pipeline` and starts `runPipeline` against it as its `done`
   * executor. `job` is created first (with `processes: []`) specifically so `runPipeline` can push
   * real process handles onto it as they appear while it runs, rather than only after the fact.
   *
   * @param rethrow - Foreground jobs preserve `runPipeline`'s original behavior of propagating a
   * thrown error to `execute()`'s caller (there's still a caller around to see it). A backgrounded
   * job has nobody left to catch it once `execute()` has already returned control to the prompt, so
   * it's reported to the terminal directly and folded into `job.done` as a synthetic failure instead.
   */
  private createJob(pipeline: Pipeline, background: boolean, rethrow: boolean): JobImpl {
    const commandLine = pipeline.commands.map(command => command.words.join(' ')).join(' | ')
    const job = new JobImpl(this._nextJobId++, commandLine, background)
    const settle = (codes: number[]) => {
      job.exitCodes = codes
      job.status = 'done'
      return codes
    }

    job.done = rethrow
      ? this.runPipeline(pipeline, job).then(settle)
      : this.runPipeline(pipeline, job).then(settle).catch(error => {
          this._terminal.writeln(`${this.env.get('SHELL') || 'ecmaos'}: ${error instanceof Error ? error.message : String(error)}`)
          return settle([-1])
        })

    this._jobs.push(job)
    return job
  }

  /**
   * Runs a statement tree (`control-flow-parser.ts`'s output) top to bottom, dispatching plain
   * lines to `execute()` and interpreting `if`/`while`/`for`/`case`/function-definition nodes
   * itself. This is what `Kernel.executeScript` walks instead of its old flat `line.split('\n')`,
   * and what a function body runs through when called.
   *
   * `break`/`continue` are implemented as internal control-flow signals (thrown, caught by the
   * nearest loop) rather than a return-code convention, because a return code can't distinguish
   * "this command legitimately exited 1" from "please stop the enclosing loop" -- exactly the
   * ambiguity a real shell avoids by making `break`/`continue` builtins that unwind the interpreter
   * itself, not the process tree.
   */
  async executeStatements(statements: Statement[]): Promise<number> {
    let lastExit = 0

    for (const statement of statements) {
      switch (statement.type) {
        case 'simple': {
          const trimmed = statement.line.trim()
          if (trimmed === 'break') throw new BreakSignal()
          if (trimmed === 'continue') throw new ContinueSignal()
          lastExit = await this.execute(statement.line)
          break
        }

        case 'function': {
          this._functions.set(statement.name, statement.body)
          lastExit = 0
          break
        }

        case 'if': {
          lastExit = await this.executeIf(statement)
          break
        }

        case 'while': {
          lastExit = await this.executeWhile(statement)
          break
        }

        case 'for': {
          lastExit = await this.executeFor(statement)
          break
        }

        case 'case': {
          lastExit = await this.executeCase(statement)
          break
        }
      }

      if (this._shellOptions.errexit && lastExit !== 0 && statement.type === 'simple') return lastExit
    }

    return lastExit
  }

  private async executeIf(statement: IfStatement): Promise<number> {
    for (const branch of statement.branches) {
      if (await this.execute(branch.condition) === 0) return this.executeStatements(branch.body)
    }
    if (statement.elseBody) return this.executeStatements(statement.elseBody)
    return 0
  }

  private async executeWhile(statement: WhileStatement): Promise<number> {
    let lastExit = 0
    while (await this.execute(statement.condition) === 0) {
      try {
        lastExit = await this.executeStatements(statement.body)
      } catch (signal) {
        if (signal instanceof BreakSignal) break
        if (signal instanceof ContinueSignal) continue
        throw signal
      }
    }
    return lastExit
  }

  private async executeFor(statement: ForStatement): Promise<number> {
    let lastExit = 0
    for (const word of statement.words) {
      this.setVariable(statement.variable, expandWord(word, (name) => this.lookupVariable(name)))
      try {
        lastExit = await this.executeStatements(statement.body)
      } catch (signal) {
        if (signal instanceof BreakSignal) break
        if (signal instanceof ContinueSignal) continue
        throw signal
      }
    }
    return lastExit
  }

  /** `*` matches anything; other patterns are matched as shell globs (`?` any char, literal else). */
  private matchesCasePattern(value: string, pattern: string): boolean {
    if (pattern === '*') return true
    const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
    return regex.test(value)
  }

  private async executeCase(statement: CaseStatement): Promise<number> {
    const value = expandWord(statement.word, (name) => this.lookupVariable(name))
    for (const clause of statement.clauses) {
      if (clause.patterns.some(pattern => this.matchesCasePattern(value, pattern))) {
        return this.executeStatements(clause.body)
      }
    }
    return 0
  }

  /**
   * Runs a full script's text (multiple lines, potentially containing control flow and function
   * definitions) to completion. This is `Kernel.executeScript`'s entry point.
   */
  async executeScriptText(script: string): Promise<number> {
    const statements = parseStatements(script)
    return this.executeStatements(statements)
  }

  /**
   * Creates a ReadableStream that reads from a file
   */
  private createFileReadStream(
    sourcePath: string,
    env: Map<string, string>,
    filesystem: Filesystem
  ): ReadableStream<Uint8Array> {
    return new ReadableStream({
      async start(controller) {
        const fileHandle = await filesystem.fs.open(sourcePath, 'r')
        const chunkSize = parseInt(
          env.get('SHELL_INPUT_REDIRECTION_CHUNK_SIZE') || 
          import.meta.env.ECMAOS_APP_SHELL_INPUT_REDIRECTION_CHUNK_SIZE || 
          '8192'
        )
        const buffer = new Uint8Array(chunkSize)
        
        try {
          while (true) {
            const { bytesRead } = await fileHandle.read(buffer, 0, chunkSize)
            if (bytesRead === 0) break
            controller.enqueue(buffer.slice(0, bytesRead))
          }
        } finally {
          await fileHandle.close()
          controller.close()
        }
      }
    })
  }

  /**
   * Creates a WritableStream that writes to a file
   */
  private createFileWriteStream(targetPath: string, append: boolean): WritableStream<Uint8Array> {
    const context = this.context

    return new WritableStream({
      // A real shell opens (creating, and for `>` truncating) the target before the command runs,
      // so `cmd > f` leaves `f` empty even if `cmd` never writes a byte.
      start: async () => {
        if (append && await context.fs.promises.exists(targetPath)) return
        await context.fs.promises.writeFile(targetPath, new Uint8Array())
      },
      write: async (chunk) => {
        await context.fs.promises.appendFile(targetPath, chunk)
      }
    })
  }

  /**
   * Creates a WritableStream that writes to the terminal
   */
  private createTerminalOutputStream(): WritableStream<Uint8Array> {
    const writer = this._terminalWriter
    return new WritableStream({
      write: async (chunk) => {
        if (writer) await writer.write(chunk)
      }
    })
  }

  private createTerminalErrorStream(): WritableStream<Uint8Array> {
    const terminal = this._terminal
    return new WritableStream({
      write: async (chunk) => {
        // Write to terminal with error styling
        const text = new TextDecoder().decode(chunk)
        terminal.write(`\x1b[31m${text}\x1b[0m`)
      }
    })
  }

  /**
   * Creates a pair of WritableStreams that both write to the same file.
   * Used for &> and 2>&1 redirections where stdout and stderr go to the same destination.
   */
  private createSharedFileStreams(filePath: string, append: boolean): { stdout: WritableStream<Uint8Array>, stderr: WritableStream<Uint8Array> } {
    const context = this.context
    // Use a queue to serialize writes from both streams
    let writeQueue = Promise.resolve()
    let isFirstWrite = true
    
    const writeToFile = async (chunk: Uint8Array) => {
      if (append || !isFirstWrite) {
        await context.fs.promises.appendFile(filePath, chunk)
      } else {
        await context.fs.promises.writeFile(filePath, chunk)
        isFirstWrite = false
      }
    }
    
    const createStream = () => new WritableStream<Uint8Array>({
      write: async (chunk) => {
        // Queue writes to ensure serialization
        const currentWrite = writeQueue.then(() => writeToFile(chunk))
        writeQueue = currentWrite.catch(() => {})
        await currentWrite
      }
    })
    
    return {
      stdout: createStream(),
      stderr: createStream()
    }
  }

  /**
   * Resolves a command to its absolute path
   */
  private async resolveCommand(command: string): Promise<string | undefined> {
    if (command.startsWith('./')) {
      const cwdCommand = path.join(this.cwd, command.slice(2))
      if (await this.context.fs.promises.exists(cwdCommand)) {
        return cwdCommand
      }
      return undefined
    }

    const paths = this.env.get('PATH')?.split(':') || DefaultShellPath.split(':')
    const resolvedCommand = path.resolve(command)

    if (await this.context.fs.promises.exists(resolvedCommand)) {
      return resolvedCommand
    }

    for (const path of paths) {
      const expandedPath = path.replace(/\$([A-Z_]+)/g, (_, name) => this.env.get(name) || '')
      const fullPath = `${expandedPath}/${command}`
      if (await this.context.fs.promises.exists(fullPath)) return fullPath
    }

    return undefined
  }

  /**
   * Sets positional parameters
   */
  setPositionalParameters(args: string[]) {
    this.clearPositionalParameters()
    for (const [index, arg] of args.entries()) this.env.set(`${index}`, arg)
  }
}



/**
 * Default configuration values
 */
export const DefaultConfig: IShellConfig = {
  noBell: false,
  fontFamily: 'FiraCode Nerd Font Mono, Ubuntu Mono, courier-new, courier, monospace',
  fontSize: 16,
  cursorBlink: true,
  cursorStyle: 'block',
  theme: {
    background: '#000000',
    foreground: '#00FF00',
    promptColor: 'green'
  },
  smoothScrollDuration: 100,
  macOptionIsMeta: true,
  renderer: 'webgl'
}

export class ShellConfig implements IShellConfig {
  private _noBell: boolean = DefaultConfig.noBell! // Bang because we know default exists
  private _fontFamily: string = DefaultConfig.fontFamily!
  private _fontSize: number = DefaultConfig.fontSize!
  private _cursorBlink: boolean = DefaultConfig.cursorBlink!
  private _cursorStyle: 'block' | 'underline' | 'bar' = DefaultConfig.cursorStyle!
  private _theme: IShellConfig['theme'] = { ...DefaultConfig.theme }
  private _smoothScrollDuration: number = DefaultConfig.smoothScrollDuration!
  private _macOptionIsMeta: boolean = DefaultConfig.macOptionIsMeta!
  private _renderer: 'dom' | 'webgl' = DefaultConfig.renderer!

  private _shell: Shell

  get noBell() { return this._noBell }
  get fontFamily() { return this._fontFamily }
  get fontSize() { return this._fontSize }
  get cursorBlink() { return this._cursorBlink }
  get cursorStyle() { return this._cursorStyle }
  get theme() { return this._theme }
  get smoothScrollDuration() { return this._smoothScrollDuration }
  get macOptionIsMeta() { return this._macOptionIsMeta }
  get renderer() { return this._renderer }

  constructor(shell: Shell) {
    this._shell = shell
  }

  /**
   * Applies a partial configuration to the current config
   */
  private applyConfig(config: Partial<IShellConfig>) {
    if (typeof config.noBell === 'boolean') this._noBell = config.noBell
    if (typeof config.fontFamily === 'string') this._fontFamily = config.fontFamily
    if (typeof config.fontSize === 'number') this._fontSize = config.fontSize
    if (typeof config.cursorBlink === 'boolean') this._cursorBlink = config.cursorBlink
    if (['block', 'underline', 'bar'].includes(config.cursorStyle as string)) this._cursorStyle = config.cursorStyle as 'block' | 'underline' | 'bar'
    if (typeof config.smoothScrollDuration === 'number') this._smoothScrollDuration = config.smoothScrollDuration
    if (typeof config.macOptionIsMeta === 'boolean') this._macOptionIsMeta = config.macOptionIsMeta
    if (config.renderer === 'dom' || config.renderer === 'webgl') this._renderer = config.renderer
    if (config.theme) {
      if (config.theme.name && ThemePresets[config.theme.name]) {
        this._theme = { ...this._theme, ...ThemePresets[config.theme.name] }
      } else {
        this._theme = { ...this._theme, ...config.theme }
      }
    }
  }

  /**
   * Loads system-wide configuration from /etc/shell.toml only
   * Call this before terminal creation foapply system defaults
   */
  async loadSystemConfig() {
    try {
      if (await this._shell.context.fs.promises.exists('/etc/shell.toml')) {
        const content = await this._shell.context.fs.promises.readFile('/etc/shell.toml', 'utf-8')
        const config = parse(content) as Partial<IShellConfig>
        this.applyConfig(config)
      }
    } catch (error) {
      console.warn('Failed to load system shell config:', error)
    }
  }

  /**
   * Loads configuration from /etc/shell.toml and ~/.config/shell.toml
   */
  async load() {
    // Load system default config first
    await this.loadSystemConfig()

    // Load user config second (overwrites system defaults)
    try {
      const home = this._shell.env.get('HOME')
      if (home) {
        const configPath = `${home}/.config/shell.toml`
        if (await this._shell.context.fs.promises.exists(configPath)) {
          const content = await this._shell.context.fs.promises.readFile(configPath, 'utf-8')
          const config = parse(content) as Partial<IShellConfig>
          this.applyConfig(config)
        }
      }
    } catch (error) {
      console.warn('Failed to load user shell config:', error)
    }
  }

  setTheme(theme: string | IShellConfig['theme']) {
    if (typeof theme === 'string') {
      if (Object.prototype.hasOwnProperty.call(ThemePresets, theme)) {
        const preset = ThemePresets[theme]
        this._theme = { ...this._theme, ...preset }
        if (this._theme) {
          this._theme.name = theme
        }
      }
    } else {
      this._theme = { ...this._theme, ...theme }
    }
    
    this._shell.terminal.updateConfig()
  }
}
