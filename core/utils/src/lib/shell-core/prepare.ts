/**
 * Preparing a parsed command for a host to run: telling `NAME=value` words from command words, and
 * recognizing array assignments. Both shells classify a command the same way, so the rules live here;
 * running it (expansion, readonly errors, environment scoping) stays with each host.
 */

import { closingParen } from '../control-flow-parser.js'
import type { Command, WordPart } from '../shell-parser.js'

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
  | { kind: 'list', name: string, append: boolean, local: boolean, body: string, operator?: string, rest?: string }
  | { kind: 'element', name: string, local: boolean, subscript: string, raw: string, operator?: string, rest?: string }

/**
 * `a=(x y)`, `a+=(z)` and `a[i]=v` at the start of a line. The tokenizer splits `a=(x y)` into two
 * words, so this reads the raw text. `operator`/`rest` carry whatever follows (`; more`, `&& more`).
 */
export function parseArrayAssignment(line: string): ArrayAssignment | undefined {
  const head = /^(?:(declare|typeset|local|readonly)\s+(?:-[A-Za-z]+\s+)*)?([A-Za-z_][A-Za-z0-9_]*)(\+?)=\(/.exec(line)
  const close = head ? closingParen(line, head[0].length - 1) : -1
  const tail = close === -1 ? undefined : /^\s*(?:(;|&&|\|\|)\s*([\s\S]*))?$/.exec(line.slice(close + 1))
  if (head && tail) {
    return { kind: 'list', name: head[2] as string, append: head[3] === '+', local: head[1] === 'local', body: line.slice(head[0].length, close), operator: tail[1], rest: tail[2] }
  }
  const element = /^(?:(declare|typeset|local|readonly)\s+(?:-[A-Za-z]+\s+)*)?([A-Za-z_][A-Za-z0-9_]*)\[([^\]]+)\]=(\S*)\s*(?:(;|&&|\|\|)\s*([\s\S]*))?$/.exec(line)
  if (element) {
    return { kind: 'element', name: element[2] as string, local: element[1] === 'local', subscript: element[3] as string, raw: element[4] as string, operator: element[5], rest: element[6] }
  }
  return undefined
}
