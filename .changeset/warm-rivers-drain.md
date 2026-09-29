---
"@ecmaos/kernel": minor
"@ecmaos/coreutils": patch
"@ecmaos/types": minor
---

## `local` now covers arrays, and a bare `local` declares without setting

`local` only ever scoped scalars, so every array was shell-global no matter where it was assigned. A
function that built up `arr` silently overwrote its caller's `arr`, and a recursive one overwrote its
own between levels. Arrays and scalars are separate stores here, so `local arr` now declares the name
in both: whichever kind it is later assigned as is local either way.

`local NAME` with no value also leaves the name *unset* rather than set to the empty string, which is
what bash does -- `${NAME+set}` is empty and `set -u` still objects. Only `local NAME=` sets it to
empty. It expands as empty and shadows the caller either way; the difference is exactly the one a
script can test for.

This is what the "callFunction saves only positional parameters" item was really about. Saving
`_arrays`, `_traps`, `_shellOptions` and `$?` around every call, as first sketched, would have been
*less* faithful, not more: in bash a trap or a `set -e` from inside a function persists after it
returns, and `$?` after a call is the function's own status. Only the arrays needed scoping, and they
needed it through `local`, not through the call boundary.

## A redirected command's output is complete before its exit code is reported

`Kernel.executeViaExecve` slept a flat 15ms and hoped, because a program's stdout reaches a file
through a main-thread pump rather than the program writing the file itself. 15ms is a guess, and under
load not a good one: a loaded parallel test run intermittently read a half-written redirect target
while the identical case passed every time in isolation.

Each pump already drained its pipe fully once the program closed its end, so there was a real
completion signal to await all along. `bridgeFd` now exposes it and the kernel waits on it.

Mid-pipeline stdout is deliberately exempt (`KernelExecuteOptions.drainStdout`), and the exemption is
load-bearing rather than a shortcut: the next stage's own reads already order the data, and a
downstream program that exits early (`seq 1 20000 | head -n 1`) stops reading, fills the pipe, and
would leave the upstream drain waiting forever. fd 2 is never a pipe to another stage, so it is always
awaited.

## `ls` reports a missing operand, `seq` terminates its last line

Both turned up while proving the drain fix, and both were wrong independently of it.

- **`ls /nope` printed nothing and exited 0.** It skipped a missing operand on a comment claiming that
  was standard behavior; GNU `ls` writes `cannot access` to stderr and exits 2. `isDirectory` on a
  missing path returns false rather than throwing, so the operand also fell through to the single-file
  branch and was then quietly dropped for having no stats. Targets that do exist are still listed
  alongside one that does not.
- **`seq` left off the final newline** unless `-s` had changed the separator, so `seq 1 200 > f`
  produced a file with no trailing newline and `wc -l < f` reported 199. GNU `seq` always terminates
  its last line, whatever `-s` is. An empty range now prints nothing at all rather than a bare newline.
