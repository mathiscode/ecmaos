/**
 * The words a completion action can offer: what `compgen -A ACTION` prints, and what a `complete` spec
 * draws on when Tab is pressed. Each returns candidates that start with `word`; nothing here reads a
 * terminal, so `compgen` in a script and Tab at a prompt give the same answer.
 */

import type { BuiltinHost } from './builtins.js'
import { CONTROL_FLOW_KEYWORDS } from '../control-flow-parser.js'
import { helpTopicNames } from './help.js'
import { SHOPT_NAMES } from './shopt-names.js'
import { signalNameList } from './signal-table.js'

/** Reserved words that are not control-flow keywords. */
const MORE_KEYWORDS = ['!', '[[', ']]', '{', '}', 'time', 'coproc']
const SETOPT_NAMES = ['errexit', 'noclobber', 'noglob', 'nounset', 'pipefail', 'verbose', 'xtrace']

const startsWith = (word: string) => (name: string) => name.startsWith(word)

/** Lines of `/etc/passwd`-style files: the first field of each. */
async function firstFields(host: BuiltinHost, file: string): Promise<string[]> {
  try {
    return (await host.readFile(file)).split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split(':')[0] as string)
  } catch { return [] }
}

/** Names of programs on `$PATH`. */
async function pathCommands(host: BuiltinHost, word: string): Promise<string[]> {
  const found: string[] = []
  if (!host.listDir) return found
  for (const dir of (host.state.lookup('PATH') ?? '').split(':')) {
    if (!dir) continue
    try { found.push(...(await host.listDir(dir)).filter(startsWith(word))) } catch { /* a PATH entry that is not there is normal */ }
  }
  return found
}

/** Entries of the directory `word` names, written as typed (`src/ma` gives `src/main.ts`). Directories only when `directoriesOnly`. */
export async function pathCandidates(host: BuiltinHost, word: string, directoriesOnly: boolean): Promise<string[]> {
  if (!host.listDir) return []
  const typed = word
  const expanded = host.expandTilde ? host.expandTilde(word) : word
  const slash = expanded.lastIndexOf('/')
  const directory = slash === -1 ? host.cwd() : host.resolvePath(expanded.slice(0, slash + 1))
  const stem = slash === -1 ? expanded : expanded.slice(slash + 1)
  // the part of the word as the user typed it, which the candidates keep (`~/` stays `~/`)
  const lead = typed.slice(0, typed.lastIndexOf('/') + 1)
  let names: string[]
  try { names = await host.listDir(directory) } catch { return [] }
  const out: string[] = []
  for (const name of names.filter(startsWith(stem)).sort()) {
    if (directoriesOnly) {
      const info = await host.stat(`${directory.replace(/\/$/, '')}/${name}`)
      if (!info?.directory) continue
    }
    out.push(lead + name)
  }
  return out
}

/** The candidates for one action name, or undefined when the name is not an action. */
export async function actionCandidates(host: BuiltinHost, action: string, word: string): Promise<string[] | undefined> {
  const state = host.state
  const names = (): string[] => [...(host.builtinNames?.() ?? [])]
  switch (action) {
    case 'alias': return [...state.aliases.keys()].filter(startsWith(word))
    case 'builtin': case 'enabled': return names().filter(startsWith(word))
    case 'disabled': case 'running': case 'stopped': case 'binding': case 'service': case 'hostname': case 'job': return []
    case 'command': {
      const all = [...state.aliases.keys(), ...CONTROL_FLOW_KEYWORDS, ...MORE_KEYWORDS, ...state.functions.keys(), ...names(), ...await pathCommands(host, word)]
      return all.filter(startsWith(word))
    }
    case 'directory': return pathCandidates(host, word, true)
    case 'file': return pathCandidates(host, word, false)
    case 'export': return [...state.vars.keys()].filter(name => !state.unexported.has(name) && /^[A-Za-z_]\w*$/.test(name)).filter(startsWith(word))
    case 'function': return [...state.functions.keys()].filter(startsWith(word))
    case 'group': return (await firstFields(host, '/etc/group')).filter(startsWith(word))
    case 'user': return (await firstFields(host, '/etc/passwd')).filter(startsWith(word))
    case 'helptopic': return helpTopicNames.filter(startsWith(word))
    case 'keyword': return [...CONTROL_FLOW_KEYWORDS, ...MORE_KEYWORDS].filter(startsWith(word))
    case 'setopt': return SETOPT_NAMES.filter(startsWith(word))
    case 'shopt': return SHOPT_NAMES.filter(startsWith(word))
    case 'signal': return signalNameList().map(name => `SIG${name}`).filter(startsWith(word))
    case 'arrayvar': return [...state.arrays.keys()].filter(startsWith(word))
    case 'variable': return [...new Set([...state.vars.keys(), ...state.arrays.keys()])].filter(name => /^[A-Za-z_]\w*$/.test(name)).filter(startsWith(word))
    default: return undefined
  }
}
