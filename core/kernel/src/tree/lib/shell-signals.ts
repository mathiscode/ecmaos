/**
 * The unwind signals behind `break`, `continue`, `return` and `exit`.
 *
 * These four builtins don't run a command, they alter the interpreter's own control flow, and an
 * exit code cannot express any of them: a return code can't distinguish "this command legitimately
 * exited 1" from "stop the enclosing loop" or "leave this function". That ambiguity is exactly why
 * every real shell implements them as builtins that unwind the interpreter rather than as commands
 * that report a status, and why they are thrown here.
 *
 * They live in their own module because `Shell` catches them and `lib/shell-builtins.ts` throws
 * them, so putting them in either one would make the two modules a value-level import cycle.
 *
 * Who catches what:
 *
 * | Signal | Caught by |
 * |---|---|
 * | `BreakSignal` / `ContinueSignal` | the nearest enclosing loop in `Shell.executeStatements` (`while`/`for`), which decrements `level` and rethrows while it is still above 1 |
 * | `ReturnSignal` | `Shell.callFunction`, and `source`'s `runInSourcedScript` |
 * | `ExitSignal` | `Shell.executeScriptText` and `Shell.execute` at depth 0 |
 *
 * Each has a last-resort catch at depth 0 in `Shell.execute` as well, so a stray `break` or
 * `return` typed at the prompt reports bash's diagnostic instead of escaping to
 * `Terminal`'s catch-all and printing an internal error in red.
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
 * bash's own numeric-argument handling for these four builtins: a missing argument means "use the
 * default" (the caller's, since it differs per builtin), a non-numeric one is an error, and the
 * value is taken modulo 256 because a real wait status carries only one byte -- so `exit -1` reports
 * 255 exactly as in bash.
 */
export function parseSignalArgument(argv: string[], builtin: string): { value?: number, error?: string } {
  const raw = argv[0]
  if (raw === undefined) return {}
  if (!/^[+-]?\d+$/.test(raw)) return { error: `${builtin}: ${raw}: numeric argument required` }
  return { value: ((Number(raw) % 256) + 256) % 256 }
}
