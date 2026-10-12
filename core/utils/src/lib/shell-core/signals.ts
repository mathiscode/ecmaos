/**
 * The unwind signals behind `break`, `continue`, `return` and `exit`. They alter control flow, which an exit code
 * cannot express, so they are thrown.
 * | Signal | Caught by |
 * |---|---|
 * | `BreakSignal` / `ContinueSignal` | the nearest enclosing loop, which decrements `level` and rethrows while it is above 1 |
 * | `ReturnSignal` | `callFunction`, and `source`'s sourced script |
 * | `ExitSignal` | `executeScriptText` and `execute` at depth 0 |
 * A stray `break` or `return` at the prompt gets bash's diagnostic from the depth-0 catch.
 */

/** `break [N]`: leave the Nth enclosing loop (default the innermost). */
export class BreakSignal extends Error {
  constructor(public level: number = 1) {
    super('break')
    this.name = 'BreakSignal'
  }
}

/** `continue [N]`: start the next iteration of the Nth enclosing loop (default the innermost). */
export class ContinueSignal extends Error {
  constructor(public level: number = 1) {
    super('continue')
    this.name = 'ContinueSignal'
  }
}

/** `return [N]`: leave the current function or sourced script with exit code N. */
export class ReturnSignal extends Error {
  constructor(public code: number = 0) {
    super('return')
    this.name = 'ReturnSignal'
  }
}

/** `exit [N]`: leave the current script, or the whole line at an interactive prompt, with code N. */
export class ExitSignal extends Error {
  constructor(public code: number = 0) {
    super('exit')
    this.name = 'ExitSignal'
  }
}

/**
 * bash's numeric-argument handling for these builtins: missing means the caller's default, non-numeric is an error,
 * and the value is taken modulo 256 (`exit -1` gives 255).
 */
export function parseSignalArgument(argv: string[], builtin: string): { value?: number, error?: string } {
  const raw = argv[0]
  if (raw === undefined) return {}
  if (!/^[+-]?\d+$/.test(raw)) return { error: `${builtin}: ${raw}: numeric argument required` }
  return { value: ((Number(raw) % 256) + 256) % 256 }
}
