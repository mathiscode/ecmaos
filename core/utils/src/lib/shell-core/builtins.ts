/**
 * The builtins that change the calling shell's own state, written once for both shells.
 *
 * A builtin here reads and writes a {@link ShellState}, runs text through the shared
 * {@link Interpreter}, and talks to the outside only through a {@link BuiltinHost}: the working
 * directory, the file system, the positional parameters (each host keeps its own), and the three
 * descriptors. What stays with the hosts is what touches their own machinery: the job table
 * (`jobs`, `fg`, `bg`, `wait`, `disown`) and `env`, which runs a command.
 */

import { formatPrintf } from '../printf-format.js'
import { formatUmask, formatUmaskSymbolic, parseUmask } from './umask.js'
import { evaluateArithmeticExpression } from '../expand-variables.js'
import { DEFAULT_IFS, splitOnIFS } from '../word-expansion.js'
import { echoOutput } from '../echo-text.js'
import type { Interpreter } from './interpreter.js'
import { BreakSignal, ContinueSignal, ExitSignal, ReturnSignal, parseSignalArgument } from './signals.js'
import type { ShellOptionName, ShellState } from './state.js'

export interface ReadLineOptions {
  prompt?: string
  silent?: boolean
  delimiter?: string
  count?: number
  timeoutMs?: number
  result?: { terminated: boolean, timedOut?: boolean }
}

/** The three descriptors a builtin runs with. Usage goes to fd 1 and diagnostics to fd 2. */
export interface BuiltinIO {
  write(text: string): Promise<void> | void
  writeln(text: string): Promise<void> | void
  writeErr(text: string): Promise<void> | void
  writelnErr(text: string): Promise<void> | void
  /**
   * One line from fd 0 without its newline, or `undefined` at end of file. `delimiter` replaces the
   * newline (an empty string means NUL), `count` stops after that many characters, and `result`
   * reports whether a delimiter (or the count) ended the read rather than end of file.
   */
  readLine(options?: ReadLineOptions): Promise<string | undefined>
  /** Whether {@link ReadLineOptions.timeoutMs} is honored; a host without a timed read leaves it unset. */
  readonly canTimeout?: boolean
}

export interface CommandDescription {
  kind: 'alias' | 'keyword' | 'builtin' | 'function' | 'file'
  path?: string
}

export interface BuiltinHost {
  readonly state: ShellState
  readonly interpreter: Interpreter

  cwd(): string
  /** Changes the working directory to an absolute path. Returns an error message on failure. */
  chdir(path: string): Promise<string | undefined>
  /** Resolves `path` against the working directory. */
  resolvePath(path: string): string
  expandTilde?(path: string): string
  stat(path: string): Promise<{ file: boolean, directory: boolean, size: number } | undefined>
  readFile(path: string): Promise<string>

  /** `$1`, `$2`, ... (not `$0`). */
  positional(): string[]
  setPositional(args: string[]): void
  getStatus(): number

  describe(name: string): Promise<CommandDescription | undefined>
  /** Runs one command given as words, so `command ls` and `[` need no re-parse. */
  runArgv(argv: string[]): Promise<number>

  /**
   * Hooks a trap up to whatever delivers the signal, after the shared table is updated. Returns an
   * error message when the host cannot deliver `signal`.
   */
  trapSignal?(signal: string, handler: string | undefined): string | undefined
  signalName?(number: number): string | undefined
  signalNames?(): string[]
  /** Called after the environment changed, so a host can republish it. */
  changed?(): void

  /**
   * The file mode creation mask: reads it, or sets it when `mask` is given. Returns the mask as it was before,
   * or undefined when the system under the shell has no such thing (so `umask` says so, rather than pretend).
   */
  umask?(mask?: number): number | undefined | Promise<number | undefined>
}

/** The names {@link runSharedBuiltin} handles. */
export const sharedBuiltinNames: ReadonlySet<string> = new Set([
  'cd', 'set', 'local', 'export', 'read', 'trap', 'unset', ':', '.', 'break', 'continue', 'eval', 'exit',
  'return', 'shift', 'source', 'alias', 'unalias', 'command', 'getopts', 'type', 'readonly', 'declare',
  'typeset', 'test', '[', 'echo', 'umask', 'let', 'mapfile', 'readarray', 'shopt', 'printf',
])

/** Whether `error` is one of the interpreter's unwind signals, which a builtin must never swallow. */
export function isControlFlowSignal(error: unknown): boolean {
  return error instanceof BreakSignal || error instanceof ContinueSignal ||
    error instanceof ExitSignal || error instanceof ReturnSignal
}

/** Quotes a word so it survives being read back as one. */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_/.,:=@%+-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

export async function runSharedBuiltin(host: BuiltinHost, name: string, argv: string[], io: BuiltinIO): Promise<number> {
  switch (name) {
    case 'cd': return cd(host, argv, io)
    case 'umask': return umaskBuiltin(host, argv, io)
    case 'let': return letBuiltin(host, argv, io)
    case 'shopt': return shoptBuiltin(host, argv, io)
    case 'printf': return printfBuiltin(host, argv, io)
    case 'mapfile': case 'readarray': return mapfileBuiltin(host, argv, io)
    case 'set': return set(host, argv, io)
    case 'local': return local(host, argv, io)
    case 'export': return exportVariables(host, argv, io)
    case 'read': return readBuiltin(host, argv, io)
    case 'trap': return trap(host, argv, io)
    case 'unset': return unset(host, argv, io)
    case ':': return 0
    case 'echo': await io.write(echoOutput(argv).output); return 0
    case 'break': return breakOrContinue(argv, io, 'break')
    case 'continue': return breakOrContinue(argv, io, 'continue')
    case 'eval': return evalBuiltin(host, argv, io)
    case 'exit': return exitBuiltin(host, argv, io)
    case 'return': return returnBuiltin(host, argv, io)
    case 'shift': return shift(host, argv, io)
    case 'source':
    case '.': return source(host, argv, io, name)
    case 'alias': return alias(host, argv, io)
    case 'unalias': return unalias(host, argv, io)
    case 'command': return commandBuiltin(host, argv, io)
    case 'getopts': return getopts(host, argv, io)
    case 'type': return type(host, argv, io)
    case 'readonly': return readonly(host, argv, io)
    case 'declare':
    case 'typeset': return declare(host, argv, io)
    case 'test': return testBuiltin(host, argv, io)
    case '[': return bracket(host, argv, io)
    default: throw new Error(`runSharedBuiltin: '${name}' is not a shared builtin`)
  }
}

// -- cd ---------------------------------------------------------------------------------------------

async function cd(host: BuiltinHost, argv: string[], io: BuiltinIO): Promise<number> {
  if (argv[0] === '--help' || argv[0] === '-h') {
    await io.writeln('Usage: cd [DIRECTORY]\nChange the shell working directory.\n\n  DIRECTORY  the directory to change to (default: $HOME)\n  --help     display this help and exit')
    return 0
  }

  const state = host.state
  const operand = argv.find(arg => arg !== '--')
  let destination: string | undefined
  if (operand === undefined) {
    destination = state.lookup('HOME')
    if (!destination) { await io.writelnErr('cd: HOME not set'); return 1 }
  } else if (operand === '-') {
    destination = state.lookup('OLDPWD')
    if (!destination) { await io.writelnErr('cd: OLDPWD not set'); return 1 }
  } else {
    destination = host.expandTilde ? host.expandTilde(operand) : operand
  }

  const target = host.resolvePath(destination)
  const before = host.cwd()
  const failure = await host.chdir(target)
  if (failure !== undefined) {
    await io.writelnErr(`cd: ${operand ?? destination}: ${failure}`)
    return 1
  }

  state.set('OLDPWD', before)
  state.set('PWD', host.cwd())
  host.changed?.()
  if (operand === '-') await io.writeln(host.cwd())
  return 0
}

// -- set --------------------------------------------------------------------------------------------

/** The `set` flags by the letter and the `-o` name that select them: `set -x` is `set -o xtrace`. */
const OPTION_LETTERS: ReadonlyMap<string, ShellOptionName> = new Map([
  ['e', 'errexit'], ['u', 'nounset'], ['x', 'xtrace'], ['f', 'noglob'], ['C', 'noclobber'], ['v', 'verbose'],
])

const OPTION_NAMES: readonly ShellOptionName[] = ['errexit', 'noclobber', 'noglob', 'nounset', 'pipefail', 'verbose', 'xtrace']

async function set(host: BuiltinHost, argv: string[], io: BuiltinIO): Promise<number> {
  if (argv[0] === '--help' || argv[0] === '-h') {
    await io.writeln([
      'Usage: set [-/+abefCuvx] [-/+o [OPTION]] [ARG...]',
      'Set or unset shell options, or set the positional parameters.',
      '',
      '  -e  errexit    exit on a command that fails outside a condition',
      '  -u  nounset    treat an unset variable as an error',
      '  -x  xtrace     print each command, behind $PS4, before running it',
      '  -f  noglob     turn pathname expansion off',
      '  -C  noclobber  refuse to let > truncate an existing file (>| overrides)',
      '  -v  verbose    echo each line of input as it is read',
      '      pipefail   a pipeline reports its last failing stage, -o only',
      '',
      'Use + instead of - to turn an option off. `set -o` with no name lists them all;',
      '`set -- ARG...` replaces the positional parameters.',
    ].join('\n'))
    return 0
  }

  const state = host.state
  if (argv.length === 0) {
    for (const [key, value] of [...state.visibleVariables()].sort(([a], [b]) => a.localeCompare(b))) await io.writeln(`${key}=${value}`)
    return 0
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string

    // `set -- a b c` replaces the positional parameters; everything after it is a value, not a flag.
    if (arg === '--') { host.setPositional(argv.slice(i + 1)); return 0 }

    if (arg === '-o' || arg === '+o') {
      const name = argv[i + 1]
      // Bare `set -o` lists every option and its state, which is how a script reads them back.
      if (name === undefined || name.startsWith('-') || name.startsWith('+')) {
        if (arg === '-o') for (const option of OPTION_NAMES) await io.writeln(`${option.padEnd(12)}${state.options[option] ? 'on' : 'off'}`)
        continue
      }
      i++
      if (!(OPTION_NAMES as readonly string[]).includes(name)) { await io.writelnErr(`set: ${name}: invalid option name`); return 2 }
      state.setOption(name as ShellOptionName, arg === '-o')
      continue
    }

    if ((arg.startsWith('-') || arg.startsWith('+')) && arg.length > 1) {
      const enable = arg.startsWith('-')
      // A cluster like `set -eux` is one argument; an `o` inside it takes the next argument as its
      // long name, which is what makes `set -euo pipefail` one command.
      for (const letter of arg.slice(1)) {
        if (letter === 'o') {
          const name = argv[++i]
          if (name === undefined || !(OPTION_NAMES as readonly string[]).includes(name)) {
            await io.writelnErr(`set: ${name ?? '-o'}: invalid option name`)
            return 2
          }
          state.setOption(name as ShellOptionName, enable)
          continue
        }
        const option = OPTION_LETTERS.get(letter)
        if (!option) { await io.writelnErr(`set: ${arg}: invalid option`); return 2 }
        state.setOption(option, enable)
      }
      continue
    }

    // A bare word is a positional parameter, the same as after `--`.
    host.setPositional(argv.slice(i))
    return 0
  }
  return 0
}

// -- variables --------------------------------------------------------------------------------------

async function local(host: BuiltinHost, argv: string[], io: BuiltinIO): Promise<number> {
  const usage = 'Usage: local NAME[=VALUE]...\nDeclare one or more variables local to the current function call.'
  if (argv[0] === '--help' || argv[0] === '-h') { await io.writeln(usage); return 0 }
  // Misuse, not a help request, so the usage text is a diagnostic and belongs on fd 2.
  if (argv.length === 0) { await io.writelnErr(usage); return 1 }

  try {
    // `-n` makes a reference; `-i` and `-r` mean what they do for declare. The others describe what an array is
    // and were handled before the builtin was reached.
    const flags = new Set<string>()
    const operands = argv.filter(arg => {
      if (/^-[A-Za-z]+$/.test(arg)) { for (const letter of arg.slice(1)) flags.add(letter); return false }
      return true
    })
    for (const arg of operands) {
      const eq = arg.indexOf('=')
      const name = eq === -1 ? arg : arg.slice(0, eq)
      if (flags.has('n')) {
        host.state.declareLocal(name)
        host.state.declareNameref(name, eq === -1 ? undefined : arg.slice(eq + 1))
        continue
      }
      if (flags.has('i')) host.state.setInteger(name, true)
      if (eq === -1) host.state.declareLocal(arg)
      else host.state.declareLocal(name, arg.slice(eq + 1))
      if (flags.has('r')) host.state.markReadonly(name)
    }
    return 0
  } catch (error) {
    await io.writelnErr(`local: ${message(error)}`)
    return 1
  }
}

async function exportVariables(host: BuiltinHost, argv: string[], io: BuiltinIO): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    await io.writeln('Usage: export [-n] [-p] [NAME=VALUE | NAME]...\nSet environment variables, or print/unset them.')
    return 0
  }

  const state = host.state
  const unsetFlag = argv.includes('-n')
  const operands = argv.filter(a => a !== '-n' && a !== '-p')

  if (argv.includes('-p') || operands.length === 0) {
    const entries = [...state.visibleVariables()]
      .filter(([key]) => /^[A-Z_][A-Z0-9_]*$/i.test(key) && state.isExported(key))
      .sort(([a], [b]) => a.localeCompare(b))
    for (const [key, value] of entries) await io.writeln(`${key}=${value}`)
    return 0
  }

  for (const assignment of operands) {
    const equals = assignment.indexOf('=')
    const key = (equals === -1 ? assignment : assignment.slice(0, equals)).trim()
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) { await io.writelnErr(`export: invalid variable name: ${key}`); return 1 }

    if (unsetFlag) { state.unset(key); host.changed?.(); continue }
    // `export NAME` marks an existing variable for inheritance without changing its value.
    if (equals === -1) { state.markExported(key); host.changed?.(); continue }

    let value = assignment.slice(equals + 1)
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)

    // Through `state.set`, so an active `local` frame is written rather than bypassed.
    try {
      state.set(key, value)
    } catch (error) {
      await io.writelnErr(`export: ${message(error)}`)
      return 1
    }
    state.markExported(key)
    host.changed?.()
  }
  return 0
}

async function unset(host: BuiltinHost, argv: string[], io: BuiltinIO): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    await io.writeln([
      'Usage: unset [-f | -v] NAME[[INDEX]]...',
      'Unset a variable, function, or array element.',
      '',
      '  -v      unset variables only',
      '  -n      unset the reference NAME itself, not the variable it names',
      '  -f      unset functions only',
      '  --help  display this help and exit',
    ].join('\n'))
    return 0
  }

  const state = host.state
  const variablesOnly = argv.includes('-v')
  const functionsOnly = argv.includes('-f')
  const references = argv.includes('-n')
  if (variablesOnly && functionsOnly) {
    await io.writelnErr('unset: cannot simultaneously unset a function and a variable')
    return 1
  }

  let status = 0
  for (const arg of argv) {
    if (arg === '-v' || arg === '-f' || arg === '-n') continue
    // `unset -n`: the reference goes, not what it points at
    if (references) { state.unsetReference(arg); continue }

    const element = /^([A-Za-z_][A-Za-z0-9_]*)\[([^\]]+)\]$/.exec(arg)
    if (element) {
      if (!functionsOnly) {
        const key = state.isAssoc(element[1] as string)
          ? (element[2] as string).replace(/^(["'])([\s\S]*)\1$/, '$2')
          : evaluateArithmeticExpression(element[2] as string, name => state.lookup(name))
        state.unsetArrayElement(element[1] as string, key)
      }
      continue
    }

    if (functionsOnly) { state.functions.delete(arg); continue }
    if (state.lookupArray(arg)) { state.unsetArray(arg); continue }

    // Through `state.unset`, so a `local` declaration is what goes rather than the caller's value.
    const hadVariable = state.lookup(arg) !== undefined
    try {
      state.unset(arg)
    } catch (error) {
      // A readonly name refuses to go. Reported, not thrown: a throw would unwind the statement tree.
      await io.writelnErr(`unset: ${message(error)}`)
      status = 1
      continue
    }
    // bash unsets a variable if one exists by that name and only otherwise falls back to a function.
    if (!hadVariable && !variablesOnly) state.functions.delete(arg)
  }
  host.changed?.()
  return status
}

async function readonly(host: BuiltinHost, argv: string[], io: BuiltinIO): Promise<number> {
  if (argv[0] === '--help' || argv[0] === '-h') {
    await io.writeln('Usage: readonly [-p] [NAME[=VALUE]]...\nMark names unchangeable. With -p, or no name, list the ones already marked.')
    return 0
  }

  const state = host.state
  const names = argv.filter(a => a !== '-p')
  if (names.length === 0) {
    for (const name of [...state.readonlyNames].sort()) {
      const value = state.lookup(name)
      await io.writeln(value === undefined ? `readonly ${name}` : `readonly ${name}="${value}"`)
    }
    return 0
  }

  let status = 0
  for (const arg of names) {
    const equals = arg.indexOf('=')
    const name = equals === -1 ? arg : arg.slice(0, equals)
    if (!IDENTIFIER.test(name)) { await io.writelnErr(`readonly: \`${arg}': not a valid identifier`); status = 1; continue }
    if (equals !== -1) {
      try { state.set(name, arg.slice(equals + 1)) } catch (error) {
        await io.writelnErr(`readonly: ${message(error)}`)
        status = 1
        continue
      }
    }
    state.markReadonly(name)
  }
  host.changed?.()
  return status
}

/** The attribute letters `declare -p` prints, or `-` for none. */
function attributes(state: ShellState, name: string): string {
  const letters = (state.isInteger(name) ? 'i' : '') + (state.isNameref(name) ? 'n' : '') + (state.isReadonly(name) ? 'r' : '')
  return letters || '-'
}

async function declare(host: BuiltinHost, argv: string[], io: BuiltinIO): Promise<number> {
  if (argv[0] === '--help' || argv[0] === '-h') {
    await io.writeln([
      'Usage: declare [-aAfFiprx] [NAME[=VALUE]]...',
      'Set variable values and attributes.',
      '',
      '  -r  make NAMEs readonly',
      '  -a  declare NAMEs as indexed arrays',
      '  -A  declare NAMEs as associative arrays',
      '  -i  evaluate assignments to NAMEs as arithmetic',
      '  -n  make NAMEs references to the variable named by their value',
      '  -p  print each NAME with its attributes, or every variable',
      '  -f  print function definitions by name',
      '  -F  print function names only',
      '  -x  mark NAMEs for export to child processes',
    ].join('\n'))
    return 0
  }

  const state = host.state
  const flags = new Set<string>()
  const off = new Set<string>()
  let i = 0
  for (; i < argv.length; i++) {
    const arg = argv[i] as string
    if (!arg.startsWith('-') && !arg.startsWith('+')) break
    if (arg === '--') { i++; break }
    if (arg === '+i') { off.add('i'); continue }
    if (arg === '+n') { off.add('n'); continue }
    for (const letter of arg.slice(1)) {
      if ('lu'.includes(letter)) { await io.writelnErr(`declare: -${letter}: not supported yet`); return 2 }
      if (!'aAfFinprx'.includes(letter)) { await io.writelnErr(`declare: -${letter}: invalid option`); return 2 }
      flags.add(letter)
    }
  }
  const names = argv.slice(i)

  if (flags.has('F') || flags.has('f')) {
    const wanted = names.length > 0 ? names : [...state.functions.keys()].sort()
    for (const name of wanted) {
      if (!state.functions.has(name)) continue
      await io.writeln(flags.has('F') ? `declare -f ${name}` : `${name} ()`)
    }
    return 0
  }

  if (names.length === 0) {
    for (const [key, value] of [...state.visibleVariables()].sort(([a], [b]) => a.localeCompare(b))) {
      await io.writeln(`declare -${attributes(state, key)} ${key}="${value}"`)
    }
    return 0
  }

  let status = 0
  for (const arg of names) {
    const equals = arg.indexOf('=')
    const name = equals === -1 ? arg : arg.slice(0, equals)
    if (!IDENTIFIER.test(name)) { await io.writelnErr(`declare: \`${arg}': not a valid identifier`); status = 1; continue }

    if (flags.has('p')) {
      const array = state.lookupArray(name)
      if (array) {
        const items = [...array].map(([key, value]) => `[${key}]="${value}"`).join(' ')
        await io.writeln(`declare -${state.isAssoc(name) ? 'A' : 'a'} ${name}=(${items})`)
        continue
      }
      const value = state.lookup(name)
      if (value === undefined) { await io.writelnErr(`declare: ${name}: not found`); status = 1; continue }
      await io.writeln(`declare -${attributes(state, name)} ${name}="${value}"`)
      continue
    }

    // The flag goes on first so that `declare -i n=3+4` stores the sum.
    if (flags.has('i')) state.setInteger(name, true)
    if (off.has('i')) state.setInteger(name, false)

    if (flags.has('n')) {
      try { state.declareNameref(name, equals === -1 ? undefined : arg.slice(equals + 1)) } catch (error) {
        await io.writelnErr(`declare: ${message(error)}`)
        status = 1
      }
      continue
    }
    if (off.has('n')) { state.namerefNames.delete(name) }

    if (equals !== -1) {
      const raw = arg.slice(equals + 1)
      try {
        // `declare -a name=(x y)` is split by the tokenizer long before a builtin sees it.
        if (flags.has('a')) state.setArray(name, raw ? [raw] : [])
        else state.set(name, raw)
      } catch (error) {
        await io.writelnErr(`declare: ${message(error)}`)
        status = 1
        continue
      }
    } else if (flags.has('A')) {
      state.declareAssoc(name)
    } else if (flags.has('a') && !state.lookupArray(name)) {
      state.setArray(name, [])
    }

    if (flags.has('x')) state.markExported(name)
    if (flags.has('r')) state.markReadonly(name)
  }
  host.changed?.()
  return status
}

// -- read -------------------------------------------------------------------------------------------

/**
 * Splits one input line into the fields `read` assigns, honoring `$IFS`. When there are fewer names
 * than fields the last name receives the rest of the line, delimiters intact and only leading IFS
 * whitespace trimmed. `IFS=` disables splitting, which is why `while IFS= read -r line` preserves a
 * line's own leading and trailing whitespace.
 */
function readFields(line: string, ifs: string, count: number): string[] {
  if (ifs === '') return [line]
  if (count <= 1) return [trimIFSWhitespace(line, ifs)]

  const { pieces, hard } = splitOnIFS(line, ifs)
  const fields: string[] = []
  let consumed = 0

  for (let k = 0; k < pieces.length && fields.length < count - 1; k++) {
    const piece = pieces[k] as string
    const boundaryIsHard = k < pieces.length - 1 && (hard[k] as boolean)
    // Skip the empty piece a run of leading IFS whitespace produces; keep the one a non-whitespace
    // delimiter produces, since that is a real empty field.
    if (piece === '' && !boundaryIsHard && fields.length === 0) { consumed = k + 1; continue }
    if (piece === '' && k === pieces.length - 1) break
    fields.push(piece)
    consumed = k + 1
  }

  const remainderPieces = pieces.slice(consumed)
  if (remainderPieces.length > 0) {
    const rest = trimIFSWhitespace(rejoinRemainder(line, pieces, consumed), ifs)
    if (rest !== '' || fields.length < count) fields.push(rest)
  }

  while (fields.length < count) fields.push('')
  return fields.slice(0, count)
}

/** Every field of `line` under `ifs`, for `read -a`. */
function splitAll(line: string, ifs: string): string[] {
  if (ifs === '') return [line]
  const { pieces } = splitOnIFS(line, ifs)
  const fields = [...pieces]
  if (fields[0] === '') fields.shift()
  if (fields[fields.length - 1] === '') fields.pop()
  return fields
}

/** The tail of `line` starting at piece `from`, with the original delimiter text preserved. */
function rejoinRemainder(line: string, pieces: string[], from: number): string {
  if (from === 0) return line
  let index = 0
  for (let k = 0; k < from; k++) {
    index += (pieces[k] as string).length
    while (index < line.length && !line.startsWith(pieces[k + 1] as string, index)) {
      index++
      if ((pieces[k + 1] as string) === '') break
    }
  }
  return line.slice(index)
}

/** Strips IFS whitespace (never IFS non-whitespace) from both ends of `text`. */
function trimIFSWhitespace(text: string, ifs: string): string {
  const isTrimmable = (c: string) => (c === ' ' || c === '\t' || c === '\n') && ifs.includes(c)
  let start = 0
  let end = text.length
  while (start < end && isTrimmable(text[start] as string)) start++
  while (end > start && isTrimmable(text[end - 1] as string)) end--
  return text.slice(start, end)
}

async function readBuiltin(host: BuiltinHost, argv: string[], io: BuiltinIO): Promise<number> {
  const usage = [
    'Usage: read [-rs] [-a ARRAY] [-d DELIM] [-n COUNT] [-t SECONDS] [-p PROMPT] [NAME...]',
    'Read one line from standard input and split it into NAMEs using $IFS.',
    '',
    '  -r          do not treat backslash as an escape character',
    '  -s          do not echo input coming from a terminal',
    '  -a ARRAY    assign the fields to an indexed array',
    '  -d DELIM    stop at the first character of DELIM instead of a newline (empty: NUL)',
    '  -n COUNT    stop after COUNT characters; input must come from a file or a pipe',
    '  -t SECONDS  give up after SECONDS (may be fractional), exiting with status 142',
    '  -p PROMPT   write PROMPT before reading, without a trailing newline',
    '  --help      display this help and exit',
    '',
    'With no NAME, the line is assigned to REPLY. Exits non-zero at end of file.',
  ].join('\n')

  let raw = false
  let silent = false
  let prompt: string | undefined
  let arrayName: string | undefined
  let delimiter: string | undefined
  let count: number | undefined
  let timeoutMs: number | undefined
  const names: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--help' || arg === '-h') { await io.writeln(usage); return 0 }
    if (arg.startsWith('-') && arg.length > 1 && !/^-\d/.test(arg)) {
      // A cluster such as `-rd ''` or `-rn1`: an option that takes a value uses the rest of the
      // cluster, or else the next word.
      for (let j = 1; j < arg.length; j++) {
        const letter = arg[j] as string
        if (letter === 'r') { raw = true; continue }
        if (letter === 's') { silent = true; continue }
        if ('padnt'.includes(letter)) {
          const value = j + 1 < arg.length ? arg.slice(j + 1) : argv[++i]
          if (value === undefined) { await io.writelnErr(`read: option requires an argument -- '${letter}'`); return 2 }
          if (letter === 'p') prompt = value
          else if (letter === 'a') arrayName = value
          else if (letter === 'd') delimiter = value.slice(0, 1)
          else if (letter === 't') {
            if (!/^\d+(\.\d+)?$/.test(value)) { await io.writelnErr(`read: ${value}: invalid timeout specification`); return 1 }
            timeoutMs = Number(value) * 1000
          } else {
            if (!/^\d+$/.test(value)) { await io.writelnErr(`read: ${value}: invalid number`); return 1 }
            count = Number(value)
          }
          break
        }
        await io.writelnErr(`read: -${letter}: invalid option`)
        return 2
      }
      continue
    }
    names.push(arg)
  }

  for (const name of arrayName === undefined ? names : [...names, arrayName]) {
    if (!IDENTIFIER.test(name)) { await io.writelnErr(`read: ${name}: not a valid identifier`); return 1 }
  }

  if (timeoutMs !== undefined && !io.canTimeout) {
    await io.writelnErr('-t is not supported here: this shell cannot time out a read')
    return 2
  }
  const bounded = delimiter !== undefined || count !== undefined || timeoutMs !== undefined
  if (bounded && (io as { stdinIsTTY?: boolean }).stdinIsTTY) {
    await io.writelnErr('-n, -d and -t need input from a file or a pipe; a terminal only delivers whole lines')
    return 1
  }
  const result: { terminated: boolean, timedOut?: boolean } = { terminated: true }
  let line = await io.readLine(prompt !== undefined || silent || bounded ? { prompt, silent, delimiter, count, timeoutMs, result } : undefined)
  // Nothing arrived in time: bash reports a status above 128 and assigns nothing.
  if (line === undefined) return result.timedOut ? 142 : 1
  // Without `-r`, a backslash escapes the next character and disappears.
  if (!raw) line = line.replace(/\\(.)/g, '$1')

  const state = host.state
  const ifs = state.lookup('IFS') ?? DEFAULT_IFS
  try {
    // `-a` takes every field; bash assigns REPLY the line unsplit, keeping its whitespace.
    if (arrayName !== undefined) state.setArray(arrayName, splitAll(line, ifs))
    else if (names.length === 0) state.set('REPLY', line)
    else {
      const fields = readFields(line, ifs, names.length)
      names.forEach((name, index) => state.set(name, fields[index] ?? ''))
    }
  } catch (error) {
    await io.writelnErr(`read: ${message(error)}`)
    return 1
  }
  host.changed?.()
  // With `-d`, data that ran out before the delimiter is still assigned but reports end of file.
  if (result.timedOut) return 142
  return delimiter !== undefined && !result.terminated ? 1 : 0
}

// -- control flow -----------------------------------------------------------------------------------

async function breakOrContinue(argv: string[], io: BuiltinIO, keyword: 'break' | 'continue'): Promise<number> {
  if (argv[0] === '--help') {
    await io.writeln(`Usage: ${keyword} [N]\n${keyword === 'break' ? 'Exit' : 'Resume'} the Nth enclosing for/while loop (default: 1).`)
    return 0
  }
  const parsed = parseSignalArgument(argv, keyword)
  if (parsed.error) { await io.writelnErr(parsed.error); return 2 }
  // bash treats `break 0` as `break 1` rather than as a no-op.
  const level = Math.max(1, parsed.value ?? 1)
  throw keyword === 'break' ? new BreakSignal(level) : new ContinueSignal(level)
}

/** `exit [N]`: with no argument it reports `$?`, which is what makes `cmd || exit` propagate a failure. */
async function exitBuiltin(host: BuiltinHost, argv: string[], io: BuiltinIO): Promise<number> {
  if (argv[0] === '--help') {
    await io.writeln('Usage: exit [N]\nExit the current script with status N (default: the status of the last command).')
    return 0
  }
  const parsed = parseSignalArgument(argv, 'exit')
  if (parsed.error) { await io.writelnErr(parsed.error); return 2 }
  return await host.interpreter.host.exitShell(parsed.value ?? host.getStatus())
}

async function returnBuiltin(host: BuiltinHost, argv: string[], io: BuiltinIO): Promise<number> {
  if (argv[0] === '--help') {
    await io.writeln('Usage: return [N]\nReturn from a shell function or sourced script with status N (default: the status of the last command).')
    return 0
  }
  const parsed = parseSignalArgument(argv, 'return')
  if (parsed.error) { await io.writelnErr(parsed.error); return 2 }
  throw new ReturnSignal(parsed.value ?? host.getStatus())
}

/**
 * `printf [-v VAR] FORMAT [ARGUMENT...]`. A builtin because `-v` assigns a shell variable, which a program cannot;
 * without it the result is the same as `/bin/printf`'s, which shares the formatter.
 */
async function printfBuiltin(host: BuiltinHost, argv: string[], io: BuiltinIO): Promise<number> {
  const args = [...argv]
  let variable: string | undefined
  if (args[0] === '-v') {
    variable = args[1]
    args.splice(0, 2)
    if (variable === undefined) { await io.writelnErr('printf: -v: option requires an argument'); return 2 }
    if (!IDENTIFIER.test(variable)) { await io.writelnErr(`printf: \`${variable}': not a valid identifier`); return 1 }
  }
  if (args[0] === '--') args.shift()
  if (args.length === 0) { await io.writelnErr('printf: usage: printf [-v var] format [arguments]'); return 2 }
  const out = formatPrintf(args[0] as string, args.slice(1))
  if (variable === undefined) { await io.write(out); return 0 }
  try { host.state.set(variable, out) } catch (error) { await io.writelnErr(`printf: ${message(error)}`); return 1 }
  host.changed?.()
  return 0
}

/** The `shopt` options that change what the shell does. */
const SHOPT_EFFECTIVE = ['dotglob', 'extglob', 'failglob', 'globstar', 'nocaseglob', 'nocasematch', 'nullglob']
/** Options about a terminal session or history that there is nothing here for them to change: accepted, kept, not acted on. */
const SHOPT_STORED = ['checkwinsize', 'cmdhist', 'histappend', 'huponexit', 'progcomp']
const SHOPT_NAMES = [...SHOPT_EFFECTIVE, ...SHOPT_STORED].sort()

/**
 * `shopt [-pqsu] [NAME...]`: shell options beyond `set -o`. The ones that change behavior are `nullglob`,
 * `failglob`, `dotglob`, `nocaseglob`, `nocasematch`, `extglob` and `globstar`; a few that only matter to an
 * interactive session (`checkwinsize`, `histappend`, ...) are accepted and remembered. Any other name is an
 * error, so a script that depends on one finds out.
 */
async function shoptBuiltin(host: BuiltinHost, argv: string[], io: BuiltinIO): Promise<number> {
  if (argv[0] === '--help') {
    await io.writeln('Usage: shopt [-pqsu] [NAME...]\nShow or change shell options.\n  -s  turn each NAME on\n  -u  turn each NAME off\n  -q  print nothing; the status says whether every NAME is on\n  -p  print in a form that can be read back\nOptions that change behavior: ' + SHOPT_EFFECTIVE.join(', '))
    return 0
  }
  let set = false
  let unset = false
  let quiet = false
  let reusable = false
  const names: string[] = []
  for (const arg of argv) {
    if (/^-[a-z]+$/.test(arg)) {
      for (const letter of arg.slice(1)) {
        if (letter === 's') set = true
        else if (letter === 'u') unset = true
        else if (letter === 'q') quiet = true
        else if (letter === 'p') reusable = true
        else { await io.writelnErr(`shopt: -${letter}: invalid option`); return 2 }
      }
    } else names.push(arg)
  }
  if (set && unset) { await io.writelnErr('shopt: cannot set and unset shell options simultaneously'); return 1 }

  const shopts = host.state.shopts
  let status = 0
  const unknown = names.filter(name => !SHOPT_NAMES.includes(name))
  for (const name of unknown) { await io.writelnErr(`shopt: ${name}: invalid shell option name`); status = 1 }
  const known = names.filter(name => SHOPT_NAMES.includes(name))

  if (set || unset) {
    for (const name of known) { if (set) shopts.add(name); else shopts.delete(name) }
    return status
  }
  for (const name of names.length === 0 ? SHOPT_NAMES : known) {
    const on = shopts.has(name)
    if (!on) status = 1
    if (quiet) continue
    await io.writeln(reusable ? `shopt -${on ? 's' : 'u'} ${name}` : `${name.padEnd(20)}\t${on ? 'on' : 'off'}`)
  }
  // listing everything is not a test of anything
  return names.length === 0 ? 0 : status
}

/**
 * `mapfile [-t] [-n COUNT] [-s SKIP] [-d DELIM] [-O ORIGIN] [ARRAY]` (also `readarray`): standard input's lines
 * into an indexed array, `MAPFILE` by default. Each element keeps its trailing delimiter unless `-t`.
 */
async function mapfileBuiltin(host: BuiltinHost, argv: string[], io: BuiltinIO): Promise<number> {
  const usage = 'Usage: mapfile [-t] [-n COUNT] [-s SKIP] [-d DELIM] [-O ORIGIN] [ARRAY]\nRead lines from standard input into the indexed array ARRAY (MAPFILE by default).\n  -t  remove the trailing delimiter from each line\n  -n  copy at most COUNT lines (0: all)\n  -s  skip the first SKIP lines\n  -d  end lines at the first character of DELIM, not a newline\n  -O  assign from index ORIGIN instead of clearing the array first'
  let strip = false
  let limit = 0
  let skip = 0
  let origin: number | undefined
  let delimiter = '\n'
  const names: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--help') { await io.writeln(usage); return 0 }
    if (arg.startsWith('-') && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        const letter = arg[j] as string
        if (letter === 't') { strip = true; continue }
        if ('nsdO'.includes(letter)) {
          const value = j + 1 < arg.length ? arg.slice(j + 1) : argv[++i]
          if (value === undefined) { await io.writelnErr(`mapfile: option requires an argument -- '${letter}'`); return 2 }
          if (letter === 'd') delimiter = value.slice(0, 1)
          else {
            if (!/^\d+$/.test(value)) { await io.writelnErr(`mapfile: ${value}: invalid ${letter === 'n' ? 'line count' : letter === 's' ? 'line count' : 'array origin'}`); return 1 }
            if (letter === 'n') limit = Number(value)
            else if (letter === 's') skip = Number(value)
            else origin = Number(value)
          }
          break
        }
        await io.writelnErr(`mapfile: -${letter}: invalid option`)
        return 2
      }
      continue
    }
    names.push(arg)
  }
  const name = names[0] ?? 'MAPFILE'
  if (!IDENTIFIER.test(name)) { await io.writelnErr(`mapfile: ${name}: not a valid identifier`); return 1 }

  const lines: string[] = []
  let skipped = 0
  for (;;) {
    const result: { terminated: boolean } = { terminated: true }
    const line = await io.readLine(delimiter === '\n' ? { result } : { delimiter, result })
    if (line === undefined) break
    if (skipped < skip) { skipped++; continue }
    lines.push(strip || !result.terminated ? line : line + delimiter)
    if (limit > 0 && lines.length >= limit) break
  }
  if (origin === undefined) host.state.setArray(name, lines)
  else lines.forEach((line, index) => host.state.setArrayElement(name, (origin as number) + index, line))
  host.changed?.()
  return 0
}

/** `let EXPRESSION...`: each argument is arithmetic, assignments in it taking effect; true when the last is not zero. */
async function letBuiltin(host: BuiltinHost, argv: string[], io: BuiltinIO): Promise<number> {
  if (argv[0] === '--help') {
    await io.writeln('Usage: let EXPRESSION [EXPRESSION...]\nEvaluate arithmetic expressions. The status is 0 when the last one is not zero, 1 when it is.')
    return 0
  }
  if (argv.length === 0) { await io.writelnErr('let: expression expected'); return 1 }
  let last = 0
  for (const expression of argv) {
    try { last = await host.interpreter.arithmetic(expression) } catch (error) {
      await io.writelnErr(`let: ${expression}: ${message(error)}`)
      return 1
    }
  }
  return last !== 0 ? 0 : 1
}

/** `umask [-p] [-S] [MODE]`: show or set the file mode creation mask. */
async function umaskBuiltin(host: BuiltinHost, argv: string[], io: BuiltinIO): Promise<number> {
  if (argv[0] === '--help') {
    await io.writeln('Usage: umask [-p] [-S] [MODE]\nShow or set the file mode creation mask: the permission bits a new file or directory is created without.\nMODE is octal (022) or symbolic (u=rwx,g=rx,o=rx, the permissions that stay allowed).\n  -S  print the mask symbolically\n  -p  print it as a command that sets it')
    return 0
  }
  let symbolic = false
  let asCommand = false
  const rest: string[] = []
  for (const arg of argv) {
    if (arg === '-S') symbolic = true
    else if (arg === '-p') asCommand = true
    else if (arg === '--') continue
    else rest.push(arg)
  }
  if (rest.length > 1) { await io.writelnErr('umask: too many arguments'); return 1 }

  const current = await host.umask?.()
  if (current === undefined) {
    await io.writelnErr('umask: the file mode creation mask is not supported by the installed @zenfs/core')
    return 1
  }
  if (rest.length === 0) {
    const shown = symbolic ? formatUmaskSymbolic(current) : formatUmask(current)
    await io.writeln(asCommand ? `umask ${symbolic ? '-S ' : ''}${shown}` : shown)
    return 0
  }
  const mask = parseUmask(rest[0] ?? '', current)
  if (mask === undefined) { await io.writelnErr(`umask: ${rest[0]}: invalid ${/^[0-9]+$/.test(rest[0] ?? '') ? 'octal number' : 'symbolic mode'}`); return 1 }
  await host.umask?.(mask)
  return 0
}

async function shift(host: BuiltinHost, argv: string[], io: BuiltinIO): Promise<number> {
  if (argv[0] === '--help') {
    await io.writeln('Usage: shift [N]\nShift positional parameters left by N (default: 1).')
    return 0
  }
  const raw = argv[0]
  if (raw !== undefined && !/^\d+$/.test(raw)) { await io.writelnErr(`shift: ${raw}: numeric argument required`); return 2 }
  const count = raw === undefined ? 1 : Number(raw)
  const positional = host.positional()
  if (count > positional.length) { await io.writelnErr(`shift: ${count}: shift count out of range`); return 1 }
  host.setPositional(positional.slice(count))
  return 0
}

// -- eval and source --------------------------------------------------------------------------------

/** `eval ARG...` runs its arguments, joined, in the calling shell, so `eval 'x=1'` really sets `x`. */
async function evalBuiltin(host: BuiltinHost, argv: string[], io: BuiltinIO): Promise<number> {
  if (argv[0] === '--help') {
    await io.writeln('Usage: eval [ARG]...\nConcatenate ARGs into a single command and execute it in the current shell.')
    return 0
  }
  const text = argv.join(' ').trim()
  if (!text) return 0
  try {
    return await host.interpreter.runSourced(text)
  } catch (error) {
    // A control-flow signal is the interpreter unwinding and must pass through; a parse error is
    // `eval`'s own failure to report.
    if (isControlFlowSignal(error)) throw error
    await io.writelnErr(`eval: ${message(error)}`)
    return 2
  }
}

/**
 * `source FILE [ARG...]` and `.`: runs FILE in the calling shell, so functions, variables, aliases
 * and `cd` persist. FILE is looked up on `$PATH` when it has no slash, with the working directory as
 * a final fallback.
 */
async function source(host: BuiltinHost, argv: string[], io: BuiltinIO, keyword: string): Promise<number> {
  if (argv[0] === '--help') {
    await io.writeln(`Usage: ${keyword} FILE [ARG]...\nRead and execute FILE's commands in the current shell.`)
    return 0
  }

  const name = argv[0]
  if (!name) { await io.writelnErr(`${keyword}: filename argument required`); return 2 }

  const resolved = await resolveSource(host, name)
  if (!resolved) { await io.writelnErr(`${keyword}: ${name}: No such file or directory`); return 1 }

  let text: string
  try { text = await host.readFile(resolved) } catch (error) {
    await io.writelnErr(`${keyword}: ${name}: ${message(error)}`)
    return 1
  }

  const args = argv.slice(1)
  try {
    return await host.interpreter.runSourced(text, args.length > 0 ? args : undefined)
  } catch (error) {
    if (isControlFlowSignal(error)) throw error
    await io.writelnErr(`${keyword}: ${name}: ${message(error)}`)
    return 1
  }
}

async function resolveSource(host: BuiltinHost, name: string): Promise<string | undefined> {
  const isFile = async (candidate: string) => (await host.stat(candidate))?.file === true
  const expanded = host.expandTilde ? host.expandTilde(name) : name
  if (expanded.includes('/')) {
    const absolute = host.resolvePath(expanded)
    return await isFile(absolute) ? absolute : undefined
  }
  for (const dir of (host.state.lookup('PATH') ?? '').split(':').filter(Boolean)) {
    const candidate = `${dir.replace(/\/$/, '')}/${expanded}`
    if (await isFile(candidate)) return candidate
  }
  const local = host.resolvePath(expanded)
  return await isFile(local) ? local : undefined
}

// -- aliases, type, command -------------------------------------------------------------------------

async function alias(host: BuiltinHost, argv: string[], io: BuiltinIO): Promise<number> {
  if (argv[0] === '--help' || argv[0] === '-h') {
    await io.writeln('Usage: alias [NAME[=VALUE]]...\nDefine or display aliases. With no argument, print every alias.')
    return 0
  }

  const aliases = host.state.aliases
  /** bash's own quoting for a listing, so the output can be fed back in verbatim. */
  const show = async (name: string, value: string) => io.writeln(`alias ${name}='${value.replace(/'/g, `'\\''`)}'`)

  if (argv.length === 0 || (argv.length === 1 && argv[0] === '-p')) {
    for (const [name, value] of [...aliases].sort(([a], [b]) => a.localeCompare(b))) await show(name, value)
    return 0
  }

  let status = 0
  for (const arg of argv) {
    if (arg === '-p') continue
    const equals = arg.indexOf('=')
    if (equals === -1) {
      const value = aliases.get(arg)
      if (value === undefined) { await io.writelnErr(`alias: ${arg}: not found`); status = 1; continue }
      await show(arg, value)
      continue
    }
    const name = arg.slice(0, equals)
    if (!name || /[\s=$'"`|&;<>()]/.test(name)) { await io.writelnErr(`alias: \`${arg}': invalid alias name`); status = 1; continue }
    aliases.set(name, arg.slice(equals + 1))
  }
  return status
}

async function unalias(host: BuiltinHost, argv: string[], io: BuiltinIO): Promise<number> {
  if (argv[0] === '--help' || argv[0] === '-h') {
    await io.writeln('Usage: unalias [-a] NAME...\nRemove aliases.\n\n  -a  remove every alias')
    return 0
  }
  const aliases = host.state.aliases
  if (argv.includes('-a')) { aliases.clear(); return 0 }
  if (argv.length === 0) { await io.writelnErr('unalias: usage: unalias [-a] name [name ...]'); return 2 }

  let status = 0
  for (const name of argv) {
    if (!aliases.delete(name)) { await io.writelnErr(`unalias: ${name}: not found`); status = 1 }
  }
  return status
}

async function type(host: BuiltinHost, argv: string[], io: BuiltinIO): Promise<number> {
  if (argv[0] === '--help' || argv[0] === '-h') {
    await io.writeln([
      'Usage: type [-t] [-p] NAME...',
      'Describe how each NAME would be interpreted if used as a command.',
      '',
      '  -t  print only the kind: alias, keyword, builtin, function or file',
      '  -p  print only the path, and nothing for a name that is not a file',
    ].join('\n'))
    return 0
  }

  const typeOnly = argv.includes('-t')
  const pathOnly = argv.includes('-p')
  const names = argv.filter(a => a !== '-t' && a !== '-p')
  if (names.length === 0) return 0

  let status = 0
  for (const name of names) {
    const found = await host.describe(name)
    if (!found) {
      // `-t` and `-p` are the script-facing forms and stay silent on a miss, as in bash.
      if (!typeOnly && !pathOnly) await io.writelnErr(`type: ${name}: not found`)
      status = 1
      continue
    }
    if (pathOnly) { if (found.kind === 'file') await io.writeln(found.path as string); continue }
    if (typeOnly) { await io.writeln(found.kind); continue }

    switch (found.kind) {
      case 'alias': await io.writeln(`${name} is aliased to \`${host.state.aliases.get(name)}'`); break
      case 'keyword': await io.writeln(`${name} is a shell keyword`); break
      case 'builtin': await io.writeln(`${name} is a shell builtin`); break
      case 'function': await io.writeln(`${name} is a function`); break
      case 'file': await io.writeln(`${name} is ${found.path}`); break
    }
  }
  return status
}

/**
 * `command [-v|-V] NAME [ARG...]`: runs NAME ignoring any function of that name, or with `-v` just
 * reports what would run. The point is escaping a wrapper: `ls() { command ls -la "$@"; }`.
 */
async function commandBuiltin(host: BuiltinHost, argv: string[], io: BuiltinIO): Promise<number> {
  if (argv[0] === '--help' || argv[0] === '-h') {
    await io.writeln([
      'Usage: command [-v|-V] NAME [ARG]...',
      'Run NAME with ARGs, ignoring any shell function by that name.',
      '',
      '  -v  print what would run instead of running it',
      '  -V  print a fuller description, as `type` does',
    ].join('\n'))
    return 0
  }

  const verbose = argv.includes('-V')
  const describing = verbose || argv.includes('-v')
  const rest = argv.filter(a => a !== '-v' && a !== '-V' && a !== '-p')
  const name = rest[0]
  if (!name) { await io.writelnErr('command: usage: command [-v|-V] NAME [ARG]...'); return 2 }

  if (describing) {
    const found = await host.describe(name)
    if (!found) return 1
    if (verbose) return await type(host, [name], io)
    await io.writeln(found.kind === 'file' ? found.path as string : name)
    return 0
  }

  // Hide any same-named function for the duration, which is the whole job.
  const functions = host.state.functions
  const body = functions.get(name)
  if (body) functions.delete(name)
  try {
    return await host.runArgv(rest)
  } finally {
    if (body) functions.set(name, body)
  }
}

// -- trap -------------------------------------------------------------------------------------------

async function trap(host: BuiltinHost, argv: string[], io: BuiltinIO): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    await io.writeln("Usage: trap ['COMMAND'] [SIGNAL...]\n       trap - SIGNAL...\nSet, reset ('-'), or list (no args) signal handlers for this shell.")
    return 0
  }

  const state = host.state
  if (argv.length === 0 || argv[0] === '-p') {
    for (const [signal, handler] of state.listTraps()) await io.writeln(`trap -- '${handler}' ${signal}`)
    return 0
  }
  if (argv[0] === '-l') {
    await io.writeln(['EXIT', 'ERR', 'DEBUG', 'RETURN', ...(host.signalNames?.() ?? [])].join(' '))
    return 0
  }

  const [first, ...signals] = argv
  if (signals.length === 0) {
    await io.writelnErr(`trap: usage: trap ['COMMAND'] [SIGNAL...]`)
    return 1
  }

  const handler = first === '-' ? undefined : (first as string)
  for (const raw of signals) {
    let signal = raw.replace(/^SIG/, '').toUpperCase()
    if (/^\d+$/.test(signal)) signal = signal === '0' ? 'EXIT' : (host.signalName?.(Number(signal)) ?? signal)
    // DEBUG and RETURN are the interpreter's own, not signals a host delivers
    const failure = signal === 'DEBUG' || signal === 'RETURN' ? undefined : host.trapSignal?.(signal, handler)
    if (failure !== undefined) { await io.writelnErr(`trap: ${raw}: ${failure}`); return 1 }
    state.setTrap(handler, signal)
  }
  return 0
}

// -- getopts ----------------------------------------------------------------------------------------

/**
 * `getopts OPTSTRING NAME [ARG...]`: one option per call, the loop condition of every script that
 * takes flags. `$OPTIND` counts arguments and `$OPTARG` carries a value, as in POSIX; a cluster
 * (`-abc`) needs a second cursor, which the state keeps. A leading `:` in OPTSTRING selects silent
 * mode.
 */
async function getopts(host: BuiltinHost, argv: string[], io: BuiltinIO): Promise<number> {
  if (argv[0] === '--help' || argv[0] === '-h') {
    await io.writeln([
      'Usage: getopts OPTSTRING NAME [ARG]...',
      'Parse the next option from ARGs (the positional parameters by default) into NAME.',
      '',
      'A letter followed by `:` in OPTSTRING takes an argument, delivered in $OPTARG.',
      'A leading `:` reports errors through NAME and $OPTARG rather than on stderr.',
      'Exits non-zero when there are no options left, which ends the enclosing while loop.',
    ].join('\n'))
    return 0
  }

  const [optstring, name] = argv
  if (!optstring || !name) { await io.writelnErr('getopts: usage: getopts optstring name [arg ...]'); return 2 }

  const state = host.state
  const silent = optstring.startsWith(':')
  const spec = silent ? optstring.slice(1) : optstring
  const args = argv.length > 2 ? argv.slice(2) : host.positional()

  const fail = async (value: string, optarg: string, text: string): Promise<number> => {
    state.set(name, value)
    if (silent) state.set('OPTARG', optarg)
    else { state.vars.delete('OPTARG'); await io.writelnErr(text) }
    return 0
  }

  let index = Number(state.lookup('OPTIND') ?? '1')
  if (!Number.isInteger(index) || index < 1) index = 1

  const current = args[index - 1]
  // Out of arguments, or the first non-option word, or an explicit `--`: the scan is over, with
  // OPTIND at the first operand so the caller can `shift $((OPTIND - 1))`.
  if (current === undefined || current === '-' || !current.startsWith('-')) {
    state.set('OPTIND', String(index))
    state.set(name, '?')
    return 1
  }
  if (current === '--') {
    state.set('OPTIND', String(index + 1))
    state.set(name, '?')
    return 1
  }

  let charIndex = state.getoptsCharIndex
  if (charIndex < 1 || charIndex >= current.length + 1) charIndex = 1
  const letter = current[charIndex] as string | undefined

  if (letter === undefined) {
    // Cluster exhausted: move to the next argument and try again.
    state.set('OPTIND', String(index + 1))
    state.getoptsCharIndex = 1
    return await getopts(host, argv, io)
  }

  const position = spec.indexOf(letter)
  const known = letter !== ':' && position !== -1
  const takesArgument = known && spec[position + 1] === ':'
  const atEndOfCluster = charIndex + 1 >= current.length

  const advance = (consumedArgument: boolean) => {
    if (atEndOfCluster || consumedArgument) {
      state.set('OPTIND', String(index + (consumedArgument && atEndOfCluster ? 2 : 1)))
      state.getoptsCharIndex = 1
    } else {
      state.getoptsCharIndex = charIndex + 1
    }
  }

  if (!known) {
    advance(false)
    return await fail('?', letter, `getopts: illegal option -- ${letter}`)
  }

  if (!takesArgument) {
    advance(false)
    state.set(name, letter)
    state.vars.delete('OPTARG')
    return 0
  }

  // `-ovalue` carries its argument in the same word; `-o value` takes the next one.
  const inline = current.slice(charIndex + 1)
  if (inline) {
    state.set('OPTIND', String(index + 1))
    state.getoptsCharIndex = 1
    state.set(name, letter)
    state.set('OPTARG', inline)
    return 0
  }

  const value = args[index]
  if (value === undefined) {
    state.set('OPTIND', String(index + 1))
    state.getoptsCharIndex = 1
    return await fail(silent ? ':' : '?', letter, `getopts: option requires an argument -- ${letter}`)
  }

  state.set('OPTIND', String(index + 2))
  state.getoptsCharIndex = 1
  state.set(name, letter)
  state.set('OPTARG', value)
  return 0
}

// -- test and [ -------------------------------------------------------------------------------------

async function bracket(host: BuiltinHost, argv: string[], io: BuiltinIO): Promise<number> {
  if (argv[argv.length - 1] !== ']') { await io.writelnErr('[: missing `]\''); return 2 }
  return await testBuiltin(host, argv.slice(0, -1), io)
}

/** `test EXPR` and `[ EXPR ]`: the POSIX expression forms, with `-a`, `-o`, `!` and parentheses. */
async function testBuiltin(host: BuiltinHost, argv: string[], io: BuiltinIO): Promise<number> {
  try {
    return await evaluateTest(host, argv) ? 0 : 1
  } catch (error) {
    await io.writelnErr(`test: ${message(error)}`)
    return 2
  }
}

const UNARY_FILE = new Set(['-e', '-f', '-d', '-r', '-w', '-x', '-s', '-L', '-h'])
const BINARY = new Set(['=', '==', '!=', '-eq', '-ne', '-lt', '-le', '-gt', '-ge'])

async function evaluateTest(host: BuiltinHost, words: string[]): Promise<boolean> {
  let position = 0
  const peek = () => words[position]

  const unaryAt = (index: number) => {
    const word = words[index]
    return word !== undefined && (word === '-n' || word === '-z' || UNARY_FILE.has(word))
  }

  const primary = async (): Promise<boolean> => {
    const word = peek()
    if (word === undefined) throw new Error('argument expected')
    if (word === '(') {
      position++
      const value = await orExpression()
      if (peek() !== ')') throw new Error("missing `)'")
      position++
      return value
    }
    // A binary operator in the second position wins over a unary reading of the first word, as in POSIX.
    if (words[position + 1] !== undefined && BINARY.has(words[position + 1] as string) && words[position + 2] !== undefined) {
      const [left, operator, right] = [word, words[position + 1] as string, words[position + 2] as string]
      position += 3
      return compare(left, operator, right)
    }
    if (word === '!') { position++; return !await primary() }
    if (unaryAt(position) && words[position + 1] !== undefined) {
      const operand = words[position + 1] as string
      position += 2
      return await unary(host, word, operand)
    }
    position++
    return word !== ''
  }

  const andExpression = async (): Promise<boolean> => {
    let value = await primary()
    while (peek() === '-a') { position++; const next = await primary(); value = value && next }
    return value
  }

  const orExpression = async (): Promise<boolean> => {
    let value = await andExpression()
    while (peek() === '-o') { position++; const next = await andExpression(); value = value || next }
    return value
  }

  if (words.length === 0) return false
  const value = await orExpression()
  if (position < words.length) throw new Error(`unexpected argument: ${words[position]}`)
  return value
}

function compare(left: string, operator: string, right: string): boolean {
  switch (operator) {
    case '=': case '==': return left === right
    case '!=': return left !== right
  }
  const a = Number(left)
  const b = Number(right)
  if (!Number.isInteger(a)) throw new Error(`${left}: integer expression expected`)
  if (!Number.isInteger(b)) throw new Error(`${right}: integer expression expected`)
  switch (operator) {
    case '-eq': return a === b
    case '-ne': return a !== b
    case '-lt': return a < b
    case '-le': return a <= b
    case '-gt': return a > b
    default: return a >= b
  }
}

async function unary(host: BuiltinHost, operator: string, operand: string): Promise<boolean> {
  if (operator === '-n') return operand !== ''
  if (operator === '-z') return operand === ''
  const stat = await host.stat(host.resolvePath(operand))
  if (!stat) return false
  switch (operator) {
    case '-f': return stat.file
    case '-d': return stat.directory
    case '-s': return stat.size > 0
    default: return true
  }
}
