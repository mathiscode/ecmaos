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
  "assign/prefix-function": { stdout: "[]\n", status: 0, why: "NAME=v before a shell function call is not visible inside the function" },
  "assign/readonly": { stdout: "1 1\n", status: 0, why: "a failed assignment to a readonly variable does not end the script (bash exits with status 1)" },
  "builtins/type": { stdout: "echo is /bin/echo\n1\n", status: 0, why: "echo is an external /bin/echo here, not a builtin" },
  "expansion/glob": { stdout: "a.txt b.txt\na.txt b.txt c.md\n*\nc.md\n[ab].txt\n", status: 0, why: "[ab] bracket globs are not expanded" },
  "expansion/glob-dot": { stdout: ".hid vis\n", status: 0, why: "* matches dotfiles" },
  "expansion/lineno": { stdout: "2\n3\n", status: 0, why: "$LINENO is wrong" },
  "options/dollar-dash": { stdout: "no-e\n", status: 0, why: "$- is not supported inside case patterns (script fails to parse)" },
  "options/errexit-subshell": { stdout: "after\n", status: 0, why: "set -e is not inherited by a subshell" },
  "options/nounset": { stdout: "THREW nope: unbound variable", status: -1, why: "an unbound variable throws out of executeScriptText instead of ending the script with status 1" },
  "traps/signal": { stdout: "after\n", status: 0, why: "a trapped signal sent with kill is not delivered" },
}

export const knownEcmash: KnownTable = {
  "builtins/background-status": { stdout: "0\n", status: 0, why: "a background subshell is refused: it would run in this process, which cannot also carry on with the next prompt" },
  "control/pipestatus": { stdout: "0\n0\n", status: 0, why: "PIPESTATUS holds one entry: a pipeline reports a single status here" },
  "options/errexit-subshell": { stdout: "after\n", status: 0, why: "set -e is not inherited by a subshell" },
  "options/nounset": { stdout: "before\nno\n", status: 0, why: "an unbound variable is reported but the script continues; bash exits with status 1" },
  "read/eof-status": { stdout: "TIMEOUT", status: -2, why: "read with input from /dev/null never returns" },
  "redirect/devnull": { stdout: "TIMEOUT", status: -2, why: "cat < /dev/null never returns" },
  "traps/exit-status": { stdout: "st=0\n", status: 5, why: "$? inside an EXIT trap is 0, not the exit status" },
}
