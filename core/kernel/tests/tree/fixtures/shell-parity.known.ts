/**
 * Where a shell is known to differ from bash on a corpus case, with what it actually does and why.
 *
 * `shell-parity.test.ts` pins the actual output, so fixing a divergence makes the test fail until the
 * entry is deleted here: this table can only shrink. Every entry needs a reason; "not implemented"
 * is a reason, "unknown" is not.
 */
export interface KnownDivergence {
  stdout: string
  status: number
  why: string
}

export type KnownTable = Record<string, KnownDivergence>

export const knownKernel: KnownTable = {
  "builtins/type": { stdout: "echo is /bin/echo\n1\n", status: 0, why: "echo is an external /bin/echo here, not a builtin" },
}

export const knownEcmash: KnownTable = {
  "builtins/background-status": { stdout: "0\n", status: 0, why: "a background subshell is refused: it would run in this process, which cannot also carry on with the next prompt" },
  "control/pipestatus": { stdout: "0\n0\n", status: 0, why: "PIPESTATUS holds one entry: a pipeline reports a single status here" },
  "read/eof-status": { stdout: "TIMEOUT", status: -2, why: "read with input from /dev/null never returns" },
  "redirect/devnull": { stdout: "TIMEOUT", status: -2, why: "cat < /dev/null never returns" },
  "traps/exit-status": { stdout: "st=0\n", status: 5, why: "$? inside an EXIT trap is 0, not the exit status" },
}
