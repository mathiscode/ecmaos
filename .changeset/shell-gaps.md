---
"@ecmaos/coreutils": minor
"@ecmaos/kernel": minor
---

## Shell language gaps closed in the shared parser and expander

Found by checking both shells against bash. Both the kernel shell and `ecmash` now handle:

- **Parsing:** a one-line function followed by more commands (`f() { ...; }; f`), `if`/`for`/`while`/`case` inside a one-line function body, a one-line `case ... esac`, `{ ...; }` or `( ... )` with a redirection followed by more commands, `until` loops, and a `;` inside a comment, a quote or `$( )` no longer splitting a command.
- **Arithmetic:** `**`, `<< >>`, `& | ^ ~`, `?:`, assignment (`= += -= ...`), `x++`/`--x`, hex and octal.
- **Parameter expansion:** `${x:off:len}`, `${x#pat}` `${x##pat}` `${x%pat}` `${x%%pat}`, `${x/pat/rep}` and its `//` `/#` `/%` forms, `${x^^}` `${x,,}` `${x^}` `${x,}`, `${!name}`, `${!a[@]}`, and slices of arrays and `$@`.
- **`"$*"`** joins with the first character of `IFS`.
- **`printf`** widths, flags, precision, `*`, and `%f` `%e` `%g`.
- **`ecmash`** applies brace expansion, which only the kernel shell did.

A `;`-joined line is now one statement per command. A subshell followed by `&&`, `||` or `|` is still refused, and so is a compound command as a pipeline stage.

A multi-line command recalled from history joins after a block opener with a space (`do echo`, not `do; echo`), and the parser accepts a stray `;` after `do`, `then` and `else`, so an entry saved by an earlier version still runs.
