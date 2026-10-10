/**
 * `compgen`, `complete` and `compopt`: programmable completion's three builtins.
 *
 * `compgen` generates candidates and works anywhere, in a script too. `complete` registers a spec in
 * {@link ShellState.completions}; what Tab does with it is in `programmable-completion.ts`. `compopt`
 * changes the options of the completion being run, so it is an error anywhere else, as in bash.
 */

import type { BuiltinHost, BuiltinIO } from './builtins.js'
import { ACTION_LETTERS, ACTION_NAMES, OPTION_NAMES, emptySpec, formatSpec, type CompletionSpec } from './completion-spec.js'
import { actionCandidates } from './completion-sources.js'

const COMPLETE_USAGE = 'complete: usage: complete [-abcdefgjksuv] [-pr] [-DEI] [-o option] [-A action] [-G globpat] [-W wordlist] [-F function] [-C command] [-X filterpat] [-P prefix] [-S suffix] [name ...]'
const COMPGEN_USAGE = 'compgen: usage: compgen [-abcdefgjksuv] [-o option] [-A action] [-G globpat] [-W wordlist] [-F function] [-C command] [-X filterpat] [-P prefix] [-S suffix] [word]'

interface Parsed {
  spec: CompletionSpec
  print: boolean
  remove: boolean
  /** `-D`, `-E`, `-I` */
  targets: string[]
  operands: string[]
}

/** The options `complete` and `compgen` share. Returns a message when they are wrong. */
function parseOptions(name: 'complete' | 'compgen', argv: string[]): Parsed | { error: string, status: number } {
  const spec = emptySpec()
  const parsed: Parsed = { spec, print: false, remove: false, targets: [], operands: [] }
  const usage = name === 'complete' ? COMPLETE_USAGE : COMPGEN_USAGE
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--') { parsed.operands.push(...argv.slice(i + 1)); break }
    if (arg.length < 2 || !arg.startsWith('-')) { parsed.operands.push(arg); continue }
    for (let j = 1; j < arg.length; j++) {
      const letter = arg[j] as string
      const action = ACTION_LETTERS.find(([l]) => l === letter)
      if (action) { if (!spec.actions.includes(action[1])) spec.actions.push(action[1]); continue }
      if (letter === 'p' && name === 'complete') { parsed.print = true; continue }
      if (letter === 'r' && name === 'complete') { parsed.remove = true; continue }
      if ('DEI'.includes(letter) && name === 'complete') { parsed.targets.push(`-${letter}`); continue }
      if ('oAGWFCXPS'.includes(letter)) {
        const rest = arg.slice(j + 1)
        const value = rest !== '' ? rest : argv[++i]
        if (value === undefined) return { error: `${name}: -${letter}: option requires an argument\n${usage}`, status: 2 }
        if (letter === 'o') {
          if (!OPTION_NAMES.includes(value)) return { error: `${name}: ${value}: invalid option name`, status: 2 }
          if (!spec.options.includes(value)) spec.options.push(value)
        } else if (letter === 'A') {
          if (!ACTION_NAMES.includes(value)) return { error: `${name}: ${value}: invalid action name`, status: 2 }
          if (!spec.actions.includes(value)) spec.actions.push(value)
        } else if (letter === 'G') spec.glob = value
        else if (letter === 'W') spec.wordlist = value
        else if (letter === 'F') spec.function = value
        else if (letter === 'C') spec.command = value
        else if (letter === 'X') spec.filter = value
        else if (letter === 'P') spec.prefix = value
        else spec.suffix = value
        break
      }
      return { error: `${name}: -${letter}: invalid option\n${usage}`, status: 2 }
    }
  }
  return parsed
}

/** Candidates for `word` from everything a spec draws on that needs no function or command: actions, glob, wordlist. */
export async function staticCandidates(host: BuiltinHost, spec: CompletionSpec, word: string): Promise<string[]> {
  const out: string[] = []
  for (const action of spec.actions) out.push(...(await actionCandidates(host, action, word)) ?? [])
  if (spec.glob !== undefined) {
    // a glob is matched against the files that exist, as in bash's `-G`
    for (const field of await host.interpreter.host.expandWords(spec.glob)) if (field.startsWith(word)) out.push(field)
  }
  if (spec.wordlist !== undefined) {
    for (const field of await host.interpreter.host.expandWords(spec.wordlist)) if (field.startsWith(word)) out.push(field)
  }
  return out
}

/** `-X`: a pattern that removes matching words, or with a leading `!` keeps only them. */
export function applyFilter(host: BuiltinHost, filter: string | undefined, words: string[]): string[] {
  if (filter === undefined) return words
  const negate = filter.startsWith('!')
  const pattern = negate ? filter.slice(1) : filter
  return words.filter(word => host.interpreter.host.matchesPattern(word, pattern) === negate)
}

export function applyAffixes(spec: CompletionSpec, words: string[]): string[] {
  return words.map(word => `${spec.prefix ?? ''}${word}${spec.suffix ?? ''}`)
}

export async function compgenBuiltin(host: BuiltinHost, argv: string[], io: BuiltinIO): Promise<number> {
  if (argv[0] === '--help') {
    await io.writeln(`Usage: compgen [-abcdefgjksuv] [-A ACTION] [-G GLOBPAT] [-W WORDLIST] [-X FILTERPAT] [-P PREFIX] [-S SUFFIX] [-o OPTION] [WORD]\nPrint the possible completions of WORD, one per line. Status 1 when there are none.\n  -a alias  -b builtin  -c command  -d directory  -e exported variable  -f file  -g group\n  -k keyword  -u user  -v variable  -A also takes: ${ACTION_NAMES.join(', ')}`)
    return 0
  }
  const parsed = parseOptions('compgen', argv)
  if ('error' in parsed) { await io.writelnErr(parsed.error); return parsed.status }
  if (parsed.operands.length > 1) { await io.writelnErr('compgen: too many arguments'); return 2 }

  const word = parsed.operands[0] ?? ''
  const candidates = applyAffixes(parsed.spec, applyFilter(host, parsed.spec.filter, await staticCandidates(host, parsed.spec, word)))
  if (candidates.length === 0) return 1
  await io.write(candidates.map(candidate => `${candidate}\n`).join(''))
  return 0
}

export async function completeBuiltin(host: BuiltinHost, argv: string[], io: BuiltinIO): Promise<number> {
  if (argv[0] === '--help') {
    await io.writeln('Usage: complete [-abcdefgjksuv] [-pr] [-DEI] [-o OPTION] [-A ACTION] [-G GLOBPAT] [-W WORDLIST] [-F FUNCTION] [-C COMMAND] [-X FILTERPAT] [-P PREFIX] [-S SUFFIX] [NAME ...]\nSpecify how arguments are completed. -p prints the specifications, -r removes them;\n-D, -E and -I set the fallback, the empty line and the first word.')
    return 0
  }
  const parsed = parseOptions('complete', argv)
  if ('error' in parsed) { await io.writelnErr(parsed.error); return parsed.status }

  const registry = host.state.completions
  const named = (target: string): CompletionSpec | undefined =>
    target === '-D' ? registry.fallback : target === '-E' ? registry.empty : target === '-I' ? registry.initial : registry.commands.get(target)
  const labels = [...parsed.targets, ...parsed.operands]

  if (parsed.print || (argv.length === 0)) {
    let status = 0
    if (labels.length === 0) {
      for (const [target, spec] of [['-I', registry.initial], ['-D', registry.fallback], ['-E', registry.empty]] as const) if (spec) await io.writeln(formatSpec(spec, target))
      for (const [command, spec] of registry.commands) await io.writeln(formatSpec(spec, command))
      return 0
    }
    for (const label of labels) {
      const spec = named(label)
      if (spec) await io.writeln(formatSpec(spec, label))
      else { await io.writelnErr(`complete: ${label}: no completion specification`); status = 1 }
    }
    return status
  }

  if (parsed.remove) {
    if (labels.length === 0) {
      registry.commands.clear(); registry.fallback = registry.empty = registry.initial = undefined
      return 0
    }
    let status = 0
    for (const label of labels) {
      if (label === '-D') registry.fallback = undefined
      else if (label === '-E') registry.empty = undefined
      else if (label === '-I') registry.initial = undefined
      else if (!registry.commands.delete(label)) { await io.writelnErr(`complete: ${label}: no completion specification`); status = 1 }
    }
    return status
  }

  if (labels.length === 0) { await io.writelnErr(COMPLETE_USAGE); return 2 }
  for (const label of labels) {
    const spec: CompletionSpec = { ...parsed.spec, actions: [...parsed.spec.actions], options: [...parsed.spec.options] }
    if (label === '-D') registry.fallback = spec
    else if (label === '-E') registry.empty = spec
    else if (label === '-I') registry.initial = spec
    else registry.commands.set(label, spec)
  }
  return 0
}

export async function compoptBuiltin(host: BuiltinHost, argv: string[], io: BuiltinIO): Promise<number> {
  if (argv[0] === '--help') {
    await io.writeln('Usage: compopt [-o|+o OPTION] [-DEI] [NAME ...]\nChange the completion options of NAME, or of the completion being run. -o turns one on, +o off.')
    return 0
  }
  const changes: Array<[boolean, string]> = []
  const names: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '-o' || arg === '+o') {
      const value = argv[++i]
      if (value === undefined) { await io.writelnErr(`compopt: ${arg}: option requires an argument`); return 2 }
      if (!OPTION_NAMES.includes(value)) { await io.writelnErr(`compopt: ${value}: invalid option name`); return 1 }
      changes.push([arg === '-o', value])
    } else if (arg === '-D' || arg === '-E' || arg === '-I') names.push(arg)
    else if (arg.startsWith('-') || arg.startsWith('+')) { await io.writelnErr(`compopt: ${arg}: invalid option\ncompopt: usage: compopt [-o|+o option] [-DEI] [name ...]`); return 2 }
    else names.push(arg)
  }

  const registry = host.state.completions
  const targets: CompletionSpec[] = []
  if (names.length === 0) {
    if (!registry.active) { await io.writelnErr('compopt: not currently executing completion function'); return 1 }
    targets.push(registry.active)
  } else {
    for (const name of names) {
      const spec = name === '-D' ? registry.fallback : name === '-E' ? registry.empty : name === '-I' ? registry.initial : registry.commands.get(name)
      if (!spec) { await io.writelnErr(`compopt: ${name}: no completion specification`); return 1 }
      targets.push(spec)
    }
  }
  for (const spec of targets) {
    for (const [on, option] of changes) {
      spec.options = spec.options.filter(existing => existing !== option)
      if (on) spec.options.push(option)
    }
  }
  return 0
}
