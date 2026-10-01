---
"@ecmaos/kernel": minor
"@ecmaos/coreutils": minor
---

A compound command can be a stage of a pipeline in both shells: `cmd | while read x; do ...; done`, `{ a; b; } | cmd`, `(a; b) | cmd`, `for ...; done | sort`, chains of them, and a shell function as a stage (`echo x | f`). Each compound stage runs in a subshell, so what it assigns does not outlive it, as in bash. In the kernel shell a background subshell, `(cmd) &`, works too and `wait $!` finds it; `ecmash` refuses it, since a worker cannot run a subshell and carry on at the same time. In `ecmash` the compound stages run in the shell process once the pipeline's programs are spawned, so a compound stage that writes more than a pipe holds to a compound stage that has not started still waits. A multi-line `( ... )` or `{ ...` whose first line holds a one-line loop now parses.
