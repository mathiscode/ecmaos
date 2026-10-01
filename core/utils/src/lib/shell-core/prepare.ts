/**
 * Preparing a parsed command for a host to run: telling `NAME=value` words from command words, and
 * recognizing array assignments. Both shells classify a command the same way, so the rules live here;
 * running it (expansion, readonly errors, environment scoping) stays with each host.
 */

import { closingParen } from '../control-flow-parser.js'
import { tokenize, type Command, type WordPart } from '../shell-parser.js'
import { evaluateArithmeticExpression } from '../expand-variables.js'
import type { ShellState } from './state.js'

export interface Assignment {
  name: string
  /** `NAME+=value` appends rather than replaces. */
  append: boolean
  /** The value, still as parts, so quoting decides what expands. */
  parts: WordPart[]
}

/**
 * Whether word `index` is a `NAME=VALUE` (or `NAME+=VALUE`) assignment rather than a command word.
 *
 * POSIX: the `=` has to be unquoted, so `"X=1" cmd` runs a command named `X=1`. The first word that
 * is not an assignment is the command name, which is why `X=a b` runs `b`.
 */
export function isAssignmentWord(words: readonly string[], wordParts: readonly WordPart[][], index: number): boolean {
  const text = words[index]
  const parts = wordParts[index]
  if (!text || !parts || parts.length === 0) return false
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/.exec(text)
  if (!match) return false
  const first = parts[0] as WordPart
  return first.quoting === 'unquoted' && first.text.length >= (match[0] as string).length
}

/** How many of a command's leading words are assignments (all of them for a bare assignment line). */
export function assignmentCount(command: Pick<Command, 'words' | 'wordParts'>): number {
  let n = 0
  while (n < command.words.length && isAssignmentWord(command.words, command.wordParts, n)) n++
  return n
}

/**
 * Splits a command into its leading assignments and the rest. `X=1 Y=2` alone has no `rest`, which
 * is what makes it a plain assignment instead of a prefixed command.
 */
export function splitAssignments(command: Command): { assignments: Assignment[], command: Command } {
  const n = assignmentCount(command)
  if (n === 0) return { assignments: [], command }
  const assignments: Assignment[] = []
  for (let k = 0; k < n; k++) {
    const text = command.words[k] as string
    const parts = command.wordParts[k] as WordPart[]
    const first = parts[0] as WordPart
    const eq = text.indexOf('=')
    const append = text[eq - 1] === '+'
    assignments.push({
      name: text.slice(0, append ? eq - 1 : eq),
      append,
      parts: [{ ...first, text: first.text.slice(eq + 1) }, ...parts.slice(1)]
    })
  }
  return {
    assignments,
    command: {
      ...command,
      words: command.words.slice(n),
      wordsQuoted: command.wordsQuoted.slice(n),
      wordParts: command.wordParts.slice(n)
    }
  }
}

export type ArrayAssignment =
  | { kind: 'list', name: string, append: boolean, local: boolean, assoc: boolean, body: string, operator?: string, rest?: string }
  | { kind: 'element', name: string, local: boolean, assoc: boolean, subscript: string, raw: string, operator?: string, rest?: string }

/**
 * `a=(x y)`, `a+=(z)` and `a[i]=v` at the start of a line. The tokenizer splits `a=(x y)` into two
 * words, so this reads the raw text. `operator`/`rest` carry whatever follows (`; more`, `&& more`).
 */
export function parseArrayAssignment(line: string): ArrayAssignment | undefined {
  const head = /^(?:(declare|typeset|local|readonly)\s+((?:-[A-Za-z]+\s+)*))?([A-Za-z_][A-Za-z0-9_]*)(\+?)=\(/.exec(line)
  const close = head ? closingParen(line, head[0].length - 1) : -1
  const tail = close === -1 ? undefined : /^\s*(?:(;|&&|\|\|)\s*([\s\S]*))?$/.exec(line.slice(close + 1))
  if (head && tail) {
    return { kind: 'list', name: head[3] as string, append: head[4] === '+', local: head[1] === 'local', assoc: /A/.test(head[2] ?? ''), body: line.slice(head[0].length, close), operator: tail[1], rest: tail[2] }
  }
  const element = /^(?:(declare|typeset|local|readonly)\s+((?:-[A-Za-z]+\s+)*))?([A-Za-z_][A-Za-z0-9_]*)\[([^\]]+)\]=(\S*)\s*(?:(;|&&|\|\|)\s*([\s\S]*))?$/.exec(line)
  if (element) {
    return { kind: 'element', name: element[3] as string, local: element[1] === 'local', assoc: /A/.test(element[2] ?? ''), subscript: element[4] as string, raw: element[5] as string, operator: element[6], rest: element[7] }
  }
  return undefined
}

/** What a host contributes to running an array assignment: its own expansion. */
export interface ArrayAssignmentHost {
  /** The word expanded to fields (split and globbed) */
  fields(parts: WordPart[]): Promise<string[]>
  /** The word expanded to one string */
  text(parts: WordPart[]): Promise<string>
  /** A variable's value, for an arithmetic subscript */
  lookup(name: string): string | undefined
}

/**
 * Runs a parsed array assignment against the shell state: `a=(x y)`, `a+=(z)`, `a[i]=v`, and for an
 * associative array (`declare -A`) `m=([k]=v)` and `m[key]=v`, where the subscript is a string.
 */
export async function applyArrayAssignment(found: ArrayAssignment, state: ShellState, host: ArrayAssignmentHost): Promise<void> {
  if (found.local) state.declareLocal(found.name)
  if (found.assoc) state.declareAssoc(found.name)
  const assoc = state.isAssoc(found.name)

  if (found.kind === 'list') {
    const tokens = found.body.trim() ? tokenize(found.body) : []
    if (assoc) {
      const entries: Array<[string, string]> = []
      for (const token of tokens) {
        if (token.kind !== 'word') continue
        const pair = /^\[([\s\S]*?)\]\+?=([\s\S]*)$/.exec(await host.text(token.parts as WordPart[]))
        if (pair) entries.push([pair[1] as string, pair[2] as string])
      }
      state.setAssoc(found.name, entries, found.append)
      return
    }
    const values: string[] = []
    for (const token of tokens) if (token.kind === 'word') values.push(...await host.fields(token.parts as WordPart[]))
    if (found.append) state.appendArray(found.name, values)
    else state.setArray(found.name, values)
    return
  }

  const value = await host.text((tokenize(found.raw || "''")[0] ?? { parts: [] }).parts as WordPart[])
  if (assoc) {
    const key = await host.text((tokenize(found.subscript)[0] ?? { parts: [] }).parts as WordPart[])
    state.setArrayElement(found.name, key, value)
  } else {
    state.setArrayElement(found.name, evaluateArithmeticExpression(found.subscript, host.lookup), value)
  }
}
