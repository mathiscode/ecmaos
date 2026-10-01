---
"@ecmaos/kernel": minor
"@ecmaos/coreutils": patch
---

`disown` now works in the kernel shell (`disown`, `disown %N`, `disown -a`). `shift N` past the end says `shift: N: shift count out of range`. `sed` accepts any delimiter for `s` (`s|a|b|`, `s#a#b#`) and an escaped delimiter inside the pattern.
