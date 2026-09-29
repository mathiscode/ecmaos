---
"@ecmaos/kernel": patch
---

Two bugs a live browser pass found that the unit tests could not.

## An assignment anywhere but the start of a line failed

`echo one; zz=5` reported `Command not found: zz=5`. `tryExecuteAssignment` only ever looked at the
head of a line, and handled a *trailing* assignment by recursing into the remainder -- which never
happened when the head was an ordinary command, so the assignment reached the pipeline path and was
looked up as a program.

This predates the one-line function work but that work makes it constant, because a one-line body is
exactly a `;`-joined list: `k() { local v; v=42; echo $v; }` failed on `v=42`.

The line is now split before such an assignment and the tail handed back through `execute`, where the
assignment is at the head again. `&&` and `||` keep their meaning across the split (`false && a=ran`
does not assign, `false || b=ran` does), `set -e` still stops after a failing `;`, and a command
carrying prefix assignments (`X=1 cmd`) is deliberately not treated as one -- those stay scoped to
their command.

It works on the raw text rather than the parsed pipeline because an array literal does not survive
tokenization intact: `arr=(a b)` becomes the two words `arr=(a` and `b)`, so by the time there are
words to inspect there is no assignment left to recognize.

## `exit 8` at the prompt did not set `$?`

`echo $?` on the next line still printed whatever the command before it had returned. Every other exit
code is recorded by `executeSimple` as it finishes a stage, and a control-flow signal unwinds straight
past that. The unit tests read `Shell.execute`'s return value, which was correct all along -- only the
next prompt line could see the difference. A stray `return` and a stray `break` record theirs too.
