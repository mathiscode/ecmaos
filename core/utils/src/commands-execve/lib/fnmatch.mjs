/**
 * `fnmatch(3)` for the programs that match names against a shell pattern (`find -name`, `find -path`): `*`, `?`,
 * bracket expressions with ranges, negation (`!` or `^`) and classes (`[[:digit:]]`), and `\` quoting. `*` and `?`
 * match `/` and a leading dot, as they do for `find`; `caseFold` ignores case.
 */

const CLASSES = {
  alpha: c => /[A-Za-z]/.test(c), digit: c => /[0-9]/.test(c), alnum: c => /[A-Za-z0-9]/.test(c), upper: c => /[A-Z]/.test(c),
  lower: c => /[a-z]/.test(c), space: c => /[ \t\n\v\f\r]/.test(c), blank: c => c === ' ' || c === '\t', punct: c => /[!-/:-@[-`{-~]/.test(c),
  print: c => /[ -~]/.test(c), graph: c => /[!-~]/.test(c), cntrl: c => /[\x00-\x1f\x7f]/.test(c), xdigit: c => /[0-9A-Fa-f]/.test(c)
}

/** Parses the bracket expression starting at `index` (the `[`); `{ test, end }` or `null` when it is not closed */
function bracket(pattern, index) {
  let i = index + 1
  let negate = false
  if (pattern[i] === '!' || pattern[i] === '^') { negate = true; i++ }
  const items = []
  let first = true
  for (;;) {
    if (i >= pattern.length) return null
    let c = pattern[i]
    if (c === ']' && !first) { i++; break }
    first = false
    if (c === '[' && pattern[i + 1] === ':') {
      const close = pattern.indexOf(':]', i + 2)
      if (close !== -1) {
        const test = CLASSES[pattern.slice(i + 2, close)]
        if (test) { items.push(test); i = close + 2; continue }
      }
    }
    if (c === '\\' && i + 1 < pattern.length) { c = pattern[++i] }
    if (pattern[i + 1] === '-' && i + 2 < pattern.length && pattern[i + 2] !== ']') {
      let hi = pattern[i + 2]
      let step = 3
      if (hi === '\\' && i + 3 < pattern.length) { hi = pattern[i + 3]; step = 4 }
      const lo = c
      items.push(ch => ch >= lo && ch <= hi)
      i += step
    } else {
      const only = c
      items.push(ch => ch === only)
      i++
    }
  }
  return { test: ch => items.some(item => item(ch)) !== negate, end: i }
}

/** Compiles `pattern` to a function of a string */
export function compile(pattern, { caseFold = false } = {}) {
  const parts = []
  for (let i = 0; i < pattern.length;) {
    const c = pattern[i]
    if (c === '*') {
      parts.push({ star: true })
      while (pattern[i] === '*') i++
    } else if (c === '?') { parts.push({ any: true }); i++ }
    else if (c === '[') {
      const parsed = bracket(pattern, i)
      if (parsed) { parts.push({ test: parsed.test }); i = parsed.end } else { parts.push({ lit: '[' }); i++ }
    } else if (c === '\\' && i + 1 < pattern.length) { parts.push({ lit: pattern[i + 1] }); i += 2 }
    else { parts.push({ lit: c }); i++ }
  }
  const fold = caseFold ? s => s.toLowerCase() : s => s
  const matchAt = (text, p, t) => {
    // iterative with one backtrack point per star
    let starP = -1
    let starT = 0
    while (t < text.length) {
      const part = parts[p]
      if (part?.star) { starP = p++; starT = t; continue }
      const ch = text[t]
      if (part && (part.any || (part.test ? (part.test(ch) || (caseFold && (part.test(ch.toLowerCase()) || part.test(ch.toUpperCase())))) : fold(part.lit) === fold(ch)))) { p++; t++; continue }
      if (starP === -1) return false
      p = starP + 1
      t = ++starT
    }
    while (parts[p]?.star) p++
    return p === parts.length
  }
  return text => matchAt(text, 0, 0)
}

export const fnmatch = (pattern, text, options) => compile(pattern, options)(text)
