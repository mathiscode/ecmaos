/**
 * `$VAR` / `${VAR}` / `${VAR:-default}` / `${VAR:+alt}` variable expansion, and `$((expr))`
 * arithmetic expansion. Neither existed before this branch: word expansion only ever covered
 * tilde, `$(...)` command substitution, and history-bang (`Shell.prepareCommand`) -- a plain `$VAR`
 * in a command word passed through untouched. Control flow needs both (`while [ $i -lt 10 ]`,
 * `for i in $(seq 1 3)`, `x=$((x + 1))`), so this is genuinely new shell surface, not a rewire.
 *
 * Expansion order matches a real shell closely enough for scripting purposes: arithmetic first
 * (its `$((...))` syntax would otherwise be mistaken for two nested `${(...)}` expansions), then
 * variables. Single-quoted spans are already stripped of their quote characters by the tokenizer
 * before expansion ever sees them, so this module only has one job left: don't mistake a literal
 * `$` inside what was double-quoted content for something to skip -- there is nothing to skip,
 * since quote characters are gone by this point. This mirrors `expandTilde`'s comment: expansion
 * happens on close-to-final text, not on a quote-aware token stream.
 */

/** Look up a shell variable, matching bash's special variables where they matter for scripting. */
export type VariableLookup = (name: string) => string | undefined

class ArithmeticError extends Error {}

/**
 * A small recursive-descent arithmetic evaluator over the POSIX `$((...))` operator set that
 * scripts actually use: `+ - * / %`, unary `+ -`, `!`, comparisons, `&& ||`, and parentheses.
 * Bitwise operators and `**` are intentionally out of scope -- not used anywhere in ecmaOS's own
 * scripts/tests, and easy to add later without touching the surrounding expansion logic.
 */
function evaluateArithmetic(expr: string, lookup: VariableLookup): number {
  const tokens = expr.match(/\d+\.?\d*|[A-Za-z_][A-Za-z0-9_]*|&&|\|\||==|!=|<=|>=|[-+*/%()<>!]/g) ?? []
  let pos = 0

  const peek = () => tokens[pos]
  const next = () => tokens[pos++]

  const resolveOperand = (token: string): number => {
    if (/^\d/.test(token)) return Number(token)
    const value = lookup(token)
    if (value === undefined || value === '') return 0
    const n = Number(value)
    return Number.isNaN(n) ? 0 : n
  }

  function parseOr(): number {
    let left = parseAnd()
    while (peek() === '||') { next(); const right = parseAnd(); left = (left || right) ? 1 : 0 }
    return left
  }

  function parseAnd(): number {
    let left = parseComparison()
    while (peek() === '&&') { next(); const right = parseComparison(); left = (left && right) ? 1 : 0 }
    return left
  }

  function parseComparison(): number {
    let left = parseAdditive()
    while (['==', '!=', '<', '>', '<=', '>='].includes(peek() ?? '')) {
      const op = next() as string
      const right = parseAdditive()
      switch (op) {
        case '==': left = left === right ? 1 : 0; break
        case '!=': left = left !== right ? 1 : 0; break
        case '<': left = left < right ? 1 : 0; break
        case '>': left = left > right ? 1 : 0; break
        case '<=': left = left <= right ? 1 : 0; break
        case '>=': left = left >= right ? 1 : 0; break
      }
    }
    return left
  }

  function parseAdditive(): number {
    let left = parseMultiplicative()
    while (peek() === '+' || peek() === '-') {
      const op = next()
      const right = parseMultiplicative()
      left = op === '+' ? left + right : left - right
    }
    return left
  }

  function parseMultiplicative(): number {
    let left = parseUnary()
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = next()
      const right = parseUnary()
      if ((op === '/' || op === '%') && right === 0) throw new ArithmeticError('division by zero')
      left = op === '*' ? left * right : op === '/' ? Math.trunc(left / right) : left % right
    }
    return left
  }

  function parseUnary(): number {
    if (peek() === '-') { next(); return -parseUnary() }
    if (peek() === '+') { next(); return parseUnary() }
    if (peek() === '!') { next(); return parseUnary() === 0 ? 1 : 0 }
    return parsePrimary()
  }

  function parsePrimary(): number {
    const token = next()
    if (token === undefined) throw new ArithmeticError('unexpected end of expression')
    if (token === '(') {
      const value = parseOr()
      if (next() !== ')') throw new ArithmeticError('expected )')
      return value
    }
    return resolveOperand(token)
  }

  const result = parseOr()
  if (pos < tokens.length) throw new ArithmeticError(`unexpected token: ${tokens[pos]}`)
  return result
}

/** Evaluate a `$((...))` body. Thrown errors are the caller's to decide how to surface. */
export function evaluateArithmeticExpression(expr: string, lookup: VariableLookup): number {
  return evaluateArithmetic(expr, lookup)
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
 * Expand `$VAR`, `${VAR}`, `${VAR:-default}`, and `${VAR:+alt}` in a word. Applied after tilde,
 * command substitution, and arithmetic expansion, matching the order a real shell resolves these
 * in (arithmetic and command substitution can themselves produce text a variable expansion would
 * otherwise have already skipped past).
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
