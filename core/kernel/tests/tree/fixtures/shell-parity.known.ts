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
  "assign/append-string": { stdout: "a\n", status: 0, why: "s+=value on a scalar is not supported" },
  "assign/local-array": { stdout: "(1\n9\n", status: 0, why: "local with an array literal (local a=(1 2)) is not parsed as an array" },
  "assign/prefix-function": { stdout: "[]\n", status: 0, why: "NAME=v before a shell function call is not visible inside the function" },
  "assign/readonly": { stdout: "1 1\n", status: 0, why: "a failed assignment to a readonly variable does not end the script (bash exits with status 1)" },
  "builtins/background-status": { stdout: "THREW A subshell followed by \"&\" is not supported; put it on its own line", status: -1, why: "a subshell run in the background ((cmd) &) is not supported" },
  "builtins/cd-pwd": { stdout: "/tmp/pc/a/b\n/tmp/pc/a\n/tmp/pc/a\n", status: 0, why: "cd - does not return to the previous directory" },
  "builtins/test-bracket": { stdout: "0\n127\n127\n", status: 0, why: "[ ... ] does not exist (127); only test and [[ ]] do" },
  "builtins/test-negations": { stdout: "", status: 127, why: "[ ... ] does not exist (127)" },
  "builtins/type": { stdout: "echo is /bin/echo\n1\n", status: 0, why: "echo is an external /bin/echo here, not a builtin" },
  "builtins/wait": { stdout: "TIMEOUT", status: -2, why: "wait after a background sleep exits 7 and prints nothing (a bare `sleep & wait` has also been seen to never return)" },
  "control/break-continue": { stdout: "1\n2\n3\n4\n", status: 0, why: "[ ... ] does not exist (127)" },
  "control/for-c-style": { stdout: "THREW Malformed for-loop header: for ((i=0; i<3; i++)) do", status: -1, why: "C-style for ((;;)) is not supported" },
  "control/group": { stdout: "THREW Expected a redirection, got: |", status: -1, why: "{ ...; } followed by a pipe is not parsed" },
  "control/if-elif": { stdout: "other\n", status: 0, why: "[ ... ] does not exist (127)" },
  "control/one-line-nested-compound": { stdout: "other\nother\n", status: 0, why: "[ ... ] does not exist (127), so the else branch always runs" },
  "control/pipe-into-loop": { stdout: " \n", status: 127, why: "a compound command as a pipeline stage is not supported (a brace group after a pipe)" },
  "control/test-operators": { stdout: "noent\n", status: 127, why: "[ ... ] does not exist (127)" },
  "control/while-counter": { stdout: "", status: 0, why: "[ ... ] does not exist (127)" },
  "control/while-read": { stdout: "got \n", status: 127, why: "a compound command as a pipeline stage is not supported (run as a command named while)" },
  "expansion/command-subst": { stdout: "a\na\n", status: 0, why: "$(...) runs only the first command of a ; list" },
  "expansion/command-subst-nested": { stdout: "$(echo deep)\none two\n", status: 0, why: "a $(...) nested inside double quotes inside $(...) is not expanded" },
  "expansion/command-subst-status": { stdout: "1\n0\n", status: 0, why: "$? after x=$(false) or x=$(exit 4) is 0: the assignment ignores the substitution's status" },
  "expansion/glob": { stdout: "a.txt b.txt\na.txt b.txt c.md\n*\nc.md\n[ab].txt\n", status: 0, why: "[ab] bracket globs are not expanded" },
  "expansion/glob-dot": { stdout: ".hid vis\n", status: 0, why: "* matches dotfiles" },
  "expansion/lineno": { stdout: "2\n3\n", status: 0, why: "$LINENO is wrong" },
  "functions/recursion": { stdout: "THREW unexpected end of expression", status: -1, why: "$(...) nested inside $(( )) fails to evaluate (unexpected end of expression)" },
  "functions/stdin": { stdout: "", status: 127, why: "a shell function used as a pipeline stage is looked up as a command (127)" },
  "options/dollar-dash": { stdout: "no-e\n", status: 0, why: "$- is not supported inside case patterns (script fails to parse)" },
  "options/errexit-subshell": { stdout: "after\n", status: 0, why: "set -e is not inherited by a subshell" },
  "options/nounset": { stdout: "THREW nope: unbound variable", status: -1, why: "an unbound variable throws out of executeScriptText instead of ending the script with status 1" },
  "read/array": { stdout: "0\n", status: 0, why: "read -a is not supported" },
  "redirect/dup": { stdout: "THREW Expected a redirection, got: |", status: -1, why: "{ ...; } followed by a pipe is not parsed" },
  "traps/err": { stdout: "after\n", status: 0, why: "the ERR trap does not exist" },
  "traps/exit-status": { stdout: "st=0\n", status: 5, why: "$? inside an EXIT trap is 0, not the exit status" },
  "traps/signal": { stdout: "after\n", status: 0, why: "a trapped signal sent with kill is not delivered" },
}

export const knownEcmash: KnownTable = {
  "assign/append-string": { stdout: "a\n", status: 0, why: "s+=value on a scalar is not supported" },
  "assign/local-array": { stdout: "1 2\n1 2\n", status: 0, why: "local with an array literal (local a=(1 2)) is not parsed as an array" },
  "builtins/background-status": { stdout: "", status: 2, why: "a subshell run in the background ((cmd) &) is not supported" },
  "control/for-c-style": { stdout: "", status: 2, why: "C-style for ((;;)) is not supported" },
  "control/group": { stdout: "", status: 2, why: "{ ...; } followed by a pipe is not parsed" },
  "control/pipe-into-loop": { stdout: " \n", status: 127, why: "a compound command as a pipeline stage is not supported (a brace group after a pipe)" },
  "control/pipestatus": { stdout: "\n\n", status: 0, why: "PIPESTATUS is not supported" },
  "control/while-read": { stdout: "got \n", status: 127, why: "a compound command as a pipeline stage is not supported (run as a command named while)" },
  "expansion/command-subst-status": { stdout: "0\n", status: 4, why: "exit inside $(...) ends the whole shell, and $? after x=$(false) is 0" },
  "expansion/lineno": { stdout: "0\n0\n", status: 0, why: "$LINENO is always 0" },
  "getopts/basic": { stdout: "i=\n", status: 0, why: "getopts is not a builtin in ecmash (the loop never runs)" },
  "getopts/error": { stdout: "", status: 0, why: "getopts is not a builtin in ecmash (the loop never runs)" },
  "options/errexit-subshell": { stdout: "after\n", status: 0, why: "set -e is not inherited by a subshell" },
  "options/noclobber": { stdout: "0\nb\nc\n", status: 0, why: "set -C is not supported" },
  "options/noglob": { stdout: "a b\na b\n", status: 0, why: "set -f is not supported" },
  "options/nounset": { stdout: "before\nno\n", status: 0, why: "an unbound variable is reported but the script continues; bash exits with status 1" },
  "read/array": { stdout: "1\n", status: 0, why: "read -a is not supported" },
  "read/eof-status": { stdout: "TIMEOUT", status: -2, why: "read with input from /dev/null never returns" },
  "read/ifs-empty": { stdout: "[a b]\n", status: 0, why: "IFS= before read still trims whitespace" },
  "read/ifs-split": { stdout: "x|y z\n", status: 0, why: "IFS=: before read does not split on the colon" },
  "redirect/devnull": { stdout: "TIMEOUT", status: -2, why: "cat < /dev/null never returns" },
  "redirect/dup": { stdout: "", status: 2, why: "{ ...; } followed by a pipe is not parsed" },
  "traps/exit-status": { stdout: "st=0\n", status: 5, why: "$? inside an EXIT trap is 0, not the exit status" },
}
