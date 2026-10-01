---
"@ecmaos/kernel": minor
"@ecmaos/coreutils": minor
---

The builtins that change the shell's own state now exist once, in `shell-core/builtins`, and both shells run them: `cd`, `set`, `export`, `unset`, `local`, `readonly`, `declare`, `read`, `trap`, `shift`, `getopts`, `alias`, `unalias`, `type`, `command`, `eval`, `source`, `exit`, `return`, `break`, `continue`, `test` and `[`. The kernel shell gains `[` and `test` (there was no `[` command), `cd -` and `cd` with no argument going to `$HOME`, and `read -a`. `ecmash` gains `getopts`, `set -f`/`-C`/`-v`, `read -r -s -p`, `command -v`, `type -t` and the kernel's `declare`/`readonly`. Error messages from these builtins are now the same in both shells, with `ecmash:` still in front of `ecmash`'s.
