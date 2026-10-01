---
"@ecmaos/kernel": minor
"@ecmaos/coreutils": minor
---

Associative arrays in both shells: `declare -A m`, `m[key]=v`, `m=([k]=v ...)`, `m+=(...)`, `${m[key]}`, `${!m[@]}`, `${#m[@]}`, `unset m[key]`, and `local -A`. A key listing is in insertion order rather than bash's hash order. Both shells now run array assignments through one shared function.
