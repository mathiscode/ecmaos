---
"@ecmaos/kernel": patch
---

## `do`/`then` followed by a command on its own line

Typing `for i in 1 2`, then `do echo $i`, then `done` ran nothing and reported nothing. The parser
consumed the whole `do echo $i` line as if it were a bare `do`, so the loop's first command vanished
without an error. `if` and `while` refused `then echo x` on its own line outright. All three now take
the keyword and keep the rest of the line, as bash does.

## Multi-line commands in history

A multi-line command was stored with embedded newlines, which the file format (one command per line)
turned into several entries after the next reload, and which drew wrongly when recalled. It is stored
as one line joined with `;`, as bash's `cmdhist` does. A heredoc cannot be joined that way, so it is
not recorded.

Bound editing chords (`^R`, `^A`, `^U`, ...) now call `preventDefault`, so the browser cannot claim them.
