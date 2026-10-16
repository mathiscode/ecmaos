/**
 * POSIX regular expressions (the basic and extended syntax of `grep` and `sed`, with GNU's additions `\+ \? \|` in basic,
 * `\< \> \b \B \w \W \s \S`, and back-references) translated to JavaScript. Text is handled as one character per byte.
 */

const classes = {
  alpha: 'a-zA-Z', digit: '0-9', alnum: 'a-zA-Z0-9', upper: 'A-Z', lower: 'a-z', space: ' \\t\\n\\v\\f\\r', blank: ' \\t',
  punct: '!-\\/:-@\\[-`{-~', print: ' -~', graph: '!-~', cntrl: '\\x00-\\x1f\\x7f', xdigit: '0-9A-Fa-f'
}

const unicodeClasses = {
  alpha: '\\p{L}', digit: '0-9', alnum: '\\p{L}\\p{Nd}', upper: '\\p{Lu}', lower: '\\p{Ll}', space: ' \\t\\n\\v\\f\\r', blank: ' \\t',
  punct: '!-\\/:-@\\[-`{-~', print: ' -~\\u00a0-\\u{10ffff}', graph: '!-~\\u00a1-\\u{10ffff}', cntrl: '\\x00-\\x1f\\x7f', xdigit: '0-9A-Fa-f'
}

/** The one character that is a word character to GNU's `\w`, `\<` and `\b`, in Unicode terms */
const WORD = '[\\p{L}\\p{Nd}_]'
const NOT_WORD = '[^\\p{L}\\p{Nd}_]'
const unicodeEscapes = {
  w: WORD, W: NOT_WORD, s: '\\s', S: '\\S',
  b: `(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`, B: `(?:(?<=${WORD})(?=${WORD})|(?<!${WORD})(?!${WORD}))`,
  '<': `(?<!${WORD})(?=${WORD})`, '>': `(?<=${WORD})(?!${WORD})`
}

const escapeLiteral = (ch, unicode = false) => (/[\\^$.*+?()[\]{}|/]/.test(ch) || (ch === '-' && !unicode) ? '\\' + ch : ch)

/** The pattern as bytes, one character each, as the data is */
export const toBytes = text => Array.from(new TextEncoder().encode(text), b => String.fromCharCode(b)).join('')

/** A bracket expression starting at `index` (the `[`): its JavaScript form and where it ends */
function bracket(pattern, index, unicode = false) {
  let i = index + 1
  let negate = false
  if (pattern[i] === '^') { negate = true; i++ }
  let body = ''
  let first = true
  for (;;) {
    if (i >= pattern.length) throw new Error('Unmatched [, [^, [:, [., or [=')
    const ch = pattern[i]
    if (ch === ']' && !first) { i++; break }
    first = false
    if (ch === '[' && (pattern[i + 1] === ':' || pattern[i + 1] === '.' || pattern[i + 1] === '=')) {
      const kind = pattern[i + 1]
      const end = pattern.indexOf(kind + ']', i + 2)
      if (end < 0) throw new Error('Unmatched [, [^, [:, [., or [=')
      const name = pattern.slice(i + 2, end)
      if (kind === ':') {
        if (!(name in classes)) throw new Error('Invalid character class name')
        body += (unicode ? unicodeClasses : classes)[name]
      } else body += escapeLiteral(name, unicode)
      i = end + 2
      continue
    }
    body += ch === '\\' || ch === '[' || ch === '^' || ch === ']' ? '\\' + ch : ch
    i++
  }
  return { source: `[${negate ? '^' : ''}${body}]`, end: i }
}

/** An interval `\{m,n\}` or `{m,n}` after `index`: its JavaScript form and where it ends; `undefined` when it is not one */
function interval(pattern, index, extended) {
  const close = extended ? '}' : '\\}'
  const end = pattern.indexOf(close, index)
  if (end < 0) return undefined
  const text = pattern.slice(index, end)
  if (/^[\d,]*$/.test(text) && (text.match(/,/g) ?? []).length > 1) throw new Error('Invalid content of \\{\\}')
  if (/^\d+,\d+$/.test(text) && Number(text.split(',')[0]) > Number(text.split(',')[1])) throw new Error('Invalid content of \\{\\}')
  if (!/^\d*(,\d*)?$/.test(text) || text === '' || text === ',') return undefined
  return { source: `{${text.startsWith(',') ? '0' + text : text}}`, end: end + close.length }
}

/** `{ source }` for a basic (default) or extended pattern; throws an error whose message is GNU's. With `dotAll`, `.` also matches a newline (sed's pattern space) */
export function translate(pattern, extended, dotAll = false, unicode = false) {
  let out = ''
  let groups = 0
  let i = 0
  let atStart = true
  let depth = 0
  const n = pattern.length

  while (i < n) {
    const c = pattern[i]

    if (c === '\\') {
      const next = pattern[i + 1]
      if (next === undefined) throw new Error('Trailing backslash')
      i += 2
      if (!extended) {
        if (next === '(') { out += '('; depth++; groups++; atStart = true; continue }
        if (next === ')') { if (depth === 0) throw new Error('Unmatched ) or \\)'); out += ')'; depth--; atStart = false; continue }
        if (next === '|') { out += '|'; atStart = true; continue }
        if (next === '{') {
          const parsed = atStart ? undefined : interval(pattern, i, false)
          if (!parsed) throw new Error('Invalid preceding regular expression')
          out += parsed.source
          i = parsed.end
          continue
        }
        if (next === '+' || next === '?') { out += atStart ? '\\' + next : next; atStart = false; continue }
      }
      atStart = false
      if (/[1-9]/.test(next)) { if (Number(next) > groups) throw new Error('Invalid back reference'); out += '\\' + next }
      else if (unicode && next in unicodeEscapes) out += unicodeEscapes[next]
      else if (next === '<') out += '\\b(?=\\w)'
      else if (next === '>') out += '\\b(?<=\\w)'
      else if ('bBwWsS'.includes(next)) out += '\\' + next
      else if (next === '`') out += '^'
      else if (next === "'") out += '$'
      else out += escapeLiteral(next, unicode)
      continue
    }

    if (c === '[') {
      if (pattern.startsWith('[:', i) && /^\[:[a-z]+:\]/.test(pattern.slice(i))) throw new Error('character class syntax is [[:space:]], not [:space:]')
      const parsed = bracket(pattern, i, unicode)
      out += parsed.source
      i = parsed.end
      atStart = false
      continue
    }

    if (c === '.') { out += dotAll ? '[^]' : '[^\\n]'; i++; atStart = false; continue }

    if (c === '*') {
      if (atStart && extended && unicode) { i++; continue }
      if (atStart) out += '\\*'
      else if (/[*+?]$/.test(out) && !/\\[*+?]$/.test(out)) out = out.slice(0, -1) + '*'
      else out += '*'
      i++; atStart = false; continue
    }

    if (c === '^') {
      if (extended || atStart) { out += '^'; i++; continue }
      out += '\\^'; i++; atStart = false; continue
    }

    if (c === '$') {
      const last = i === n - 1 || (!extended && (pattern.startsWith('\\)', i + 1) || pattern.startsWith('\\|', i + 1)))
      if (extended || last) out += '$'
      else out += '\\$'
      i++
      atStart = false
      continue
    }

    if (extended) {
      if (c === '(') { out += '('; depth++; groups++; atStart = true; i++; continue }
      if (c === ')') {
        if (depth === 0) { out += '\\)'; i++; atStart = false; continue }
        out += ')'; depth--; i++; atStart = false; continue
      }
      if (c === '|') { out += '|'; atStart = true; i++; continue }
      if (c === '+' || c === '?') {
        if (atStart && unicode) { i++; continue }
        if (atStart) out += '\\' + c
        else if (/[*+?]$/.test(out) && !/\\[*+?]$/.test(out)) { const previous = out[out.length - 1]; out = out.slice(0, -1) + (previous === c ? c : '*') }
        else out += c
        i++; atStart = false; continue
      }
      if (c === '{') {
        const parsed = interval(pattern, i + 1, true)
        if (parsed && atStart && unicode) { i = parsed.end; continue }
        if (parsed && !atStart) { out += parsed.source; i = parsed.end; atStart = false; continue }
        out += '\\{'; i++; atStart = false; continue
      }
    }

    out += escapeLiteral(c, unicode)
    i++
    atStart = false
  }

  if (depth > 0) throw new Error('Unmatched ( or \\(')
  return { source: out }
}
