---
"@ecmaos/kernel": minor
"@ecmaos/coreutils": minor
---

`declare -i` works in both shells: assignments to an integer variable are evaluated as arithmetic and `+=` adds (`declare -i n=3+4` gives 7). `read -n COUNT` and `read -d DELIM` work on input from a file or a pipe (`read -rd ''` included), and `-d` reports end of file when the data ran out before the delimiter. On a terminal they say so rather than reading a whole line. `read -t` is still refused.
