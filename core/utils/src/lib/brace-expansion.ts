/**
 * Brace expansion: `{a,b}`, `{1..10}`, `{a..e}`, nested, and any number of them in one word.
 *
 * It is the first expansion a shell performs, before parameter, command, arithmetic and pathname
 * expansion, and it is purely textual - `{a,b}` becomes two words whether or not anything by those
 * names exists, which is what separates it from globbing. `mkdir -p src/{lib,bin}` is the everyday
 * case, and it produced a single directory literally named `src/{lib,bin}` before this existed.
 *
 * Three rules make it behave rather than eat ordinary text:
 *
 * - Quoting suppresses it. `"{a,b}"` and `'{a,b}'` are one word, so the pass works on the word's
 *   {@link WordPart}s rather than on flat text: only characters that came from unquoted runs can
 *   open, close or separate a brace expression.
 * - `${` is never an opener. A parameter expansion can legitimately contain braces and commas
 *   (`${x:-a,b}`), so expansion spans are skipped whole, using the same `scanExpansionEnd` the
 *   tokenizer uses.
 * - A brace expression with no top-level comma and no valid `..` sequence is left exactly as it
 *   was typed, because `echo {}` and `echo {foo}` print themselves in every real shell.
 */

import { scanExpansionEnd } from './shell-parser.js'
import type { Quoting, WordPart } from './shell-parser.js'

/** One character of a word plus the quoting of the run it came from. */
interface Char {
  ch: string
  quoting: Quoting
}

/** bash refuses to generate an unbounded sequence; this is the same guard, not a tuned number. */
const MAX_SEQUENCE_LENGTH = 10000

/**
 * Expands one word's braces into one or more words.
 *
 * Returns `[parts]` unchanged when there is nothing to expand, so the overwhelmingly common case
 * allocates nothing beyond the wrapper array.
 */
export function expandBraces(parts: WordPart[]): WordPart[][] {
  if (!parts.some(part => part.quoting === 'unquoted' && part.text.includes('{'))) return [parts]

  const chars: Char[] = []
  for (const part of parts) for (const ch of part.text) chars.push({ ch, quoting: part.quoting })

  return expandChars(chars).map(toParts)
}

/** Regroups characters back into the fewest `WordPart`s, one per run of equal quoting. */
function toParts(chars: Char[]): WordPart[] {
  const parts: WordPart[] = []
  for (const { ch, quoting } of chars) {
    const last = parts[parts.length - 1]
    if (last && last.quoting === quoting) last.text += ch
    else parts.push({ text: ch, quoting })
  }
  return parts
}

/**
 * The recursive core: expand the leftmost brace expression, then expand what each result still
 * contains. Recursing on the results rather than scanning the whole word at once is what makes
 * nesting (`{a,{b,c}}`) and several braces in one word (`{a,b}{1,2}`) fall out for free.
 */
function expandChars(chars: Char[]): Char[][] {
  const found = findBraceExpression(chars)
  if (!found) return [chars]

  const { open, close, items } = found
  const prefix = chars.slice(0, open)
  const suffix = chars.slice(close + 1)

  return items.flatMap(item => expandChars([...prefix, ...item, ...suffix]))
}

/**
 * The leftmost expandable brace expression, with its alternatives already split out.
 *
 * `undefined` when the word has no expandable brace: an unmatched `{`, an empty `{}`, a `{foo}` with
 * no comma, or a `{1..x}` whose endpoints do not form a sequence. All of those are literal text.
 */
function findBraceExpression(chars: Char[]): { open: number, close: number, items: Char[][] } | undefined {
  for (let i = 0; i < chars.length; i++) {
    const here = chars[i] as Char
    if (here.quoting !== 'unquoted') continue

    const skip = skipExpansion(chars, i)
    if (skip !== undefined) { i = skip - 1; continue }

    if (here.ch !== '{') continue

    const parsed = parseBraceAt(chars, i)
    if (parsed) return parsed
  }

  return undefined
}

/**
 * If an expansion span (`$(...)`, `${...}`, `$((...))`, a backtick pair) starts at `index`, the
 * index just past it; otherwise `undefined`.
 *
 * Reconstructing the text from `index` on and handing it to the tokenizer's own scanner keeps this
 * pass and the tokenizer agreeing on where an expansion ends, rather than reimplementing the
 * nesting-and-quotes walk a second time.
 */
function skipExpansion(chars: Char[], index: number): number | undefined {
  const ch = (chars[index] as Char).ch
  if (ch !== '$' && ch !== '`') return undefined

  const text = chars.slice(index).map(c => c.ch).join('')
  const end = scanExpansionEnd(text, 0)
  return end > 0 ? index + end : undefined
}

/**
 * Parses the brace expression opening at `open`, returning its alternatives, or `undefined` if what
 * is there is not one.
 */
function parseBraceAt(chars: Char[], open: number): { open: number, close: number, items: Char[][] } | undefined {
  const commas: number[] = []
  let depth = 0

  for (let i = open; i < chars.length; i++) {
    const here = chars[i] as Char

    if (here.quoting === 'unquoted') {
      const skip = skipExpansion(chars, i)
      if (skip !== undefined) { i = skip - 1; continue }

      if (here.ch === '{') { depth++; continue }
      if (here.ch === '}') {
        depth--
        if (depth > 0) continue

        const body = chars.slice(open + 1, i)
        if (commas.length > 0) {
          return { open, close: i, items: splitAt(body, commas.map(c => c - open - 1)) }
        }
        const sequence = parseSequence(body)
        return sequence ? { open, close: i, items: sequence } : undefined
      }
      if (here.ch === ',' && depth === 1) commas.push(i)
    }
  }

  return undefined
}

/** Splits `body` at the given indices, dropping the separators. */
function splitAt(body: Char[], indices: number[]): Char[][] {
  const items: Char[][] = []
  let start = 0
  for (const index of indices) {
    items.push(body.slice(start, index))
    start = index + 1
  }
  items.push(body.slice(start))
  return items
}

/**
 * `{1..10}`, `{1..10..2}`, `{a..e}`, `{e..a}`, `{-3..3}`, `{01..10}`.
 *
 * Zero padding is preserved when either endpoint is written with a leading zero, matching bash:
 * `{01..10}` gives `01 02 ... 10`, which is the whole reason anyone writes it that way.
 */
function parseSequence(body: Char[]): Char[][] | undefined {
  // Only an all-unquoted body can be a sequence; `{'1'..3}` is literal text in bash too.
  if (body.some(c => c.quoting !== 'unquoted')) return undefined

  const text = body.map(c => c.ch).join('')
  const match = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.(-?\d+))?$/.exec(text)
  if (!match) return undefined

  const [, from, to, rawStep] = match as unknown as [string, string, string, string | undefined]
  const step = rawStep === undefined ? undefined : Math.abs(Number(rawStep))
  if (step === 0) return undefined

  const values = /^-?\d+$/.test(from) && /^-?\d+$/.test(to)
    ? numericSequence(from, to, step)
    : /^[A-Za-z]$/.test(from) && /^[A-Za-z]$/.test(to)
      ? characterSequence(from, to, step)
      : undefined

  return values?.map(value => [...value].map(ch => ({ ch, quoting: 'unquoted' as const })))
}

function numericSequence(from: string, to: string, step: number = 1): string[] | undefined {
  const start = Number(from)
  const end = Number(to)
  if (Math.floor(Math.abs(end - start) / step) + 1 > MAX_SEQUENCE_LENGTH) return undefined

  // bash pads to the wider of the two endpoints when either was written with a leading zero.
  const padded = /^-?0\d/.test(from) || /^-?0\d/.test(to)
  const width = Math.max(from.replace('-', '').length, to.replace('-', '').length)
  const format = (n: number): string => {
    if (!padded) return String(n)
    const sign = n < 0 ? '-' : ''
    return sign + String(Math.abs(n)).padStart(width, '0')
  }

  const values: string[] = []
  if (start <= end) for (let n = start; n <= end; n += step) values.push(format(n))
  else for (let n = start; n >= end; n -= step) values.push(format(n))
  return values
}

function characterSequence(from: string, to: string, step: number = 1): string[] | undefined {
  const start = from.charCodeAt(0)
  const end = to.charCodeAt(0)
  if (Math.floor(Math.abs(end - start) / step) + 1 > MAX_SEQUENCE_LENGTH) return undefined

  const values: string[] = []
  if (start <= end) for (let c = start; c <= end; c += step) values.push(String.fromCharCode(c))
  else for (let c = start; c >= end; c -= step) values.push(String.fromCharCode(c))
  return values
}
