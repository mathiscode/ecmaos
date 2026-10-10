/**
 * What `complete` registers: how to complete the arguments of one command. A spec is plain data, so it can
 * be printed back as the `complete` command that makes it (`complete -p`) and read by whichever host
 * completes. The registry lives on {@link ShellState}.
 */

export interface CompletionSpec {
  /** `-a`, `-b`, ... and `-A NAME`, as the action names `compgen -A` takes. */
  actions: string[]
  /** `-o`: default, dirnames, filenames, nospace, nosort, bashdefault, plusdirs, noquote. */
  options: string[]
  wordlist?: string
  glob?: string
  function?: string
  command?: string
  filter?: string
  prefix?: string
  suffix?: string
}

export const emptySpec = (): CompletionSpec => ({ actions: [], options: [] })

/** Single-letter action flags and the action each stands for, in the order `complete -p` prints them. */
export const ACTION_LETTERS: ReadonlyArray<readonly [string, string]> = [
  ['a', 'alias'], ['b', 'builtin'], ['c', 'command'], ['d', 'directory'], ['e', 'export'], ['f', 'file'],
  ['g', 'group'], ['j', 'job'], ['k', 'keyword'], ['s', 'service'], ['u', 'user'], ['v', 'variable'],
]

/** Every name `-A` takes. */
export const ACTION_NAMES: readonly string[] = [
  ...ACTION_LETTERS.map(([, name]) => name),
  'arrayvar', 'binding', 'disabled', 'enabled', 'function', 'helptopic', 'hostname', 'running', 'setopt', 'shopt', 'signal', 'stopped',
].sort()

export const OPTION_NAMES: readonly string[] = ['bashdefault', 'default', 'dirnames', 'filenames', 'noquote', 'nosort', 'nospace', 'plusdirs']

export class CompletionRegistry {
  readonly commands = new Map<string, CompletionSpec>()
  /** `-D`: a command with no spec of its own. `-E`: an empty line. `-I`: the first word. */
  fallback?: CompletionSpec
  empty?: CompletionSpec
  initial?: CompletionSpec
  /** The spec being run, so `compopt` inside a completion function can change its options. */
  active?: CompletionSpec

  /** The spec for the word at `index` of a line: the command's own, its basename's, or the fallback. */
  find(words: readonly string[], index: number): CompletionSpec | undefined {
    if (words.length <= 1 && (words[0] ?? '') === '' && this.empty) return this.empty
    if (index === 0) return this.initial
    const command = words[0] ?? ''
    return this.commands.get(command) ?? this.commands.get(command.split('/').pop() ?? command) ?? this.fallback
  }
}

const quote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`

/** The `complete` command that registers `spec` for `target` (a name, or `-D`, `-E`, `-I`). */
export function formatSpec(spec: CompletionSpec, target: string): string {
  const parts = ['complete']
  for (const option of [...spec.options].sort()) parts.push('-o', option)
  const letters = ACTION_LETTERS.filter(([, name]) => spec.actions.includes(name))
  for (const [letter] of letters) parts.push(`-${letter}`)
  for (const action of spec.actions) if (!letters.some(([, name]) => name === action)) parts.push('-A', action)
  if (spec.glob !== undefined) parts.push('-G', quote(spec.glob))
  if (spec.wordlist !== undefined) parts.push('-W', quote(spec.wordlist))
  if (spec.prefix !== undefined) parts.push('-P', quote(spec.prefix))
  if (spec.suffix !== undefined) parts.push('-S', quote(spec.suffix))
  if (spec.filter !== undefined) parts.push('-X', quote(spec.filter))
  if (spec.command !== undefined) parts.push('-C', quote(spec.command))
  if (spec.function !== undefined) parts.push('-F', spec.function)
  parts.push(target)
  return parts.join(' ')
}
