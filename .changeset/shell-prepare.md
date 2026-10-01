---
"@ecmaos/kernel": minor
"@ecmaos/coreutils": minor
---

Both shells now classify assignments the same way (`shell-core/prepare`). The kernel shell's second, text-based expansion path is gone: `$(...)` runs any command list, nests, and reports its status (`x=$(false); echo $?` is 1); `s+=x`, `local a=(1 2)` and `NAME=v` anywhere in a line work. In `ecmash`, `exit` inside `$(...)` ends only the substitution.
