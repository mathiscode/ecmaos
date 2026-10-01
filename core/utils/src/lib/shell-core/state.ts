/**
 * The state of a shell, independent of how it runs commands: variables and which of them children
 * inherit, indexed arrays, `local` frames, `readonly`, functions, aliases, traps, `set` options, and
 * the special parameters that are computed on each read. Both the kernel shell and `/bin/ecmash` hold
 * one of these, so a scoping or export rule is written once.
 *
 * Positional parameters and `$?` stay with each shell for now: the kernel keeps them in `vars` as
 * `1`, `2`, `?`, and `ecmash` keeps them as fields.
 */

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
}

/** Shell-internal names: never part of a child's environment, whatever else is true of them. */
const INTERNAL_NAMES: ReadonlySet<string> = new Set(['?', '$', '!', '-', '_'])

/** Whether `name` is shell-internal state (`$?`, `$$`, the positional parameters) rather than a variable. */
export function isInternalVariable(name: string): boolean {
  return INTERNAL_NAMES.has(name) || /^\d+$/.test(name)
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

  functions = new Map<string, Statement[]>()

  /** `alias` definitions, substituted at command position as text. */
  aliases = new Map<string, string>()

  /**
   * `trap` handlers by signal name without the `SIG` prefix (`INT`, `EXIT`, `ERR`, ...). A `''`
   * handler means ignore the signal.
   */
  traps = new Map<string, string>()

  options: ShellOptions = { errexit: false, nounset: false, pipefail: false, xtrace: false, noglob: false, noclobber: false, verbose: false }

  /** `getopts`' position inside a cluster such as `-abc` */
  getoptsCharIndex = 1

  /** `$!`, undefined until something has been put in the background */
  lastBackgroundPid: number | undefined

  /** `$LINENO` */
  lineNumber = 0

  private randomState = Math.floor(Math.random() * 0x7fffffff) + 1
  private secondsOrigin = Date.now()

  constructor(private readonly identity: ShellIdentity, vars: Map<string, string> = new Map()) {
    this.vars = vars
  }

  /** Replaces the variable store with the host's own map, keeping the rest of the state. */
  adopt(vars: Map<string, string>): void {
    this.vars = vars
  }

  // -- variables ----------------------------------------------------------------------------------

  /**
   * A variable by name the way `local` scoping requires: the innermost frame that declares it, then
   * the computed parameters, then the variables. A computed parameter sits behind the frames so that
   * `local RANDOM` can shadow it, but a plain `RANDOM=42` cannot replace it: that seeds it instead.
   */
  lookup(name: string): string | undefined {
    for (let i = this.localScopes.length - 1; i >= 0; i--) {
      const frame = this.localScopes[i] as Map<string, string | undefined>
      if (frame.has(name)) return frame.get(name)
    }
    const computed = this.computed(name)
    if (computed !== undefined) return computed
    return this.vars.get(name)
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
   * Assigns a variable. Throws for a readonly name. Inside a function an assignment lands in the
   * innermost frame, which is only correct for a name that frame declared; callers that mean "global
   * unless local" go through {@link declareLocal} first.
   */
  set(name: string, value: string, append = false): void {
    if (this.readonlyNames.has(name)) throw new Error(`${name}: readonly variable`)
    if (this.integerNames.has(name)) value = this.integerValue(name, value, append)
    else if (append) value = (this.lookup(name) ?? '') + value
    const frame = this.localScopes[this.localScopes.length - 1]
    if (frame) { frame.set(name, value); return }

    // Assigning to a computed parameter adjusts what it computes rather than replacing it, which is
    // bash's behavior: `RANDOM=42` seeds the generator and `SECONDS=0` restarts the clock.
    if (name === 'RANDOM' && /^\d+$/.test(value)) { this.randomState = Number(value) >>> 0 || 1; return }
    if (name === 'SECONDS' && /^\d+$/.test(value)) { this.secondsOrigin = Date.now() - Number(value) * 1000; return }
    // Restarting the option scan restarts it fully, cluster cursor included.
    if (name === 'OPTIND') this.getoptsCharIndex = 1

    if (!this.vars.has(name)) this.unexported.add(name)
    this.vars.set(name, value)
  }

  /** What an assignment to a `-i` name stores: the right side evaluated as arithmetic, added to the old value for `+=`. */
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
    if (this.readonlyNames.has(name)) throw new Error(`${name}: cannot unset: readonly variable`)
    for (let i = this.localScopes.length - 1; i >= 0; i--) {
      const frame = this.localScopes[i] as Map<string, string | undefined>
      if (frame.has(name)) { frame.set(name, undefined); return }
    }
    this.vars.delete(name)
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
    for (const [name, value] of this.vars) if (!isInternalVariable(name) && !this.unexported.has(name)) env[name] = value
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

  // -- local frames -------------------------------------------------------------------------------

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
  declareLocal(name: string, value?: string): void {
    const frame = this.localScopes[this.localScopes.length - 1]
    const arrayFrame = this.localArrayScopes[this.localArrayScopes.length - 1]
    if (!frame || !arrayFrame) throw new Error('local: can only be used inside a function')
    frame.set(name, value)
    if (!arrayFrame.has(name)) arrayFrame.set(name, undefined)
  }

  // -- arrays -------------------------------------------------------------------------------------

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
    const frame = this.arrayFrameFor(name)
    return frame ? frame.get(name) : this.arrays.get(name)
  }

  private storeArray(name: string, array: ArrayStore): void {
    const frame = this.arrayFrameFor(name)
    if (frame) frame.set(name, array)
    else this.arrays.set(name, array)
  }

  setArray(name: string, values: string[]): void {
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
    const array = this.lookupArray(name) ?? new Map() as ArrayStore
    array.set(index, value)
    this.storeArray(name, array)
  }

  appendArray(name: string, values: string[]): void {
    const array = this.lookupArray(name) ?? new Map() as ArrayStore
    const nextIndex = array.size ? Math.max(...[...array.keys()].map(Number)) + 1 : 0
    values.forEach((value, i) => array.set(nextIndex + i, value))
    this.storeArray(name, array)
  }

  unsetArrayElement(name: string, index: number | string): void {
    this.lookupArray(name)?.delete(index)
  }

  unsetArray(name: string): void {
    const frame = this.arrayFrameFor(name)
    if (frame) frame.set(name, undefined)
    else { this.arrays.delete(name); this.assocNames.delete(name) }
  }

  // -- traps and options --------------------------------------------------------------------------

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
    }
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
}
