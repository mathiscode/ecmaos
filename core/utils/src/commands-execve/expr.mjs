/**
 * Evaluate an expression given as arguments: `expr 2 + 3`, `expr length hello`, `expr abc : 'a\(.\)'`.
 *
 * Each operator and operand is a separate argument, so the shell characters need quoting (`\*`, `\(`, `\|`).
 * The result goes to standard output. The status is 0 when it is neither empty nor 0, 1 when it is, 2 for a
 * syntax error and 3 for an error in evaluating it (such as a division by zero).
 */

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`expr: ${text}\n`))

class SyntaxProblem extends Error {}
class EvalProblem extends Error {}

const isInteger = value => /^-?\d+$/.test(String(value))
const truthy = value => value !== '' && !(isInteger(value) && Number(value) === 0)

/** `STRING : REGEX`: anchored at the start; the length of the match, or what the first group matched. */
function matches(subject, pattern) {
  let regex
  try {
    // BRE: `\(` `\)` group and `\|` alternates; a bare `(`, `)`, `|`, `+`, `?` and `{` are ordinary characters
    const source = pattern
      .replace(/\\([()|{}+?])|([()|{}+?])/g, (_, escaped, bare) => escaped ? escaped : '\\' + bare)
    regex = new RegExp('^(?:' + source + ')')
  } catch { throw new EvalProblem('Invalid regular expression') }
  const found = regex.exec(subject)
  if (!found) return /\\\(/.test(pattern) ? '' : '0'
  if (/\\\(/.test(pattern)) return found[1] ?? ''
  return String(found[0].length)
}

function evaluate(tokens) {
  let pos = 0
  const peek = () => tokens[pos]
  const take = () => tokens[pos++]

  function parseOr() {
    let left = parseAnd()
    while (peek() === '|') { take(); const right = parseAnd(); left = truthy(left) ? left : (truthy(right) ? right : '0') }
    return left
  }
  function parseAnd() {
    let left = parseCompare()
    while (peek() === '&') { take(); const right = parseCompare(); left = truthy(left) && truthy(right) ? left : '0' }
    return left
  }
  function parseCompare() {
    let left = parseAdd()
    while (['=', '==', '!=', '<', '<=', '>', '>='].includes(peek())) {
      const op = take()
      const right = parseAdd()
      const numeric = isInteger(left) && isInteger(right)
      const a = numeric ? Number(left) : String(left)
      const b = numeric ? Number(right) : String(right)
      const result = op === '=' || op === '==' ? a === b : op === '!=' ? a !== b : op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b
      left = result ? '1' : '0'
    }
    return left
  }
  function arithmetic(op, left, right) {
    if (!isInteger(left) || !isInteger(right)) throw new SyntaxProblem('non-integer argument')
    const a = BigInt(left), b = BigInt(right)
    if ((op === '/' || op === '%') && b === 0n) throw new EvalProblem('division by zero')
    return String(op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : op === '/' ? a / b : a % b)
  }
  function parseAdd() {
    let left = parseMul()
    while (peek() === '+' || peek() === '-') { const op = take(); left = arithmetic(op, left, parseMul()) }
    return left
  }
  function parseMul() {
    let left = parseMatch()
    while (peek() === '*' || peek() === '/' || peek() === '%') { const op = take(); left = arithmetic(op, left, parseMatch()) }
    return left
  }
  function parseMatch() {
    let left = parsePrimary()
    while (peek() === ':') { take(); left = matches(String(left), String(parsePrimary())) }
    return left
  }
  function parsePrimary() {
    const token = take()
    if (token === undefined) throw new SyntaxProblem('syntax error: missing argument')
    if (token === '(') {
      const value = parseOr()
      if (take() !== ')') throw new SyntaxProblem("syntax error: expecting ')'")
      return value
    }
    if (token === '+') { const next = take(); if (next === undefined) throw new SyntaxProblem('syntax error: missing argument'); return next }
    if (token === 'length') return String(Array.from(String(parsePrimary())).length)
    if (token === 'substr') {
      const text = String(parsePrimary()); const start = Number(parsePrimary()); const length = Number(parsePrimary())
      if (!Number.isInteger(start) || !Number.isInteger(length)) throw new SyntaxProblem('non-integer argument')
      return start < 1 || length < 1 ? '' : Array.from(text).slice(start - 1, start - 1 + length).join('')
    }
    if (token === 'index') {
      const text = String(parsePrimary()); const chars = String(parsePrimary())
      const letters = Array.from(text)
      const at = letters.findIndex(letter => chars.includes(letter))
      return String(at + 1)
    }
    if (token === 'match') return matches(String(parsePrimary()), String(parsePrimary()))
    return token
  }

  const value = parseOr()
  if (pos < tokens.length) throw new SyntaxProblem(`syntax error: unexpected argument '${tokens[pos]}'`)
  return value
}

const args = argv.slice(1)
if (args[0] === '--help') {
  writeAll(1, encoder.encode(`Usage: expr EXPRESSION
Print the value of EXPRESSION. Operators, lowest precedence first:

  A | B     A if it is neither empty nor 0, else B
  A & B     A if neither is empty or 0, else 0
  A < B, A <= B, A = B, A != B, A >= B, A > B   comparison: numeric when both are integers
  A + B, A - B, A * B, A / B, A % B             integer arithmetic
  STRING : REGEX     anchored match; the length, or the part in \\( \\)
  ( EXPR )  length STRING  substr STRING POS LENGTH  index STRING CHARS  match STRING REGEX

Quote the characters the shell uses. The status is 0 for a result that is not empty or 0, 1 when it is,
2 for a syntax error and 3 for an error while evaluating.
`))
  exit(0)
}
if (args.length === 0) { err('missing operand'); exit(2) }

try {
  const result = evaluate(args)
  writeAll(1, encoder.encode(result + '\n'))
  exit(truthy(result) ? 0 : 1)
} catch (error) {
  err(error?.message ?? String(error))
  exit(error instanceof EvalProblem ? 3 : 2)
}
