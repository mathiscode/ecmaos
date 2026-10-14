/**
 * POSIX regular expressions (the basic and extended syntax of `grep` and `sed`, with GNU's additions `\+ \? \|` in basic,
 * `\< \> \b \B \w \W \s \S`, and back-references) translated to JavaScript. Text is handled as one character per byte.
 */

const classes = {
  alpha: 'a-zA-Z', digit: '0-9', alnum: 'a-zA-Z0-9', upper: 'A-Z', lower: 'a-z', space: ' \\t\\n\\v\\f\\r', blank: ' \\t',
  punct: '!-\\/:-@\\[-`{-~', print: ' -~', graph: '!-~', cntrl: '\\x00-\\x1f\\x7f', xdigit: '0-9A-Fa-f'
}

const escapeLiteral = ch => (/[\\^$.*+?()[\]{}|/-]/.test(ch) ? '\\' + ch : ch)

/** The pattern as bytes, one character each, as the data is */
export const toBytes = text => Array.from(new TextEncoder().encode(text), b => String.fromCharCode(b)).join('')

/** A bracket expression starting at `index` (the `[`): its JavaScript form and where it ends */
function bracket(pattern, index) {
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
        body += classes[name]
      } else body += escapeLiteral(name)
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
  if (!/^\d*(,\d*)?$/.test(text) || text === '' || text === ',') return undefined
  return { source: `{${text.startsWith(',') ? '0' + text : text}}`, end: end + close.length }
}

/** `{ source }` for a basic (default) or extended pattern; throws an error whose message is GNU's. With `dotAll`, `.` also matches a newline (sed's pattern space) */
export function translate(pattern, extended, dotAll = false) {
  let out = ''
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
        if (next === '(') { out += '('; depth++; atStart = true; continue }
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
      if (/[1-9]/.test(next)) out += '\\' + next
      else if (next === '<') out += '\\b(?=\\w)'
      else if (next === '>') out += '\\b(?<=\\w)'
      else if ('bBwWsS'.includes(next)) out += '\\' + next
      else if (next === '`') out += '^'
      else if (next === "'") out += '$'
      else out += escapeLiteral(next)
      continue
    }

    if (c === '[') {
      const parsed = bracket(pattern, i)
      out += parsed.source
      i = parsed.end
      atStart = false
      continue
    }

    if (c === '.') { out += dotAll ? '[^]' : '[^\\n]'; i++; atStart = false; continue }

    if (c === '*') { out += atStart ? '\\*' : '*'; i++; atStart = false; continue }

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
      if (c === '(') { out += '('; depth++; atStart = true; i++; continue }
      if (c === ')') {
        if (depth === 0) { out += '\\)'; i++; atStart = false; continue }
        out += ')'; depth--; i++; atStart = false; continue
      }
      if (c === '|') { out += '|'; atStart = true; i++; continue }
      if (c === '+' || c === '?') { out += atStart ? '\\' + c : c; i++; atStart = false; continue }
      if (c === '{') {
        const parsed = atStart ? undefined : interval(pattern, i + 1, true)
        if (parsed) { out += parsed.source; i = parsed.end; atStart = false; continue }
        out += '\\{'; i++; atStart = false; continue
      }
    }

    out += escapeLiteral(c)
    i++
    atStart = false
  }

  if (depth > 0) throw new Error('Unmatched ( or \\(')
  return { source: out }
}
