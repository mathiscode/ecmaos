/**
 * Word expansion over quote-aware words (`WordPart[]`, from `shell-parser.ts`): tilde, parameter
 * and variable expansion (arrays included), command substitution, arithmetic, then word splitting
 * and pathname globbing -- in that order, with bash's quoting rules:
 *
 * - '...' and a backslash escape are literal.
 * - "..." expands `$...` and command substitutions, but its result is never split or globbed.
 *   `"$@"` and `"${a[@]}"` are the exception that makes arrays useful: one field per element.
 * - Unquoted text expands the same way, then the *expanded* parts (not the literal text around
 *   them) are split on whitespace, and the result is globbed unless a glob character was quoted.
 */

import { evaluateArithmeticExpression } from '#lib/expand-variables.ts'
import type { WordPart } from '#lib/shell-parser.ts'
import { scanExpansionEnd } from '#lib/shell-parser.ts'

export interface ExpansionContext {
  /** A scalar variable, or element 0 of an array; special parameters (`?`, `#`, digits) too */
  lookup(name: string): string | undefined
  /** An indexed array's elements in index order, or `undefined` if `name` isn't an array */
  lookupArray(name: string): Map<number, string> | undefined
  /** `$1`..`$n` */
  positional(): string[]
  /** Assign a scalar (for `${name:=word}`) */
  assign(name: string, value: string): void
  /** Run a command and return its stdout with trailing newlines removed */
  substitute(command: string): Promise<string>
  /** Paths matching a glob pattern, relative the same way the pattern is; empty if none */
  glob(pattern: string): Promise<string[]>
  /** `$HOME`, for tilde expansion */
  home(): string | undefined
  /** `set -u`: throw on a reference to an unset variable */
  nounset?: boolean
}

/** One run of an in-progress field: its text and whether splitting/globbing may apply to it. */
interface Chunk {
  text: string
  split: boolean
  glob: boolean
}

/** What one `$...` expansion produced: a single value, or (for `$@`/`${a[@]}`) one per element. */
type Expanded = { values: string[], multi: boolean }

const IFS_WHITESPACE = /[ \t\n]+/

function assertName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !/^[0-9@*#?$!-]$/.test(name)) {
    throw new Error(`${name}: bad substitution`)
  }
}

class Expander {
  constructor(private ctx: ExpansionContext) {}

  private scalar(name: string): string | undefined {
    const value = this.ctx.lookup(name)
    if (value === undefined && this.ctx.nounset && !/^[@*#?]$/.test(name)) throw new Error(`${name}: unbound variable`)
    return value
  }

  private special(name: string): Expanded | undefined {
    const positional = this.ctx.positional()
    if (name === '@') return { values: positional, multi: true }
    if (name === '*') return { values: [positional.join(' ')], multi: false }
    if (name === '#') return { values: [String(positional.length)], multi: false }
    return undefined
  }

  private arrayValues(name: string): string[] {
    const array = this.ctx.lookupArray(name)
    if (array) return [...array.entries()].sort(([a], [b]) => a - b).map(([, v]) => v)
    if (name === '@' || name === '*') return this.ctx.positional()
    const value = this.ctx.lookup(name)
    return value === undefined ? [] : [value]
  }

  private async element(name: string, subscript: string): Promise<string | undefined> {
    const index = evaluateArithmeticExpression(await this.expandText(subscript, 'double'), n => this.ctx.lookup(n))
    const array = this.ctx.lookupArray(name)
    if (array) {
      const indices = [...array.keys()].sort((a, b) => a - b)
      const resolved = index < 0 ? (indices[indices.length + index] ?? -1) : index
      return array.get(resolved)
    }
    return index === 0 ? this.ctx.lookup(name) : undefined
  }

  /** `${...}`'s body: `#name`, `name[i]`, `name[@]`, `name:-word` and friends. */
  private async parameter(body: string): Promise<Expanded> {
    // ${#...}: length
    if (body.startsWith('#') && body.length > 1) {
      const rest = body.slice(1)
      const arrayAll = /^([A-Za-z_][A-Za-z0-9_]*)\[[@*]\]$/.exec(rest)
      if (arrayAll) return { values: [String(this.arrayValues(arrayAll[1] as string).length)], multi: false }
      if (rest === '@' || rest === '*') return { values: [String(this.ctx.positional().length)], multi: false }
      const element = /^([A-Za-z_][A-Za-z0-9_]*)\[(.+)\]$/.exec(rest)
      if (element) return { values: [String((await this.element(element[1] as string, element[2] as string) ?? '').length)], multi: false }
      assertName(rest)
      return { values: [String((this.scalar(rest) ?? '').length)], multi: false }
    }

    const match = /^([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])(?:\[([^\]]*)\])?(:?[-+=?])?([\s\S]*)$/.exec(body)
    if (!match) throw new Error(`\${${body}}: bad substitution`)
    const [, name, subscript, operator, word] = match as unknown as [string, string, string | undefined, string | undefined, string]
    if (!operator && word) throw new Error(`\${${body}}: bad substitution`)

    let value: string | undefined
    let result: Expanded
    if (subscript === '@' || subscript === '*') {
      const values = this.arrayValues(name)
      result = subscript === '@' ? { values, multi: true } : { values: [values.join(' ')], multi: false }
      value = values.length ? values.join(' ') : undefined
    } else if (subscript !== undefined) {
      value = await this.element(name, subscript)
      result = { values: value === undefined ? [] : [value], multi: false }
    } else {
      const special = this.special(name)
      if (special) {
        result = special
        value = special.values.length ? special.values.join(' ') : undefined
      } else {
        value = operator ? this.ctx.lookup(name) : this.scalar(name)
        result = { values: [value ?? ''], multi: false }
      }
    }

    if (!operator) return result.values.length || result.multi ? result : { values: [''], multi: false }

    const colon = operator.startsWith(':')
    const unset = value === undefined || (colon && value === '')
    const expandedWord = async () => this.expandText(word, 'double')
    switch (operator.replace(':', '')) {
      case '-': return unset ? { values: [await expandedWord()], multi: false } : result
      case '+': return unset ? { values: [''], multi: false } : { values: [await expandedWord()], multi: false }
      case '=': {
        if (!unset) return result
        const assigned = await expandedWord()
        this.ctx.assign(name, assigned)
        return { values: [assigned], multi: false }
      }
      case '?': {
        if (!unset) return result
        throw new Error(`${name}: ${word ? await expandedWord() : 'parameter null or not set'}`)
      }
    }
    return result
  }

  /** Expands one `$...`/backtick span at the start of `text`. Returns what it produced and its length. */
  private async dollar(text: string): Promise<{ expanded: Expanded, length: number } | undefined> {
    if (text.startsWith('$((')) {
      const end = scanExpansionEnd(text, 0)
      if (end > 0 && text[end - 2] === ')') {
        const expression = await this.expandText(text.slice(3, end - 2), 'double')
        return { expanded: { values: [String(evaluateArithmeticExpression(expression, n => this.ctx.lookup(n)))], multi: false }, length: end }
      }
    }
    if (text.startsWith('$(') || text.startsWith('`')) {
      const end = scanExpansionEnd(text, 0)
      if (end > 0) {
        const command = text.startsWith('`') ? text.slice(1, end - 1).replace(/\\([`$\\])/g, '$1') : text.slice(2, end - 1)
        return { expanded: { values: [await this.ctx.substitute(command)], multi: false }, length: end }
      }
    }
    if (text.startsWith('${')) {
      const end = scanExpansionEnd(text, 0)
      if (end > 0) return { expanded: await this.parameter(text.slice(2, end - 1)), length: end }
    }
    const simple = /^\$([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(text)
    if (simple) {
      const name = simple[1] as string
      const special = this.special(name)
      if (special) return { expanded: special, length: simple[0].length }
      return { expanded: { values: [this.scalar(name) ?? ''], multi: false }, length: simple[0].length }
    }
    return undefined
  }

  /** Expands `text` as if double-quoted, to one string (multi-value expansions join with spaces). */
  async expandText(text: string, _quoting: 'double'): Promise<string> {
    const fields = await this.fields([{ text, quoting: 'double' }], { split: false, glob: false, tilde: false })
    return fields.join(' ')
  }

  /**
   * Expands a word's parts into fields. `split`/`glob` turn word splitting and pathname expansion
   * off wholesale (assignments, `[[ ]]`, here-strings keep one field and never glob).
   */
  async fields(parts: WordPart[], options: { split: boolean, glob: boolean, tilde: boolean, pattern?: 'glob' | 'regex' }): Promise<string[]> {
    const fields: Chunk[][] = [[]]
    /** Whether a field holds anything that must survive even if empty ("" or a quoted expansion) */
    const keep: boolean[] = [false]
    let producedNothing = false

    const current = () => fields[fields.length - 1] as Chunk[]
    const add = (chunk: Chunk) => current().push(chunk)
    const newField = () => { fields.push([]); keep.push(false) }

    for (const [index, part] of parts.entries()) {
      const quoted = part.quoting !== 'unquoted'
      if (part.quoting === 'single' || part.quoting === 'escaped') {
        add({ text: part.text, split: false, glob: false })
        keep[keep.length - 1] = true
        continue
      }
      if (quoted) keep[keep.length - 1] = true

      let text = part.text
      if (!quoted && options.tilde && index === 0 && text.startsWith('~') && (text.length === 1 || text[1] === '/')) {
        const home = this.ctx.home()
        if (home !== undefined) {
          add({ text: home, split: false, glob: false })
          text = text.slice(1)
        }
      }

      let literal = ''
      const flushLiteral = () => {
        if (literal) add({ text: literal, split: false, glob: !quoted })
        literal = ''
      }

      let i = 0
      while (i < text.length) {
        const c = text[i] as string
        if (c === '$' || c === '`') {
          const result = await this.dollar(text.slice(i))
          if (result) {
            flushLiteral()
            const { values, multi } = result.expanded
            if (multi) {
              if (values.length === 0 && quoted) producedNothing = true
              values.forEach((value, n) => {
                if (n > 0) newField()
                add({ text: value, split: !quoted, glob: !quoted })
                if (quoted) keep[keep.length - 1] = true
              })
            } else {
              add({ text: values[0] ?? '', split: !quoted, glob: !quoted })
            }
            i += result.length
            continue
          }
        }
        literal += c
        i++
      }
      flushLiteral()
    }

    // A bare "$@" / "${a[@]}" with no elements is no word at all, not an empty one.
    if (producedNothing && fields.length === 1 && (fields[0] as Chunk[]).every(c => c.text === '')) return []

    // [[ ]]'s right-hand side: one string where only unquoted text keeps its special meaning.
    if (options.pattern) {
      const escape = options.pattern === 'glob'
        ? (t: string) => t.replace(/[*?[\]\\]/g, '\\$&')
        : (t: string) => t.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
      return [fields.map(chunks => chunks.map(c => c.glob ? c.text : escape(c.text)).join('')).join(' ')]
    }

    // Word splitting: only expansion results that were unquoted.
    const split: Array<{ chunks: Chunk[], keep: boolean }> = []
    for (const [n, chunks] of fields.entries()) {
      let pending: Chunk[] = []
      let pendingKeep = keep[n] as boolean
      for (const chunk of chunks) {
        if (!options.split || !chunk.split || !IFS_WHITESPACE.test(chunk.text)) {
          pending.push(chunk)
          continue
        }
        const pieces = chunk.text.split(IFS_WHITESPACE)
        pieces.forEach((piece, k) => {
          if (k > 0) {
            if (pending.some(p => p.text !== '') || pendingKeep) split.push({ chunks: pending, keep: pendingKeep })
            pending = []
            pendingKeep = false
          }
          if (piece) pending.push({ ...chunk, text: piece })
        })
      }
      split.push({ chunks: pending, keep: pendingKeep })
    }

    const out: string[] = []
    for (const { chunks, keep: mustKeep } of split) {
      const text = chunks.map(c => c.text).join('')
      if (!text && !mustKeep) continue

      if (options.glob && chunks.some(c => c.glob && /[*?]|\[.*\]/.test(c.text))) {
        const pattern = chunks.map(c => c.glob ? c.text : c.text.replace(/[*?[\]\\]/g, '\\$&')).join('')
        const matches = await this.ctx.glob(pattern)
        if (matches.length) { out.push(...matches); continue }
      }
      out.push(text)
    }
    return out
  }
}

/** Expands a word into its final fields (arguments): splitting and globbing included. */
export async function expandWordFields(parts: WordPart[], ctx: ExpansionContext): Promise<string[]> {
  return new Expander(ctx).fields(parts, { split: true, glob: true, tilde: true })
}

/** Expands a word to one string, with no splitting or globbing: assignments, `[[ ]]`, `<<<`. */
export async function expandWordString(parts: WordPart[], ctx: ExpansionContext): Promise<string> {
  return (await new Expander(ctx).fields(parts, { split: false, glob: false, tilde: true })).join(' ')
}

/**
 * Expands a word into a pattern string: glob (for `==`/`!=`) or regex (for `=~`) syntax in the
 * unquoted parts stays special; quoted parts and quoted expansions are escaped to match literally.
 */
export async function expandWordPattern(parts: WordPart[], ctx: ExpansionContext, syntax: 'glob' | 'regex'): Promise<string> {
  return (await new Expander(ctx).fields(parts, { split: false, glob: false, tilde: true, pattern: syntax }))[0] ?? ''
}

/**
 * Expands a heredoc body: `$...` and command substitutions expand, and a backslash escapes only
 * `$`, `` ` ``, `\` and a newline -- everything else, quotes included, is literal text.
 */
export async function expandHeredocBody(body: string, ctx: ExpansionContext): Promise<string> {
  const parts: WordPart[] = []
  let text = ''
  let i = 0
  while (i < body.length) {
    const c = body[i] as string
    if (c === '\\' && i + 1 < body.length && '$`\\\n'.includes(body[i + 1] as string)) {
      if (text) { parts.push({ text, quoting: 'double' }); text = '' }
      if (body[i + 1] !== '\n') parts.push({ text: body[i + 1] as string, quoting: 'escaped' })
      i += 2
      continue
    }
    text += c
    i++
  }
  if (text) parts.push({ text, quoting: 'double' })
  return (await new Expander(ctx).fields(parts, { split: false, glob: false, tilde: false })).join('')
}

/**
 * Converts a shell glob (`*`, `?`, `[...]`, with `\x` escaping a character) into an anchored
 * RegExp source. Used for `[[ x == pattern ]]`, `case` and pathname expansion alike.
 */
export function globToRegExpSource(pattern: string): string {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string
    if (c === '\\' && i + 1 < pattern.length) {
      out += (pattern[++i] as string).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    } else if (c === '*') {
      out += '.*'
    } else if (c === '?') {
      out += '.'
    } else if (c === '[') {
      const close = pattern.indexOf(']', i + 2)
      if (close === -1) { out += '\\['; continue }
      let set = pattern.slice(i + 1, close)
      if (set.startsWith('!')) set = '^' + set.slice(1)
      out += `[${set.replace(/\\/g, '\\\\')}]`
      i = close
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    }
  }
  return `^${out}$`
}
