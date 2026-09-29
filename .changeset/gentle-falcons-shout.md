---
"@ecmaos/kernel": minor
"@ecmaos/types": minor
---

## `alias`, `unalias`, `type`, `command`, `getopts`, `readonly`, `declare`

**Aliases** are text substitution at command position, not a name lookup, and that distinction is
the whole feature: `alias ll='ls -la'` has to contribute two words, and `alias sudo='sudo '` (note
the trailing space) has to make the *next* word eligible in turn. Neither is expressible by swapping
one name for another. Substitution repeats so one alias can name another, and a name already
substituted on a pass is not substituted again -- which is what lets `alias ls='ls -la'` mean "the
real `ls`, with flags" instead of looping forever.

A command position is the start of a statement and whatever follows a top-level `;`, `&`, `|`, `&&`
or `||`, so an alias name appearing as an argument (`echo ll`) is untouched.

*Known limit:* substitution runs after statement parsing, not before, so an alias whose value is
control flow (`alias loop='for i in 1 2; do'`) is not recognized as such.

**`type`** says how a name would resolve -- alias, reserved word, builtin, function, or `$PATH` file
-- in the order the shell itself checks, with `-t` for just the kind and `-p` for just the path.

**`command [-v|-V]`** runs a name ignoring any function of the same name, which is what keeps
`ls() { command ls -la "$@"; }` from recursing.

**`getopts`** is the loop condition of every script that takes flags. `$OPTIND` and `$OPTARG` work as
in POSIX, including a leading `:` for silent error reporting, `-ovalue` and `-o value`, stopping at
the first operand or `--` with `$OPTIND` left pointing at it (so `shift $((OPTIND - 1))` works). A
cluster like `-abc` needs a second cursor that `$OPTIND` cannot express, so the shell keeps one, and
assigning `OPTIND=1` resets both.

**`readonly`** and **`declare`/`typeset`**. The readonly attribute is shell-wide rather than
per-scope, matching bash, and cannot be taken back. A refused assignment or unset is reported and
fails that command rather than throwing, so the rest of the script survives it. `declare` covers
`-r`, `-a`, `-p`, `-f`, `-F` and plain assignment; `-x` is accepted and does nothing, because every
variable here already reaches a child's environment. `-i`, `-A`, `-l`, `-u` and `-n` report that they
are unsupported rather than silently ignoring the attribute.

## `env` and `command` redirect what they run

Both run their real work through `shell.execute`, which builds its own streams, so
`env FOO=bar cmd > log` and `command ls > log` wrote to the terminal. They join `eval` and `source`
as aggregate builtins, whose redirections are held for the duration and inherited by everything they
run.

## Deliberately not implemented: `umask`, `times`, `hash`

Each would be a facade rather than a feature, so they are left out with the reason recorded:

- **`umask`** has nothing to enforce it. Upstream `SYS_umask` is a stub returning a constant `0o022`
  and no file-creation path consults a mask. A `umask 077` that stored the value and changed nothing
  would leave a script believing its files were protected.
- **`times`** reports user and system CPU time for the shell and its children. A browser has no CPU
  accounting to report, and wall-clock numbers in those four fields would be actively misleading.
- **`hash`** manages a command-location cache. There is no such cache here (`resolveCommand` walks
  `$PATH` every time), so the builtin would have nothing to manage. Adding the cache is a performance
  change with its own staleness questions, not a builtin gap.
