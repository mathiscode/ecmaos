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

`Shell.lookupVariable` is now public, since `read` needs the same scope-aware
lookup an expansion does.

## Input redirection fixes

Four bugs found while building the above, two of which could wedge the shell:

- **`cmd < /dev/null` hung forever.** A character device read reports the full
  length requested no matter what its driver produced (`DeviceFS.read` discards
  the driver's count, and `@zenfs/core` skips the size clamp for devices by
  design), so the read loop never saw end of file. `/dev/null` is now recognized
  by its device number, 1:3, exactly as on Linux.
- **Reading an endless device hung too, and large files were buffered whole.**
  Input redirection read the entire file inside the stream's `start`, before the
  stream was usable. It now reads one chunk per `pull`, so `head -c 4 < /dev/zero`
  returns four bytes instead of never returning, and a redirect no longer holds
  the whole file in memory.
- **`head` read all of stdin before taking the first lines or bytes.** It now
  stops once it has enough, which is what makes `head -c 4` on an endless stream
  terminate and lets `head` on a pipe print without waiting for the writer.
- **`printf` applied its format once.** POSIX reuses the format until the
  arguments run out, so `printf '[%s]\n' a b c` now prints three lines instead of
  one. A specifier with no argument left formats as empty rather than printing the
  specifier text, and a format with no specifiers is printed exactly once.

## `for` lists expand like command arguments

`for f in $x` never word-split: the statement parser regex-split the list and
stripped its quotes, so by the time the loop ran there was no quoting left to
decide what could split. The list is now kept verbatim and expanded by the same
expander a command's arguments use, so `for f in $x` iterates the fields,
`for f in "a b"` stays one value, `for f in *.txt` matches files, and
`for f in $(cmd)` works.

`ForStatement.words: string[]` is therefore now `ForStatement.wordsText: string`.
