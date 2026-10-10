/**
 * What Tab does when `complete` has registered a spec for the command being typed: bash's programmable
 * completion, minus readline. The spec's actions, glob and word list are static; `-F` runs a shell function
 * that fills `COMPREPLY` from `COMP_WORDS` and `COMP_CWORD`, and `-C` runs a command whose output lines are the
 * candidates. Both run in the shell that is completing, as in bash, so a function can read the shell's variables.
 *
 * Returns whole-line replacements, which is the form the terminal and `ecmash` already cycle through, or
 * `undefined` when no spec applies and the ordinary completion should answer.
 */

import { applyAffixes, applyFilter, staticCandidates } from './builtin-complete.js'
import type { BuiltinHost } from './builtins.js'
import type { CompletionSpec } from './completion-spec.js'
import { pathCandidates } from './completion-sources.js'

const ESCAPE = /([ ()[\]{}|&;<>`$"'\\])/g
const quote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`

/** The words of a line as the shell would split it, with quotes kept; a trailing space starts an empty last word. */
export function splitLine(line: string): string[] {
  const words: string[] = []
  let current = ''
  let quoteChar = ''
  let started = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i] as string
    if (quoteChar) {
      current += char
      if (char === quoteChar) quoteChar = ''
      else if (char === '\\' && quoteChar === '"' && i + 1 < line.length) current += line[++i]
    } else if (char === '\\' && i + 1 < line.length) { current += char + line[++i]; started = true }
    else if (char === '"' || char === "'") { quoteChar = char; current += char; started = true }
    else if (char === ' ' || char === '\t') { if (started) { words.push(current); current = ''; started = false } }
    else { current += char; started = true }
  }
  words.push(current)
  return words
}

/** Runs the spec's function or command, returning what it produced; `undefined` asks for the spec to be looked up again (status 124). */
async function dynamicCandidates(host: BuiltinHost, spec: CompletionSpec, words: string[], line: string): Promise<{ words: string[], retry: boolean }> {
  const state = host.state
  const interpreter = host.interpreter
  const cword = words.length - 1
  const command = words[0] ?? ''
  const cur = words[cword] ?? ''
  const prev = words[cword - 1] ?? ''

  const scalars: Record<string, string> = { COMP_CWORD: String(cword), COMP_LINE: line, COMP_POINT: String(line.length), COMP_TYPE: '9', COMP_KEY: '9' }
  const names = [...Object.keys(scalars), 'COMP_WORDS', 'COMPREPLY', 'COMP_CMD_OUT']
  const before = interpreter.host.getStatus()
  const lineNumber = state.lineNumber
  for (const [name, value] of Object.entries(scalars)) { state.set(name, value); state.unexported.add(name) }
  state.setArray('COMP_WORDS', words)
  state.setArray('COMPREPLY', [])
  state.completions.active = spec

  const out: string[] = []
  let retry = false
  try {
    if (spec.function) {
      if (state.functions.has(spec.function)) {
        const status = await interpreter.runText(`${spec.function} ${quote(command)} ${quote(cur)} ${quote(prev)}`)
        retry = status === 124
        const reply = state.lookupArray('COMPREPLY')
        if (reply) out.push(...[...reply.entries()].sort(([a], [b]) => Number(a) - Number(b)).map(([, value]) => value))
      }
    }
    if (spec.command) {
      await interpreter.runText(`COMP_CMD_OUT=$(${spec.command} ${quote(command)} ${quote(cur)} ${quote(prev)})`)
      out.push(...(state.lookup('COMP_CMD_OUT') ?? '').split('\n').filter(entry => entry !== ''))
    }
  } catch { /* a completion function that fails offers what it had */ }
  finally {
    state.completions.active = undefined
    for (const name of names) { state.unset(name); state.unsetArray(name) }
    interpreter.host.setStatus(before)
    state.lineNumber = lineNumber
  }
  return { words: out, retry }
}

export async function programmableCompletion(host: BuiltinHost, line: string): Promise<string[] | undefined> {
  const registry = host.state.completions
  if (registry.commands.size === 0 && !registry.fallback && !registry.empty && !registry.initial) return undefined

  const words = splitLine(line)
  const cword = words.length - 1
  let spec = registry.find(words, cword)
  if (!spec) return undefined

  const cur = words[cword] ?? ''
  let found: string[] = []
  // a function that returns 124 has just registered the spec it should have had: look again, once
  for (let attempt = 0; attempt < 2 && spec; attempt++) {
    found = await staticCandidates(host, spec, cur)
    if (spec.function || spec.command) {
      const dynamic = await dynamicCandidates(host, spec, words, line)
      found.push(...dynamic.words)
      if (dynamic.retry) {
        const next = registry.find(words, cword)
        if (next && next !== spec) { spec = next; continue }
      }
    }
    break
  }
  if (!spec) return undefined

  found = applyFilter(host, spec.filter, found)
  if (spec.options.includes('plusdirs') || (found.length === 0 && spec.options.includes('dirnames'))) found.push(...await pathCandidates(host, cur, true))
  if (found.length === 0 && spec.options.includes('default')) found = await pathCandidates(host, cur, false)
  found = applyAffixes(spec, found)
  if (!spec.options.includes('nosort')) found = [...new Set(found)].sort()

  const filenames = spec.options.includes('filenames') || (found.length > 0 && spec.options.includes('default') && !spec.actions.length)
  const head = line.slice(0, line.length - cur.length)
  const results: string[] = []
  for (const candidate of found) {
    let text = candidate
    if (filenames) {
      text = candidate.replace(ESCAPE, '\\$1')
      const target = host.resolvePath(host.expandTilde ? host.expandTilde(candidate) : candidate)
      if (!text.endsWith('/') && (await host.stat(target))?.directory) text += '/'
    }
    results.push(head + text)
  }
  return results
}
