---
"@ecmaos/kernel": minor
"@ecmaos/coreutils": minor
---

The kernel shell and `/bin/ecmash` now share one interpreter for the statement walk: lists, `set -e`, functions, subshells and `break`/`continue`/`return`/`exit`. The kernel shell gains the `ERR` trap, `$?` in an `EXIT` trap, and a correct `set -e` for `a && b`; `ecmash` gains `$LINENO`, `PIPESTATUS`, and a working `return` inside a function.
