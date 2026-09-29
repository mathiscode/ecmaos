---
"@ecmaos/kernel": minor
"@ecmaos/types": minor
---

## The rest of the `set` options

`set` accepted exactly `-e`, `+e`, `-u`, `+u` and `-o pipefail`, and reported anything else as
unsupported. That included `set -euo pipefail`, the single most common first line in a shell script,
because `-euo` is a cluster and clusters were not understood at all.

Now supported: letter clusters (`set -eux`), an `o` inside one taking the next argument as its long
name, the `-o` long name for every flag, `set -o` with no name listing them all, and `set -- a b c`
to replace the positional parameters.

Four new flags:

- **`-x` (xtrace)** prints each command behind `$PS4` before running it, with its arguments already
  expanded -- which is the point, since xtrace exists to show what a command actually received.
  Traced as written (`+ echo hi`, not `+ /bin/echo hi`), and it covers builtins and function calls
  as well as programs. Like bash, it writes to the *shell's* stderr, so `cmd 2>f` does not swallow
  the trace.
- **`-f` (noglob)** turns pathname expansion off, so `*` and `?` stay literal.
- **`-C` (noclobber)** stops `>` truncating an existing file. `>>` is unaffected, and **`>|`** is the
  explicit override, which is new as a redirection operator. A refused redirection is reported and
  fails that pipeline rather than throwing, so the rest of the script survives it.
- **`-v` (verbose)** echoes each line of input as it is read.

`$-` reflects `-x`/`-f`/`-C`/`-v` alongside the flags it already showed.

`Shell.shellOptions` is now a named `ShellOptionState` and `applyShellOption` takes a
`ShellOptionName`, rather than both spelling out the three original flags inline.
