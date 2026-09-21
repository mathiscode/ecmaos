import chalk from 'chalk'
import parseArgs, { CommandLineOptions, OptionDefinition } from 'command-line-args'
import parseUsage from 'command-line-usage'
import type { TerminalCommand as ITerminalCommand } from '@ecmaos/types'
import type { CommandContext, CommandIO, Kernel, Process, Shell, Terminal } from '@ecmaos/types'
import { writeStdout, writelnStdout, writeStderr, writelnStderr } from './helpers.js'

type UnifiedParserRun = (argv: CommandLineOptions, process?: Process, rawArgv?: string[]) => Promise<number | void>
type RawArgvRun = (ctx: CommandContext, io: CommandIO) => Promise<number | void>

/**
 * Builds the `CommandIO` handed to a coreutils command's `run`, closing over the resolved
 * `process`/`terminal` for this invocation so commands stop threading them through every write.
 */
function createCommandIO(process: Process | undefined, terminal: Terminal): CommandIO {
  return {
    write: (text: string) => writeStdout(process, terminal, text),
    writeln: (text: string) => writelnStdout(process, terminal, text),
    writeErr: (text: string) => writeStderr(process, terminal, text),
    writelnErr: (text: string) => writelnStderr(process, terminal, text),
    stdout: process?.stdout,
    stderr: process?.stderr,
    stdin: process?.stdin,
    isTTY: process?.stdoutIsTTY ?? false
  }
}

/**
 * The TerminalCommand class sets up a common interface for builtin terminal commands
 * Supports two modes:
 * - Unified parser mode: When options are provided, uses command-line-args (for kernel commands)
 * - Raw argv mode: When options are not provided, passes `(ctx, io)` instead of raw `(pid, argv)`
 *   (for coreutils commands) -- see `CommandContext`/`CommandIO` in `@ecmaos/types`.
 */
export class TerminalCommand implements ITerminalCommand {
  command: string = ''
  description: string = ''
  kernel: Kernel
  options: OptionDefinition[] = []
  run: (pid: number, argv: string[], process?: Process) => Promise<number | void>
  shell: Shell
  terminal: Terminal
  stdin?: ReadableStream<Uint8Array>
  stdout?: WritableStream<Uint8Array>
  stderr?: WritableStream<Uint8Array>

  constructor({ command, description, kernel, options, run, shell, terminal, stdin, stdout, stderr }: {
    command: string
    description: string
    kernel: Kernel
    options?: parseUsage.OptionDefinition[]
    run: UnifiedParserRun | RawArgvRun
    shell: Shell
    terminal: Terminal
    stdin?: ReadableStream<Uint8Array>
    stdout?: WritableStream<Uint8Array>
    stderr?: WritableStream<Uint8Array>
  }) {
    this.command = command
    this.description = description
    this.kernel = kernel
    this.options = options || []
    this.shell = shell
    this.terminal = terminal
    this.stdin = stdin
    this.stdout = stdout
    this.stderr = stderr

    const useUnifiedParser = this.options.length > 0

    if (useUnifiedParser) {
      const unifiedRun = run as UnifiedParserRun
      this.run = async (_pid: number, argv: string[], process?: Process) => {
        if (argv === null) return 1
        try {
          const parsed = parseArgs(this.options, { argv, stopAtFirstUnknown: true })
          if (parsed.help) {
            await writelnStdout(process, this.terminal, this.usage)
            return 0
          }

          return await unifiedRun(parsed, process, argv)
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          if (errorMessage.includes('UNKNOWN_OPTION') || errorMessage.includes('Unknown option')) {
            return await unifiedRun({} as CommandLineOptions, process, argv)
          }
          await writelnStderr(process, this.terminal, chalk.red(errorMessage))
          return 1
        }
      }
    } else {
      const rawRun = run as RawArgvRun
      this.run = async (pid: number, argv: string[], process?: Process) => {
        if (argv === null) return 1
        const ctx: CommandContext = {
          kernel: this.kernel,
          shell: this.shell,
          terminal: this.terminal,
          process,
          pid,
          argv,
          cwd: this.shell.cwd
        }
        const io = createCommandIO(process, this.terminal)
        return await rawRun(ctx, io)
      }
    }
  }

  get usage() {
    if (this.options.length === 0) {
      return ''
    }
    return parseUsage([
      { header: this.command, content: this.description },
      { header: 'Usage', content: this.usageContent },
      { header: 'Options', optionList: this.options }
    ])
  }

  get usageContent() {
    if (this.options.length === 0) {
      return ''
    }
    return `${this.command} ${this.options.map(option => {
      let optionStr = option.name
      if (option.type === Boolean) optionStr = `[--${option.name}]`
      else if (option.type === String) optionStr = option.defaultOption ? `<${option.name}>` : `[--${option.name} <value>]`

      if (option.multiple) optionStr += '...'
      return optionStr
    }).join(' ')}`
  }
}
