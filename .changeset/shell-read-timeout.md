---
"@ecmaos/kernel": minor
"@ecmaos/coreutils": minor
---

`read -t SECONDS` works in the kernel shell on input from a file or a pipe and exits 142 when nothing arrives in time; `ecmash` still refuses it because a worker has no timed read. A command not found while a startup file runs is now reported as `FILE: line N: cmd: command not found`.
