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

import { evaluateArithmeticExpression } from './expand-variables.js'
import { expandBraces } from './brace-expansion.js'
import type { WordPart } from './shell-parser.js'
import { scanExpansionEnd } from './shell-parser.js'

/** An array's keys: numeric order for an indexed array, insertion order for an associative one. */
function orderedKeys(array: Map<number | string, string>): Array<number | string> {
  const keys = [...array.keys()]
  return typeof keys[0] === 'string' ? keys : (keys as number[]).sort((a, b) => a - b)
}

/** `"a b"` and `'a b'` as written in a subscript, without the quotes. */
function stripQuotes(text: string): string {
  const match = /^(["'])([\s\S]*)\1$/.exec(text.trim())
  return match ? match[2] as string : text
}

export interface ExpansionContext {
  /** A scalar variable, or element 0 of an array; special parameters (`?`, `#`, digits) too */
  lookup(name: string): string | undefined
  /** An indexed array's elements in index order, or `undefined` if `name` isn't an array */
  lookupArray(name: string): Map<number | string, string> | undefined
  /** Whether `name` is an associative array (`declare -A`), whose subscripts are strings, not arithmetic */
  isAssoc?(name: string): boolean
  /** `$1`..`$n` */
  positional(): string[]
  /** Assign a scalar (for `${name:=word}`) */
  assign(name: string, value: string): void
  /** Run a command and return its stdout with trailing newlines removed */
  substitute(command: string): Promise<string>
  /**
   * `<(cmd)` / `>(cmd)`: a path the surrounding command can open, standing for `cmd`'s output or
   * input. Absent where process substitution has no meaning, and the word stays literal.
   */
  processSubstitute?(direction: '<' | '>', command: string): Promise<string>
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

/** What `$IFS` means when it has never been set. Set-but-empty is a different thing: no splitting. */
export const DEFAULT_IFS = ' \t\n'

/** The three characters POSIX calls "IFS white space" when they appear in `$IFS`. */
const isIFSWhitespace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n'

/**
 * Splits `text` at `$IFS` delimiters, POSIX rules.
 *
 * `$IFS` holds two kinds of character and they behave differently, which is the whole reason this
 * can't be one regex:
 *
 * - **IFS whitespace** (space, tab, newline, when present in `$IFS`). A run of it delimits one
 *   field, and a run at either end of the input delimits nothing at all -- `a  b` is two fields,
 *   and so is `  a  b  `.
 * - **IFS non-whitespace** (anything else in `$IFS`, e.g. `:`). *Each* occurrence delimits a field,
 *   with any adjacent IFS whitespace absorbed into the same delimiter. So `IFS=:` on `a::b` is
 *   three fields, the middle one empty, and `IFS=' :'` on `a : : b` is the same three.
 *
 * Returned as pieces plus one flag per boundary rather than a finished field list, because the
 * caller splits each expansion result separately and has to know whether an empty piece is a real
 * empty field (a non-whitespace delimiter produced it) or just an edge effect of whitespace.
 *
 * `hard.length` is always `pieces.length - 1`; `hard[k]` describes the boundary between
 * `pieces[k]` and `pieces[k + 1]`.
 */
export function splitOnIFS(text: string, ifs: string): { pieces: string[], hard: boolean[] } {
  const pieces: string[] = []
  const hard: boolean[] = []
  let current = ''
  let i = 0

  while (i < text.length) {
    const c = text[i] as string
    if (!ifs.includes(c)) {
      current += c
      i++
      continue
    }

    // One delimiter is `ws* [nonws ws*]?`: a whitespace run, optionally with a single
    // non-whitespace IFS character somewhere in it. A second non-whitespace character starts its
    // own delimiter, which is what makes `a::b` three fields rather than two.
    let sawNonWhitespace = false
    let j = i
    while (j < text.length && isIFSWhitespace(text[j] as string) && ifs.includes(text[j] as string)) j++
    if (j < text.length && ifs.includes(text[j] as string) && !isIFSWhitespace(text[j] as string)) {
      sawNonWhitespace = true
      j++
      while (j < text.length && isIFSWhitespace(text[j] as string) && ifs.includes(text[j] as string)) j++
    }

    pieces.push(current)
    hard.push(sawNonWhitespace)
    current = ''
    i = j
  }

  pieces.push(current)
  return { pieces, hard }
}

function assertName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !/^[0-9@*#?$!-]$/.test(name)) {
    throw new Error(`${name}: bad substitution`)
  }
}

/** `set -u` met a variable that is not set. The interpreter reports it and ends a script, as bash does. */
export class UnboundVariableError extends Error {}

class Expander {
  constructor(private ctx: ExpansionContext) {}

  private scalar(name: string): string | undefined {
    const value = this.ctx.lookup(name)
    if (value === undefined && this.ctx.nounset && !/^[@*#?]$/.test(name)) throw new UnboundVariableError(`${name}: unbound variable`)
    return value
  }

  private special(name: string): Expanded | undefined {
    const positional = this.ctx.positional()
    if (name === '@') return { values: positional, multi: true }
    if (name === '*') return { values: [this.starJoin(positional)], multi: false }
    if (name === '#') return { values: [String(positional.length)], multi: false }
    return undefined
  }

  /** `$*` and `${a[*]}` in one field: joined with the first character of IFS (a space when it is unset, nothing when it is empty). */
  private starJoin(values: string[]): string {
    const ifs = this.ctx.lookup('IFS')
    return values.join(ifs === undefined ? ' ' : ifs.slice(0, 1))
  }

  private arrayValues(name: string): string[] {
    const array = this.ctx.lookupArray(name)
    if (array) return orderedKeys(array).map(key => array.get(key) as string)
    if (name === '@' || name === '*') return this.ctx.positional()
    const value = this.ctx.lookup(name)
    return value === undefined ? [] : [value]
  }

  private async element(name: string, subscript: string): Promise<string | undefined> {
    if (this.ctx.isAssoc?.(name)) return this.ctx.lookupArray(name)?.get(await this.expandText(stripQuotes(subscript), 'double'))
    const index = evaluateArithmeticExpression(await this.expandText(subscript, 'double'), n => this.ctx.lookup(n))
    const array = this.ctx.lookupArray(name)
    if (array) {
      const indices = orderedKeys(array) as number[]
      const resolved = index < 0 ? (indices[indices.length + index] ?? -1) : index
      return array.get(resolved)
    }
    return index === 0 ? this.ctx.lookup(name) : undefined
  }


  /** The value-transforming parameter operators. Applied to each element when the target is a list. */
  private async transform(name: string, subscript: string | undefined, operator: string, rest: string): Promise<Expanded> {
    const isList = subscript === '@' || subscript === '*' || name === '@' || name === '*'
    const multi = subscript === '@' || (subscript === undefined && name === '@')
    let values: string[]
    if (subscript === '@' || subscript === '*') values = this.arrayValues(name)
    else if (name === '@' || name === '*') values = this.ctx.positional()
    else if (subscript !== undefined) values = [(await this.element(name, subscript)) ?? '']
    else values = [this.scalar(name) ?? '']

    const finish = (out: string[]): Expanded => isList ? (multi ? { values: out, multi: true } : { values: [this.starJoin(out)], multi: false }) : { values: [out[0] ?? ''], multi: false }
    const arithmetic = async (text: string) => evaluateArithmeticExpression(await this.expandText(text, 'double'), n => this.ctx.lookup(n))

    if (operator === ':') {
      const colon = rest.indexOf(':')
      const offset = await arithmetic(colon === -1 ? rest : rest.slice(0, colon))
      const length = colon === -1 ? undefined : await arithmetic(rest.slice(colon + 1))
      if (isList) {
        // Positional parameters count from $1, and offset 0 is $0; an array counts from its first element.
        const positional = subscript === undefined
        const list = positional ? [this.ctx.lookup('0') ?? '', ...values] : values
        const start = offset < 0 ? Math.max(0, list.length + offset) : offset
        return finish(list.slice(start, length === undefined ? undefined : start + length))
      }
      const text = values[0] as string
      const start = offset < 0 ? Math.max(0, text.length + offset) : Math.min(offset, text.length)
      const end = length === undefined ? text.length : length < 0 ? text.length + length : start + length
      return finish([text.slice(start, Math.max(start, end))])
    }

    if (operator === '#' || operator === '##' || operator === '%' || operator === '%%') {
      const pattern = new RegExp(globToRegExpSource(await this.expandText(rest, 'double')), 's')
      const trim = (text: string): string => {
        const prefix = operator[0] === '#'
        const longest = operator.length === 2
        // The candidate cut points, shortest first; the longest match is the last one that fits.
        const cuts = Array.from({ length: text.length + 1 }, (_, i) => i)
        const order = prefix === longest ? cuts.reverse() : cuts
        for (const cut of order) {
          const piece = prefix ? text.slice(0, cut) : text.slice(text.length - cut)
          if (pattern.test(piece)) return prefix ? text.slice(cut) : text.slice(0, text.length - cut)
        }
        return text
      }
      return finish(values.map(trim))
    }

    if (operator === '/') {
      let mode: 'first' | 'all' | 'start' | 'end' = 'first'
      let body = rest
      if (body.startsWith('/')) { mode = 'all'; body = body.slice(1) }
      else if (body.startsWith('#')) { mode = 'start'; body = body.slice(1) }
      else if (body.startsWith('%')) { mode = 'end'; body = body.slice(1) }
      let slash = -1
      for (let i = 0; i < body.length; i++) {
        if (body[i] === '\\') { i++; continue }
        if (body[i] === '/') { slash = i; break }
      }
      const patternText = await this.expandText(slash === -1 ? body : body.slice(0, slash), 'double')
      const replacement = slash === -1 ? '' : await this.expandText(body.slice(slash + 1), 'double')
      if (patternText === '') return finish(values)
      const pattern = new RegExp(globToRegExpSource(patternText), 's')
      const replace = (text: string): string => {
        if (mode === 'start') {
          for (let end = text.length; end >= 0; end--) if (pattern.test(text.slice(0, end))) return replacement + text.slice(end)
          return text
        }
        if (mode === 'end') {
          for (let start = 0; start <= text.length; start++) if (pattern.test(text.slice(start))) return text.slice(0, start) + replacement
          return text
        }
        let out = ''
        let at = 0
        while (at < text.length) {
          let matched = -1
          for (let end = text.length; end > at; end--) if (pattern.test(text.slice(at, end))) { matched = end; break }
          if (matched === -1) { out += text[at]; at++; continue }
          out += replacement
          at = matched
          if (mode === 'first') { out += text.slice(at); return out }
        }
        return out
      }
      return finish(values.map(replace))
    }

    // ^ ^^ , ,,: case conversion, of every character matching the optional pattern
    const upper = operator[0] === '^'
    const all = operator.length === 2
    const only = rest ? new RegExp(globToRegExpSource(await this.expandText(rest, 'double')), 's') : undefined
    const convert = (text: string): string => {
      let done = false
      return Array.from(text).map(char => {
        if ((done && !all) || (only && !only.test(char))) return char
        done = true
        return upper ? char.toUpperCase() : char.toLowerCase()
      }).join('')
    }
    return finish(values.map(convert))
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

    // ${!name[@]}: the indices of an array; ${!name}: indirection through the variable's value
    const indices = /^!([A-Za-z_][A-Za-z0-9_]*)\[[@*]\]$/.exec(body)
    if (indices) {
      const array = this.ctx.lookupArray(indices[1] as string)
      const keys = array ? orderedKeys(array).map(String) : (this.ctx.lookup(indices[1] as string) === undefined ? [] : ['0'])
      return { values: keys, multi: true }
    }
    const indirect = /^!([A-Za-z_][A-Za-z0-9_]*)$/.exec(body)
    if (indirect) {
      const target = this.ctx.lookup(indirect[1] as string)
      return { values: [target === undefined ? '' : (this.scalar(target) ?? '')], multi: false }
    }

    // ${name:off:len}, ${name#pat}, ${name%pat}, ${name/pat/rep}, ${name^^}: operators that transform the value
    const modified = /^([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*])(?:\[([^\]]*)\])?(:(?![-+=?])|##?|%%?|\/|\^\^?|,,?)([\s\S]*)$/.exec(body)
    if (modified) return await this.transform(modified[1] as string, modified[2], modified[3] as string, modified[4] as string)

    const match = /^([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])(?:\[([^\]]*)\])?(:?[-+=?])?([\s\S]*)$/.exec(body)
    if (!match) throw new Error(`\${${body}}: bad substitution`)
    const [, name, subscript, operator, word] = match as unknown as [string, string, string | undefined, string | undefined, string]
    if (!operator && word) throw new Error(`\${${body}}: bad substitution`)

    let value: string | undefined
    let result: Expanded
    if (subscript === '@' || subscript === '*') {
      const values = this.arrayValues(name)
      result = subscript === '@' ? { values, multi: true } : { values: [this.starJoin(values)], multi: false }
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
        return { expanded: { values: [String(evaluateArithmeticExpression(expression, n => this.ctx.lookup(n), (n, v) => this.ctx.assign(n, v)))], multi: false }, length: end }
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
      if (part.procSub && this.ctx.processSubstitute) {
        add({ text: await this.ctx.processSubstitute(part.procSub.direction, part.procSub.command), split: false, glob: false })
        keep[keep.length - 1] = true
        continue
      }
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

    // Word splitting: only expansion results that were unquoted, and only at `$IFS` characters.
    // `$IFS` unset means the default; set-but-empty means no splitting at all, which is what makes
    // `while IFS= read -r line` preserve a line's own whitespace.
    const ifs = options.split ? (this.ctx.lookup('IFS') ?? DEFAULT_IFS) : ''
    const split: Array<{ chunks: Chunk[], keep: boolean }> = []
    for (const [n, chunks] of fields.entries()) {
      let pending: Chunk[] = []
      let pendingKeep = keep[n] as boolean
      for (const chunk of chunks) {
        if (!options.split || !chunk.split || ifs === '' || ![...chunk.text].some(c => ifs.includes(c))) {
          pending.push(chunk)
          continue
        }
        const { pieces, hard } = splitOnIFS(chunk.text, ifs)
        pieces.forEach((piece, k) => {
          if (k > 0) {
            // A boundary holding a non-whitespace IFS character ends a field even when that field
            // is empty (`IFS=:` on `a::b`); a run of IFS whitespace only ends one with content.
            if (hard[k - 1] || pending.some(p => p.text !== '') || pendingKeep) {
              split.push({ chunks: pending, keep: pendingKeep })
            }
            pending = []
            pendingKeep = false
          }
          if (piece) pending.push({ ...chunk, text: piece })
          // An empty piece is a real field only between two delimiters, never trailing one:
          // `IFS=:` makes `a::b` three fields but `a:` just one.
          else if (k < pieces.length - 1 && hard[k]) pendingKeep = true
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

/**
 * {@link expandWordFields} with brace expansion first: the only expansion that turns one word into
 * several before anything is looked up, so `cp a.{txt,bak}` and `for i in {1..5}` agree in every shell.
 */
export async function expandWordFieldsBraced(parts: WordPart[], ctx: ExpansionContext): Promise<string[]> {
  const braced = expandBraces(parts)
  if (braced.length === 1) return await expandWordFields(parts, ctx)
  const fields: string[] = []
  for (const word of braced) fields.push(...await expandWordFields(word, ctx))
  return fields
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
