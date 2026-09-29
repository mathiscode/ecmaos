---
"@ecmaos/kernel": minor
"@ecmaos/types": minor
---

## The control-flow builtins: `break`, `continue`, `exit`, `return`

None of these can be a program. A child process cannot break its parent's loop or return from its
parent's function, and an exit code cannot express any of them: it has no way to distinguish "this
command exited 1" from "stop the enclosing loop". They are now builtins that throw an unwind signal
the interpreter catches, which is how every real shell implements them.

- **`break N` / `continue N`.** `break` and `continue` existed, but only as a comparison of a
  statement's whole trimmed text against the string `'break'`. So `break 2` never reached the outer
  loop, `break;` never fired, and `test -d "$d" && break` went looking for a `/bin/break` that does
  not exist. All three work now, and `N` counts down through enclosing loops.
- **`exit [N]`** ends the running script with N, defaulting to `$?` so `cmd || exit` propagates the
  real failure. The `EXIT` trap still runs. Interactively it sets the exit code and stops the line;
  it does not tear down the session, which ecmaOS has no path for yet.
- **`return [N]`** leaves a function or a sourced file from any depth, also defaulting to `$?`.
- `break` deliberately stops at a function boundary, as in bash: a helper containing a stray `break`
  must not stop its caller's loop.

A stray one at the prompt now reports bash's own diagnostic instead of escaping as an internal error
in red.

## `source`/`.`, `eval`, `shift` and `:`

- **`source FILE [ARG...]`** and **`.`** run a file's lines in the calling shell, so variables,
  functions and `cd` all persist. `$PATH` is searched when the name has no slash. `return` returns
  from the sourced file; `exit` exits the shell that sourced it; the `EXIT` trap does *not* fire when
  the file ends, which would otherwise run the shell's cleanup handler on every `source`. This is the
  prerequisite for `/etc/profile` and `~/.ecmashrc`.
- **`eval ARG...`** joins its arguments and runs them in the calling shell, so `eval "x=1"` really
  sets `x`.
- **`shift [N]`** drops positional parameters, leaving `$0` alone, and fails without changing
  anything when N exceeds `$#` -- which is what terminates `while [ $# -gt 0 ]; do ...; shift; done`
  rather than spinning.
- **`:`** succeeds and does nothing, so `while :; do ... done` works.

## One-line function definitions

`greet() { echo hi; }` matched no parser rule. It fell through as an ordinary command line and the
shell reported `greet()` as a command not found, so the most common way to write a function in an rc
file did not work at all. Both spellings now parse on one line, including a nested block:
`check() { if test -d /tmp; then echo yes; fi; }`.

A `;`-joined body stays one statement for `Shell.executeSimple` to walk, exactly as a `;`-joined line
typed at the prompt does.

A body *started* on the header line and closed later (`greet() { echo hi` then `}`) matched nothing
either, which was worse at an interactive prompt: the line read as complete, so the prompt ran it
immediately instead of asking for the closing brace. Both now continue correctly, including when the
line opens a nested block (`check() { if true; then`).

## Redirections on aggregate commands

A compound statement's closing keyword, a function call, and `eval`/`source` are not commands with a
set of fds -- each runs a whole statement tree whose commands build their own streams. Their
redirections were parsed and then silently discarded, so `done > out` left `out` untouched and printed
to the screen. This is the same bug `done < f` had on the input side.

The redirection is now held for the duration of the aggregate command and inherited by every command
inside it, with a command's own redirection still winning:

```sh
for f in *.log; do echo "$f"; done > index.txt   # one file, not one per iteration
greet > greeting.txt                             # the function's whole body
source setup.sh > setup.log                      # every command in the file
while read -r l; do echo "got $l"; done < in > out
```

`>` truncates once for the whole statement and appends afterwards, which is what one shared
descriptor would do; without that, a loop body would reopen the file per iteration and only the last
iteration would survive.

Fixing this also uncovered that `stdoutIsTTY` was computed from a command's own redirections alone,
so a command inheriting one was told its stdout was a terminal when it was a file.

### Known limits

- `eval` and `source` inherit only *file* redirections this way, not a pipe, so `eval 'echo x' | grep x`
  still writes to the terminal.
- `Shell.executeSourced` is what `source`/`eval` run through, and it is now public on the `Shell`
  interface alongside `positionalParameters` and `shiftPositionalParameters`.
