/**
 * `$VAR`, `${VAR}`, `${VAR:-default}`, `${VAR:+alt}` and `$((expr))` expansion. Arithmetic runs first, since
 * `$((...))` would otherwise read as nested `${(...)}`, then variables. Quote characters are already stripped by the
 * tokenizer.
 */

/** Look up a shell variable, matching bash's special variables where they matter for scripting. */
export type VariableLookup = (name: string) => string | undefined

export class ArithmeticError extends Error {}

/**
 * A recursive-descent evaluator for `$((...))` in C precedence: assignment operators, `?:`, `||`, `&&`, `|`, `^`,
 * `&`, equality, comparison, shifts, `+ -`, `* / %`, `**` (right associative), unary `+ - ! ~`, and `++`/`--`.
 * Integers only (decimal, `0x`, leading-`0` octal), bitwise on 64 bits. `assign` lets `x++` and `x+=2` write back.
 */
function evaluateArithmetic(expr: string, lookup: VariableLookup, assign?: (name: string, value: string) => void): number {
  const tokens = expr.match(/0[xX][0-9a-fA-F]+|\d+|[A-Za-z_][A-Za-z0-9_]*|<<=|>>=|\*\*|\+\+|--|&&|\|\||==|!=|<=|>=|<<|>>|[-+*/%&|^]=|[-+*/%()<>!~?:&|^=,]/g) ?? []
  let pos = 0

  const peek = () => tokens[pos]
  const next = () => tokens[pos++]
  const isName = (token: string | undefined): token is string => token !== undefined && /^[A-Za-z_]/.test(token)

  const read = (name: string): number => {
    const value = lookup(name)
    if (value === undefined || value === '') return 0
    const n = Number(value)
    return Number.isNaN(n) ? 0 : n
  }
  const write = (name: string, value: number) => { assign?.(name, String(value)) }

  const number = (token: string): number => {
    if (/^0[xX]/.test(token)) return parseInt(token, 16)
    if (/^0\d/.test(token)) return parseInt(token, 8)
    return Number(token)
  }

  const big = (n: number) => BigInt.asIntN(64, BigInt(Math.trunc(n)))
  const bitwise = (op: string, l: number, r: number): number => {
    const a = big(l)
    const b = big(r)
    switch (op) {
      case '&': return Number(BigInt.asIntN(64, a & b))
      case '|': return Number(BigInt.asIntN(64, a | b))
      case '^': return Number(BigInt.asIntN(64, a ^ b))
      case '<<': return Number(BigInt.asIntN(64, a << BigInt.asUintN(6, b)))
      default: return Number(BigInt.asIntN(64, a >> BigInt.asUintN(6, b)))
    }
  }

  const apply = (op: string, left: number, right: number): number => {
    switch (op) {
      case '+': return left + right
      case '-': return left - right
      case '*': return left * right
      case '/': case '%':
        if (right === 0) throw new ArithmeticError('division by 0 (error token is "0")')
        return op === '/' ? Math.trunc(left / right) : left % right
      default: return bitwise(op, left, right)
    }
  }

  function parseAssignment(): number {
    if (isName(peek()) && /^(?:[-+*/%&|^]|<<|>>)?=$/.test(tokens[pos + 1] ?? '') && tokens[pos + 1] !== '==') {
      const name = next() as string
      const op = next() as string
      const right = parseAssignment()
      const value = op === '=' ? right : apply(op.slice(0, -1), read(name), right)
      write(name, value)
      return value
    }
    return parseTernary()
  }

  function parseTernary(): number {
    const condition = parseOr()
    if (peek() !== '?') return condition
    next()
    const yes = parseAssignment()
    if (next() !== ':') throw new ArithmeticError('expected :')
    const no = parseAssignment()
    return condition ? yes : no
  }

  function parseOr(): number {
    let left = parseAnd()
    while (peek() === '||') { next(); const right = parseAnd(); left = (left || right) ? 1 : 0 }
    return left
  }

  function parseAnd(): number {
    let left = parseBitOr()
    while (peek() === '&&') { next(); const right = parseBitOr(); left = (left && right) ? 1 : 0 }
    return left
  }

  function parseBitOr(): number {
    let left = parseBitXor()
    while (peek() === '|') { next(); left = bitwise('|', left, parseBitXor()) }
    return left
  }

  function parseBitXor(): number {
    let left = parseBitAnd()
    while (peek() === '^') { next(); left = bitwise('^', left, parseBitAnd()) }
    return left
  }

  function parseBitAnd(): number {
    let left = parseEquality()
    while (peek() === '&') { next(); left = bitwise('&', left, parseEquality()) }
    return left
  }

  function parseEquality(): number {
    let left = parseComparison()
    while (peek() === '==' || peek() === '!=') {
      const op = next()
      const right = parseComparison()
      left = (op === '==' ? left === right : left !== right) ? 1 : 0
    }
    return left
  }

  function parseComparison(): number {
    let left = parseShift()
    while (['<', '>', '<=', '>='].includes(peek() ?? '')) {
      const op = next() as string
      const right = parseShift()
      switch (op) {
        case '<': left = left < right ? 1 : 0; break
        case '>': left = left > right ? 1 : 0; break
        case '<=': left = left <= right ? 1 : 0; break
        case '>=': left = left >= right ? 1 : 0; break
      }
    }
    return left
  }

  function parseShift(): number {
    let left = parseAdditive()
    while (peek() === '<<' || peek() === '>>') { const op = next() as string; left = bitwise(op, left, parseAdditive()) }
    return left
  }

  function parseAdditive(): number {
    let left = parseMultiplicative()
    while (peek() === '+' || peek() === '-') {
      const op = next() as string
      left = apply(op, left, parseMultiplicative())
    }
    return left
  }

  function parseMultiplicative(): number {
    let left = parsePower()
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = next() as string
      left = apply(op, left, parsePower())
    }
    return left
  }

  /** `**` binds tighter than `* /` and looser than unary, and groups to the right. */
  function parsePower(): number {
    const base = parseUnary()
    if (peek() !== '**') return base
    next()
    const exponent = parsePower()
    if (exponent < 0) throw new ArithmeticError('exponent less than 0')
    return base ** exponent
  }

  function parseUnary(): number {
    const token = peek()
    if (token === '-') { next(); return -parseUnary() }
    if (token === '+') { next(); return parseUnary() }
    if (token === '!') { next(); return parseUnary() === 0 ? 1 : 0 }
    if (token === '~') { next(); return Number(BigInt.asIntN(64, ~big(parseUnary()))) }
    if ((token === '++' || token === '--') && isName(tokens[pos + 1])) {
      next()
      const name = next() as string
      const value = read(name) + (token === '++' ? 1 : -1)
      write(name, value)
      return value
    }
    return parsePostfix()
  }

  function parsePostfix(): number {
    if (isName(peek()) && (tokens[pos + 1] === '++' || tokens[pos + 1] === '--')) {
      const name = next() as string
      const op = next()
      const value = read(name)
      write(name, value + (op === '++' ? 1 : -1))
      return value
    }
    return parsePrimary()
  }

  /** The comma operator: evaluates each side in turn and yields the last. */
  function parseComma(): number {
    let value = parseAssignment()
    while (peek() === ',') { next(); value = parseAssignment() }
    return value
  }

  function parsePrimary(): number {
    const token = next()
    if (token === undefined) throw new ArithmeticError('unexpected end of expression')
    if (token === '(') {
      const value = parseComma()
      if (next() !== ')') throw new ArithmeticError('expected )')
      return value
    }
    return isName(token) ? read(token) : number(token)
  }

  const result = parseComma()
  if (pos < tokens.length) throw new ArithmeticError(`unexpected token: ${tokens[pos]}`)
  return result
}

/** Evaluate a `$((...))` body. Thrown errors are the caller's to decide how to surface. */
export function evaluateArithmeticExpression(expr: string, lookup: VariableLookup, assign?: (name: string, value: string) => void): number {
  try {
    return evaluateArithmetic(expr, lookup, assign)
  } catch (error) {
    // bash names the expression: `1/0: division by 0 (error token is "0")`
    if (error instanceof ArithmeticError) throw new ArithmeticError(`${expr.trim()}: ${error.message}`)
    throw error
  }
}

/**
 * Expand `$((expr))` arithmetic substitutions in a word. Runs before variable expansion so that
 * `${` inside an arithmetic expression (there isn't any in the supported grammar, but `$x` is)
 * never gets misread as a parameter expansion.
 */
export function expandArithmetic(input: string, lookup: VariableLookup): string {
  let result = ''
  let i = 0

  while (i < input.length) {
    if (input[i] === '$' && input[i + 1] === '(' && input[i + 2] === '(') {
      // Depth starts at 2 to account for the two opening parens already consumed in `$((`; the
      // expression is closed only once both are balanced back out (`))`), not by the first `)`
      // that merely balances an inner, expression-local paren.
      let depth = 2
      let j = i + 3
      while (j < input.length && depth > 0) {
        if (input[j] === '(') depth++
        else if (input[j] === ')') depth--
        j++
      }

      if (depth === 0) {
        const body = input.slice(i + 3, j - 2)
        try {
          result += String(evaluateArithmetic(body, lookup))
        } catch {
          result += '' // Matches the rest of the shell's "expansion failure yields empty" convention
        }
        i = j
        continue
      }
    }

    result += input[i]
    i++
  }

  return result
}

/**
 * Expands `$VAR`, `${VAR}`, `${VAR:-default}` and `${VAR:+alt}` in a word, after tilde, command substitution and
 * arithmetic.
 */
export function expandVariables(input: string, lookup: VariableLookup): string {
  let result = ''
  let i = 0

  while (i < input.length) {
    if (input[i] === '$' && input[i + 1] === '{') {
      const close = input.indexOf('}', i + 2)
      if (close !== -1) {
        const body = input.slice(i + 2, close)
        const defaultMatch = /^([A-Za-z_][A-Za-z0-9_]*):-(.*)$/.exec(body)
        const altMatch = /^([A-Za-z_][A-Za-z0-9_]*):\+(.*)$/.exec(body)

        if (defaultMatch) {
          const [, name, fallback] = defaultMatch as unknown as [string, string, string]
          const value = lookup(name)
          result += value ? value : fallback
        } else if (altMatch) {
          const [, name, alt] = altMatch as unknown as [string, string, string]
          const value = lookup(name)
          result += value ? alt : ''
        } else {
          result += lookup(body) ?? ''
        }

        i = close + 1
        continue
      }
    }

    if (input[i] === '$' && /[A-Za-z_]/.test(input[i + 1] ?? '')) {
      let j = i + 1
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j] as string)) j++
      result += lookup(input.slice(i + 1, j)) ?? ''
      i = j
      continue
    }

    // `$?`, `$#`, `$@`, `$0`-`$9`: single-character special/positional parameters.
    if (input[i] === '$' && /[?#@*0-9]/.test(input[i + 1] ?? '')) {
      result += lookup(input[i + 1] as string) ?? ''
      i += 2
      continue
    }

    result += input[i]
    i++
  }

  return result
}

/** Run arithmetic then variable expansion, the order `prepareCommand` applies to every word. */
export function expandWord(input: string, lookup: VariableLookup): string {
  return expandVariables(expandArithmetic(input, lookup), lookup)
}
