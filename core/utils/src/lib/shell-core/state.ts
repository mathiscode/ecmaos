/**
 * The state of a shell, independent of how it runs commands: variables and which are exported, arrays, `local`
 * frames, `readonly`, functions, aliases, traps, `set` options and computed special parameters. Held by the kernel
 * shell and `/bin/ecmash`. Positional parameters and `$?` stay with each shell.
 */

import { CompletionRegistry } from './completion-spec.js'
import type { Statement } from '../control-flow-parser.js'
import { evaluateArithmeticExpression } from '../expand-variables.js'

export interface ShellOptions {
  /** `-e`: a failing command ends the shell */
  errexit: boolean
  /** `-u`: expanding an unset variable is an error */
  nounset: boolean
  /** `-o pipefail`: a pipeline fails when any stage does */
  pipefail: boolean
  /** `-x`: print each command before running it */
  xtrace: boolean
  /** `-f`: no pathname expansion */
  noglob: boolean
  /** `-C`: `>` refuses to overwrite an existing file */
  noclobber: boolean
  /** `-v`: echo each line as it is read */
  verbose: boolean
}

/**
 * An array's elements. An indexed array is keyed by number; an associative one (`declare -A`) by
 * string, and is listed in {@link ShellState.assocNames}.
 */
export type ArrayStore = Map<number | string, string>

export type ShellOptionName = keyof ShellOptions

/** What the shell cannot know for itself and its host has to say. */
export interface ShellIdentity {
  pid(): number
  ppid(): number
  /** The group ids of the user the shell runs as, primary first: `GROUPS`. */
  groups?(): string[]
}

/** Shell-internal names: never part of a child's environment, whatever else is true of them. */
const INTERNAL_NAMES: ReadonlySet<string> = new Set(['?', '$', '!', '-', '_'])

/** Whether `name` is shell-internal state (`$?`, `$$`, the positional parameters) rather than a variable. */
export function isInternalVariable(name: string): boolean {
  return INTERNAL_NAMES.has(name) || /^\d+$/.test(name)
}

/**
 * What the shells say about themselves to a script that asks `$BASH_VERSION` or `$OSTYPE`. The
 * language is checked against bash 5.3 (see the parity corpus), so that is the version reported.
 */
export const BASH_VERSION_TEXT = '5.3.0(1)-release'
export const BASH_VERSINFO = ['5', '3', '0', '1', 'release', 'x86_64-pc-linux-gnu']

/** Variables that read as these until the script assigns its own. Not exported, as in bash. */
const DEFAULT_VARIABLES: Readonly<Record<string, string>> = {
  BASH: '/bin/bash',
  BASH_VERSION: BASH_VERSION_TEXT,
  OSTYPE: 'linux-gnu',
  HOSTTYPE: 'x86_64',
  MACHTYPE: 'x86_64-pc-linux-gnu'
}

/** A file the shell is reading commands from (a script, or a sourced file) or a function defined in one. */
interface SourceFrame {
  file: string
  /** `$LINENO` of the call or `source` that entered this frame, for `BASH_LINENO`. */
  callLine: number
}

export class ShellState {
  /**
   * Every scalar variable. A host that must observe writes made behind its back (the kernel shell's
   * `env` map is read and written directly in places) hands in its own map; see {@link adopt}.
   */
  vars: Map<string, string>

  /**
   * Variables the shell created by assignment, which stay out of a child's environment until
   * `export` names them. Anything already in the environment when the shell started, or written
   * straight into {@link vars} by the host, is inherited, as in a real shell.
   */
  readonly unexported = new Set<string>()

  /** Names declared `-A`: their {@link arrays} entry is keyed by string rather than number. */
  readonly assocNames = new Set<string>()

  /** Indexed and associative arrays. Never inherited by a child. */
  arrays = new Map<string, ArrayStore>()

  /**
   * `local` frames, innermost last. A name mapped to `undefined` is a local that `unset` removed:
   * present in the frame, so it still shadows the caller's value, but resolving to nothing, which is
   * bash's behavior for `local X=1; unset X`.
   */
  localScopes: Array<Map<string, string | undefined>> = []

  /** `local` frames for arrays, pushed and popped with {@link localScopes}. */
  localArrayScopes: Array<Map<string, ArrayStore | undefined>> = []

  /** Names marked `readonly`: assigning to or unsetting one fails. */
  readonly readonlyNames = new Set<string>()

  /** Names declared `-i`: every assignment is evaluated as arithmetic, and `+=` adds. */
  readonly integerNames = new Set<string>()
  /** Names declared with `declare -n`: the value of each is the name of the variable it stands for. */
  readonly namerefNames = new Set<string>()

  functions = new Map<string, Statement[]>()

  /** `alias` definitions, substituted at command position as text. */
  aliases = new Map<string, string>()

  /**
   * `trap` handlers by signal name without the `SIG` prefix (`INT`, `EXIT`, `ERR`, ...). A `''`
   * handler means ignore the signal.
   */
  traps = new Map<string, string>()

  /** The `shopt` options that are on. */
  shopts = new Set<string>()
  /** What `complete` registered, and the completion being run. */
  readonly completions = new CompletionRegistry()
  /**
   * The directory stack below the working directory (`DIRSTACK[1..]`): the top first. `pushd`, `popd` and `dirs` own
   * it.
   */
  dirStack: string[] = []
  /** The line whose rest is skipped after a refused assignment: bash drops the remainder of that command list. */
  failedLine?: number
  options: ShellOptions = { errexit: false, nounset: false, pipefail: false, xtrace: false, noglob: false, noclobber: false, verbose: false }

  /** `getopts`' position inside a cluster such as `-abc` */
  getoptsCharIndex = 1

  /** `$!`, undefined until something has been put in the background */
  lastBackgroundPid: number | undefined

  /** `$LINENO` */
  lineNumber = 0

  private randomState = Math.floor(Math.random() * 0x7fffffff) + 1
  private secondsOrigin = Date.now()

  /** Where each function was defined, so `BASH_SOURCE` can name the file a function body came from. */
  private readonly functionFiles = new Map<string, string>()
  /** The files being run, innermost first: the script, anything it sourced, and the functions called. */
  private sourceFrames: SourceFrame[] = []
  /** Default variables the script has `unset`; they stay gone until assigned again. */
  private readonly removedDefaults = new Set<string>()

  constructor(private readonly identity: ShellIdentity, vars: Map<string, string> = new Map()) {
    this.vars = vars
  }

  /** Replaces the variable store with the host's own map, keeping the rest of the state. */
  adopt(vars: Map<string, string>): void {
    this.vars = vars
  }

  // - source frames: BASH_SOURCE and BASH_LINENO ----------------------------------------------------

  /** The file whose commands are running now, if the shell is reading one. */
  currentSourceFile(): string | undefined {
    return this.sourceFrames[0]?.file
  }

  /** Enters a script, a sourced file or a function body; `file` is what `BASH_SOURCE` will say. */
  pushSourceFrame(file: string, callLine = this.lineNumber): void {
    this.sourceFrames.unshift({ file, callLine })
    this.publishSourceFrames()
  }

  popSourceFrame(): void {
    this.sourceFrames.shift()
    this.publishSourceFrames()
  }

  /** Remembers the file a function was defined in (the one running at the time). */
  recordFunctionDefinition(name: string): void {
    const file = this.currentSourceFile()
    if (file === undefined) this.functionFiles.delete(name)
    else this.functionFiles.set(name, file)
  }

  /** The file `name` was defined in; empty when it was typed at a prompt. */
  functionFile(name: string): string {
    return this.functionFiles.get(name) ?? ''
  }

  private publishSourceFrames(): void {
    if (this.sourceFrames.length === 0) {
      this.unsetArray('BASH_SOURCE')
      this.unsetArray('BASH_LINENO')
      return
    }
    this.setArray('BASH_SOURCE', this.sourceFrames.map(frame => frame.file))
    this.setArray('BASH_LINENO', this.sourceFrames.map(frame => String(frame.callLine)))
  }

  // - variables ----------------------------------------------------------------------------------

  /**
   * A variable by name the way `local` scoping requires: the innermost frame that declares it, then
   * the computed parameters, then the variables. A computed parameter sits behind the frames so that
   * `local RANDOM` can shadow it, but a plain `RANDOM=42` cannot replace it: that seeds it instead.
   */
  lookup(name: string): string | undefined {
    return this.rawLookup(this.resolveName(name))
  }

  /** The variable a name stands for: itself, or through any `declare -n` references to the one it names. */
  resolveName(name: string): string {
    let current = name
    for (let hops = 0; hops < 8 && this.namerefNames.has(current); hops++) {
      const target = this.rawLookup(current)
      if (!target) break
      current = target
    }
    return current
  }

  isNameref(name: string): boolean { return this.namerefNames.has(name) }

  /**
   * `declare -n NAME[=TARGET]`: NAME stands for TARGET from now on. Assigning to the reference itself re-points it.
   */
  declareNameref(name: string, target?: string): void {
    this.namerefNames.delete(name)
    if (target !== undefined) this.set(name, target)
    this.namerefNames.add(name)
  }

  /** `unset -n NAME`: the reference goes, what it pointed at stays. */
  unsetReference(name: string): void {
    this.namerefNames.delete(name)
    this.unset(name)
  }

  private rawLookup(name: string): string | undefined {
    for (let i = this.localScopes.length - 1; i >= 0; i--) {
      const frame = this.localScopes[i] as Map<string, string | undefined>
      if (frame.has(name)) return frame.get(name)
    }
    const computed = this.computed(name)
    if (computed !== undefined) return computed
    return this.vars.get(name) ?? (this.removedDefaults.has(name) ? undefined : DEFAULT_VARIABLES[name])
  }

  /**
   * The special parameters produced at each read. `$?`, `$PPID`'s siblings and `$SHLVL` are not here:
   * they are ordinary entries a host writes when they change, so `env` lists them and a child
   * inherits them.
   */
  private computed(name: string): string | undefined {
    switch (name) {
      // bash's range is 0..32767. A 32-bit xorshift keeps the sequence reproducible after a seed.
      case 'RANDOM': {
        let x = this.randomState
        x ^= x << 13
        x ^= x >>> 17
        x ^= x << 5
        this.randomState = x >>> 0 || 1
        return String(this.randomState % 32768)
      }
      case 'SECONDS': return String(Math.floor((Date.now() - this.secondsOrigin) / 1000))
      case 'LINENO': return String(this.lineNumber)
      case '$': return String(this.identity.pid())
      case 'PPID': return String(this.identity.ppid())
      case '-': return this.optionFlags()
      // Unset until something has been backgrounded, so `${!:-none}` works instead of reading 0.
      case '!': return this.lastBackgroundPid === undefined ? undefined : String(this.lastBackgroundPid)
      default: return undefined
    }
  }

  /**
   * `$-`: the single-letter flags in effect, in bash's order. `h` and `B` are always on and have no
   * `set` switch here, and `i` marks an interactive shell, which every ecmaOS shell is.
   */
  optionFlags(): string {
    const flags: string[] = []
    if (this.options.errexit) flags.push('e')
    flags.push('h')
    if (this.options.nounset) flags.push('u')
    flags.push('B', 'i')
    return flags.join('')
  }

  /**
   * Assigns a variable. Throws for a readonly name. Inside a function the assignment lands in the nearest
   * frame that declared the name with {@link declareLocal}, and in the shell's own variables when none did.
   */
  set(name: string, value: string, append = false): void {
    name = this.namerefNames.has(name) ? this.resolveName(name) : name
    if (this.readonlyNames.has(name)) throw new Error(`${name}: readonly variable`)
    if (this.integerNames.has(name)) value = this.integerValue(name, value, append)
    else if (append) value = (this.lookup(name) ?? '') + value
    // dynamic scope, as in bash: the nearest function frame that declared the name takes the assignment, and a
    // name no frame declared is the shell's own
    for (let i = this.localScopes.length - 1; i >= 0; i--) {
      const frame = this.localScopes[i] as Map<string, string | undefined>
      if (frame.has(name)) { frame.set(name, value); return }
    }

    // Assigning to a computed parameter adjusts what it computes rather than replacing it, which is
    // bash's behavior: `RANDOM=42` seeds the generator and `SECONDS=0` restarts the clock.
    if (name === 'RANDOM' && /^\d+$/.test(value)) { this.randomState = Number(value) >>> 0 || 1; return }
    if (name === 'SECONDS' && /^\d+$/.test(value)) { this.secondsOrigin = Date.now() - Number(value) * 1000; return }
    // Restarting the option scan restarts it fully, cluster cursor included.
    if (name === 'OPTIND') this.getoptsCharIndex = 1

    this.removedDefaults.delete(name)
    if (!this.vars.has(name)) this.unexported.add(name)
    this.vars.set(name, value)
  }

  /**
   * What an assignment to a `-i` name stores: the right side evaluated as arithmetic, added to the old value for
   * `+=`.
   */
  private integerValue(name: string, value: string, append: boolean): string {
    const result = value.trim() === '' ? 0 : evaluateArithmeticExpression(value, n => this.lookup(n))
    return String(append ? (Number(this.lookup(name)) || 0) + result : result)
  }

  isInteger(name: string): boolean { return this.integerNames.has(name) }

  /** `declare -i` / `declare +i`; marking an existing value converts it, as bash does. */
  setInteger(name: string, on: boolean): void {
    if (!on) { this.integerNames.delete(name); return }
    this.integerNames.add(name)
    const current = this.lookup(name)
    if (current !== undefined && !this.readonlyNames.has(name)) this.set(name, current)
  }

  /** Removes a variable; inside a function, one a frame declared is hidden rather than deleted. */
  unset(name: string): void {
    name = this.namerefNames.has(name) ? this.resolveName(name) : name
    if (this.readonlyNames.has(name)) throw new Error(`${name}: cannot unset: readonly variable`)
    for (let i = this.localScopes.length - 1; i >= 0; i--) {
      const frame = this.localScopes[i] as Map<string, string | undefined>
      if (frame.has(name)) { frame.set(name, undefined); return }
    }
    this.vars.delete(name)
    if (name in DEFAULT_VARIABLES) this.removedDefaults.add(name)
    this.unexported.delete(name)
    this.integerNames.delete(name)
  }

  /** `export NAME`: children inherit it from now on. */
  markExported(name: string): void {
    this.unexported.delete(name)
  }

  isExported(name: string): boolean {
    return this.vars.has(name) && !this.unexported.has(name) && !isInternalVariable(name)
  }

  /** What a child process inherits: exported variables only, never the shell's internal names. */
  environment(): Record<string, string> {
    const env: Record<string, string> = {}
    // a `local` shadows the variable of the same name for the children of a command run inside the function
    for (const [name, value] of this.visibleVariables()) if (!this.unexported.has(name)) env[name] = value
    return env
  }

  /** Every variable currently visible, `local` frames applied, internal names left out. */
  visibleVariables(): Map<string, string> {
    const visible = new Map<string, string>()
    for (const [key, value] of this.vars) if (!isInternalVariable(key)) visible.set(key, value)
    for (const frame of this.localScopes) {
      for (const [key, value] of frame) {
        if (isInternalVariable(key)) continue
        if (value === undefined) visible.delete(key)
        else visible.set(key, value)
      }
    }
    return visible
  }

  isReadonly(name: string): boolean { return this.readonlyNames.has(name) }
  markReadonly(name: string): void { this.readonlyNames.add(name) }

  // - local frames -------------------------------------------------------------------------------

  pushLocalScope(): void {
    this.localScopes.push(new Map())
    this.localArrayScopes.push(new Map())
  }

  popLocalScope(): void {
    this.localScopes.pop()
    this.localArrayScopes.pop()
  }

  get inFunction(): boolean { return this.localScopes.length > 0 }

  /**
   * `local NAME[=VALUE]`. With no value the name is declared and left *unset*, not empty, which is
   * what bash does: `${NAME+set}` is empty and `set -u` still objects. It is declared in the array
   * namespace too, holding nothing, so `local arr` then `arr=(1 2)` does not write the caller's array.
   */
  /** True when a function frame has declared `name`, even without a value. */
  isDeclared(name: string): boolean {
    return this.localScopes.some(frame => frame.has(name))
  }

  /** Assigns the shell's own variable, past any `local` of the same name: `declare -g`. */
  setGlobal(name: string, value: string): void {
    if (this.readonlyNames.has(name)) throw new Error(`${name}: readonly variable`)
    this.removedDefaults.delete(name)
    if (!this.vars.has(name)) this.unexported.add(name)
    this.vars.set(name, value)
  }

  declareLocal(name: string, value?: string): void {
    const frame = this.localScopes[this.localScopes.length - 1]
    const arrayFrame = this.localArrayScopes[this.localArrayScopes.length - 1]
    if (!frame || !arrayFrame) throw new Error('local: can only be used inside a function')
    frame.set(name, value)
    if (!arrayFrame.has(name)) arrayFrame.set(name, undefined)
  }

  // - arrays -------------------------------------------------------------------------------------

  /** Every array currently visible, `local` frames applied. */
  visibleArrays(): Map<string, ArrayStore> {
    if (this.localArrayScopes.length === 0) return this.arrays
    const visible = new Map(this.arrays)
    for (const frame of this.localArrayScopes) {
      for (const [key, value] of frame) {
        if (value === undefined) visible.delete(key)
        else visible.set(key, value)
      }
    }
    return visible
  }

  private arrayFrameFor(name: string): Map<string, ArrayStore | undefined> | undefined {
    for (let i = this.localArrayScopes.length - 1; i >= 0; i--) {
      const frame = this.localArrayScopes[i] as Map<string, ArrayStore | undefined>
      if (frame.has(name)) return frame
    }
    return undefined
  }

  lookupArray(name: string): ArrayStore | undefined {
    name = this.resolveName(name)
    const frame = this.arrayFrameFor(name)
    return (frame ? frame.get(name) : this.arrays.get(name)) ?? this.defaultArray(name)
  }

  /** Arrays that read as something until the script assigns its own: `BASH_VERSINFO`, `GROUPS` and `DIRSTACK`. */
  private defaultArray(name: string): ArrayStore | undefined {
    if (name === 'BASH_VERSINFO') return new Map(BASH_VERSINFO.map((value, index) => [index, value]))
    if (name === 'DIRSTACK') return new Map([this.vars.get('PWD') ?? '/', ...this.dirStack].map((value, index) => [index, value]))
    if (name === 'GROUPS') {
      const groups = this.identity.groups?.()
      return groups ? new Map(groups.map((value, index) => [index, value])) : undefined
    }
    return undefined
  }

  private storeArray(name: string, array: ArrayStore): void {
    const frame = this.arrayFrameFor(name)
    if (frame) frame.set(name, array)
    else this.arrays.set(name, array)
  }

  setArray(name: string, values: string[]): void {
    name = this.resolveName(name)
    this.storeArray(name, new Map(values.map((value, index) => [index, value])))
  }

  isAssoc(name: string): boolean { return this.assocNames.has(name) }

  /** `declare -A NAME`: an empty associative array, unless one is already there. */
  declareAssoc(name: string): void {
    this.assocNames.add(name)
    if (!this.lookupArray(name)) this.storeArray(name, new Map())
  }

  /** `NAME=([k]=v ...)` and, with `append`, `NAME+=(...)`. */
  setAssoc(name: string, entries: Array<[string, string]>, append: boolean): void {
    const array: ArrayStore = append ? (this.lookupArray(name) ?? new Map()) : new Map()
    for (const [key, value] of entries) array.set(key, value)
    this.storeArray(name, array)
  }

  setArrayElement(name: string, index: number | string, value: string): void {
    name = this.resolveName(name)
    const array = this.lookupArray(name) ?? new Map() as ArrayStore
    array.set(index, value)
    this.storeArray(name, array)
  }

  appendArray(name: string, values: string[]): void {
    name = this.resolveName(name)
    const array = this.lookupArray(name) ?? new Map() as ArrayStore
    const nextIndex = array.size ? Math.max(...[...array.keys()].map(Number)) + 1 : 0
    values.forEach((value, i) => array.set(nextIndex + i, value))
    this.storeArray(name, array)
  }

  unsetArrayElement(name: string, index: number | string): void {
    name = this.resolveName(name)
    this.lookupArray(name)?.delete(index)
  }

  unsetArray(name: string): void {
    name = this.resolveName(name)
    const frame = this.arrayFrameFor(name)
    if (frame) frame.set(name, undefined)
    else { this.arrays.delete(name); this.assocNames.delete(name) }
  }

  // - traps and options --------------------------------------------------------------------------

  setTrap(handler: string | undefined, signal: string): void {
    const name = signal.replace(/^SIG/, '').toUpperCase()
    if (handler === undefined) this.traps.delete(name)
    else this.traps.set(name, handler)
  }

  getTrap(signal: string): string | undefined {
    return this.traps.get(signal.replace(/^SIG/, '').toUpperCase())
  }

  listTraps(): Array<[string, string]> {
    return [...this.traps.entries()]
  }

  setOption(flag: ShellOptionName, enabled: boolean): void {
    this.options[flag] = enabled
  }

  /**
   * A snapshot for a subshell: variables, arrays, functions, aliases, traps, options and the
   * positional state the caller passes in. {@link restore} puts it back.
   */
  snapshot(): ShellSnapshot {
    return {
      vars: new Map(this.vars),
      unexported: new Set(this.unexported),
      assoc: new Set(this.assocNames),
      arrays: new Map([...this.arrays].map(([name, array]) => [name, new Map(array) as ArrayStore])),
      functions: new Map(this.functions),
      aliases: new Map(this.aliases),
      traps: new Map(this.traps),
      options: { ...this.options },
      shopts: new Set(this.shopts),
      dirStack: [...this.dirStack],
    }
  }

  /** Restores a copy of `snapshot`, so the same snapshot can be restored again later. */
  restoreCopy(snapshot: ShellSnapshot): void {
    this.restore({
      vars: new Map(snapshot.vars),
      unexported: new Set(snapshot.unexported),
      assoc: new Set(snapshot.assoc),
      arrays: new Map([...snapshot.arrays].map(([name, array]) => [name, new Map(array) as ArrayStore])),
      functions: new Map(snapshot.functions),
      aliases: new Map(snapshot.aliases),
      traps: new Map(snapshot.traps),
      options: { ...snapshot.options },
      shopts: new Set(snapshot.shopts),
      dirStack: [...(snapshot.dirStack ?? [])],
    })
  }

  restore(snapshot: ShellSnapshot): void {
    this.vars = snapshot.vars
    this.unexported.clear()
    for (const name of snapshot.unexported) this.unexported.add(name)
    this.arrays = snapshot.arrays
    this.assocNames.clear()
    for (const name of snapshot.assoc) this.assocNames.add(name)
    this.functions = snapshot.functions
    this.aliases = snapshot.aliases
    this.traps = snapshot.traps
    this.options = snapshot.options
    this.shopts = snapshot.shopts
    this.dirStack = snapshot.dirStack ?? []
  }
}

export interface ShellSnapshot {
  vars: Map<string, string>
  unexported: Set<string>
  arrays: Map<string, ArrayStore>
  assoc: Set<string>
  functions: Map<string, Statement[]>
  aliases: Map<string, string>
  traps: Map<string, string>
  options: ShellOptions
  shopts: Set<string>
  dirStack?: string[]
}

/**
 * A snapshot as JSON text, for handing a shell's state to another process (a background subshell:
 * there is no `fork`, so the child is started fresh and given the state it would have inherited).
 * Functions are statement trees, which are plain data, so they survive as they are.
 */
export function serializeSnapshot(snapshot: ShellSnapshot): string {
  return JSON.stringify({
    vars: [...snapshot.vars],
    unexported: [...snapshot.unexported],
    assoc: [...snapshot.assoc],
    arrays: [...snapshot.arrays].map(([name, array]) => [name, [...array]]),
    functions: [...snapshot.functions],
    aliases: [...snapshot.aliases],
    traps: [...snapshot.traps],
    options: snapshot.options,
    shopts: [...snapshot.shopts],
  })
}

export function deserializeSnapshot(text: string): ShellSnapshot {
  const data = JSON.parse(text)
  return {
    vars: new Map(data.vars),
    unexported: new Set(data.unexported),
    assoc: new Set(data.assoc),
    arrays: new Map(data.arrays.map(([name, entries]: [string, Array<[number | string, string]>]) => [name, new Map(entries) as ArrayStore])),
    functions: new Map(data.functions),
    aliases: new Map(data.aliases),
    traps: new Map(data.traps),
    options: data.options,
    shopts: new Set(data.shopts ?? []),
  }
}
