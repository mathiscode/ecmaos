---
"@ecmaos/kernel": patch
---

## A missing command no longer ends the script

`prepareCommand` threw when a command name resolved to nothing, and the throw unwound the entire
statement tree. One typo in a script silently dropped every line after it, and at the prompt
`nosuchcmd; echo hi` never printed `hi`.

It is a `CommandNotFoundError` now, caught where the pipeline stage is built: that one command fails
with exit 127, as in bash, and everything after it still runs. The exit code was 1 before, which was
also wrong.

Found by the browser pass for the startup files, where the cost is highest: a typo in `~/.ecmashrc`
took the rest of the file with it.
