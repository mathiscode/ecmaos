---
"@ecmaos/kernel": minor
"@ecmaos/types": minor
---

## Shell builtins honor redirections and work in pipelines

True shell builtins (`cd`, `set`, `bg`, `fg`, `jobs`, `wait`, `local`, `env`,
`export`, `su`, `trap`, `unset`) wrote straight to the terminal, which meant two
divergences from every real shell:

- Their output ignored redirections entirely. `jobs > f` printed to the screen
  and left `f` empty.
- They could not appear in a pipeline at all. `export -p | grep PATH` fell
  through to a `/bin/export` lookup that deliberately does not exist, and failed
  as command-not-found.

Everything a builtin reads or writes now goes through a new `ShellBuiltinIO`
carrying fds 0, 1 and 2, and `Shell.runPipeline` wires a builtin stage exactly
like any other stage. Diagnostics moved to fd 2 at the same time, so
`cd /nope 2>/dev/null` is silent and usage text from `--help` still goes to
fd 1.

A lone builtin with nothing redirected keeps a direct-to-terminal path that
allocates no streams, so `cd` inside a loop costs what it did before.

## Real `$IFS`, a `read` builtin, and command-prefix assignments

`while IFS= read -r line; do ...; done < file` now works. It needed four
separate things, none of which existed:

- **`$IFS` was decorative.** Word splitting was the hardcoded regex
  `/[ \t\n]+/`. It now follows POSIX, which splits on two classes of character
  with different rules: a run of IFS whitespace delimits one field and is
  ignored at either end of the input, while *each* IFS non-whitespace character
  delimits a field. So `IFS=:` makes `a::b` three fields with an empty one in
  the middle, `a:` stays one field, and `:a` is two. `IFS=` set but empty
  disables splitting entirely; `$IFS` unset still means the default.
- **`read`** (`-r`, `-s`, `-p`, names, `REPLY`, `$IFS` splitting, non-zero at
  EOF). The last name receives the rest of the line with its delimiters intact,
  so `read a b <<< '1 2 3'` puts `2 3` in `b`. `-n`, `-d`, `-t` and `-a` report
  that they are unsupported rather than silently reading a whole line; they need
  character-level terminal reads.
- **Command-prefix assignments.** `NAME=VALUE cmd args` applies those
  assignments only while `cmd` runs. Previously `IFS= read -r line` did not even
  parse as a command: the assignment handler matched `IFS=`, found no
  `;`/`&&`/`|` after it, and stored the literal text `read -r line` as IFS's
  value. Quoting in the value is honored, so `X='$HOME' cmd` passes the literal
  text and `X="$HOME" cmd` passes the path.
- **A redirection on a compound statement's closing keyword.** `done < file`,
  `fi < file`, `esac < file` parsed and were then silently discarded, so the
  loop read from the terminal. The statement now opens that input once and every
  `read` in the body advances through it.

Known limitation: inside a redirected compound statement, only builtins read the
statement's input. A real command gets an immediately-closed stdin instead, so
`while read a; do cat; done < f` gives `cat` nothing where bash gives it the rest
of the file. The stdin bridge pumps as fast as the stream yields rather than as
the process reads, so handing it the shared input would drain the file on the
first command in the loop body.

`Shell.lookupVariable` is now public, since `read` needs the same scope-aware
lookup an expansion does.
