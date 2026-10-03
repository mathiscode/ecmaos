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

export const knownEcmash: KnownTable = {}
