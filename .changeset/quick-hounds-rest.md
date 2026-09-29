---
"@ecmaos/kernel": minor
---

## `exec` with redirections, and `$LINENO`

**`exec > run.log 2>&1`** at the top of a script now sends everything after it to a file. The shell
already carried inherited redirections for compound statements, so `exec` installs one more layer --
the outermost, with no matching pop, so it outlives every statement until another `exec` replaces
it. A command's own redirection and any enclosing statement's both still win over it, and `>`
truncates once for the whole shell rather than once per command.

`exec < file` does the same for input, so successive `read` calls advance through one open file.

The command form (`exec prog args`) replaces the shell's process image, which ecmaOS has nothing to
do yet: the shell is a main-thread object, not a program a worker is running. It reports that rather
than approximating it, because "run it and carry on" is a different thing with the same spelling.
`/bin/ecmash` is where it becomes possible.

A builtin no longer takes its direct-to-terminal fast path while `exec` redirections are installed.
With `exec > file` there is no such thing as "nothing redirected": the shell's own fd 1 is the file,
and a builtin writing straight to the terminal would escape it.

**`$LINENO`** reports the physical line of the statement running now. Physical is the interesting
part: blank lines and comments are counted so the number matches what an editor shows, every
statement normalized out of one compact line (`if x; then y; fi`) reports the line it was written
on, and a heredoc no longer shifts what follows it -- `foldHeredocs` collapses a body into its
command's line and now pads the gap back, which costs nothing since blank lines are dropped anyway.

This needed the statement parser to carry positions, so normalization moved to run per physical line
inside `preprocessLines` rather than over the whole script first. Every `Statement` now has an
optional `lineNumber`.
