# complete

`man @ecmaos/coreutils/complete`

## Synopsis

```
complete [-abcdefgjksuv] [-pr] [-DEI] [-o OPTION] [-A ACTION] [-G GLOBPAT] [-W WORDLIST] [-F FUNCTION] [-C COMMAND] [-X FILTERPAT] [-P PREFIX] [-S SUFFIX] [NAME ...]
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. Registers how the arguments of each NAME are completed when Tab is pressed, in both shells. Without options it prints the registered specifications; `complete -p` prints them as the commands that make them.

Candidates come from the actions (`-a` aliases, `-b` builtins, `-c` commands, `-d` directories, `-e` exported variables, `-f` files, `-g` groups, `-k` keywords, `-u` users, `-v` variables, and `-A` with any of `arrayvar`, `enabled`, `function`, `helptopic`, `setopt`, `shopt`, `signal`, ...), a glob (`-G`), a word list (`-W`, expanded first), a function (`-F`) or a command (`-C`). `-X` removes candidates matching a pattern (a leading `!` keeps only them), and `-P` and `-S` add a prefix and a suffix.

A `-F` function runs in the shell with `COMP_WORDS`, `COMP_CWORD`, `COMP_LINE`, `COMP_POINT`, `COMP_TYPE` and `COMP_KEY` set, and its arguments are the command, the word being completed and the word before it. It fills `COMPREPLY`; the candidates are offered as it gives them, so it should filter by the word itself, as bash's do (`COMPREPLY=($(compgen -W "a b" -- "$2"))`). If it returns 124, the specification is looked up again, which is how a loader registers the real one. A `-C` command's output lines are the candidates.

The bash-completion package's helper functions (`_init_completion` and the rest) are not provided.

## Options

- `-p` -- print the specifications
- `-r` -- remove the specification of each NAME, or all of them
- `-D` -- the specification for a command that has none of its own
- `-E` -- for an empty line
- `-I` -- for the first word of a line
- `-o OPTION` -- `default` (filenames when nothing matches), `dirnames`, `plusdirs`, `filenames` (escape spaces, mark directories), `nospace`, `nosort`, `bashdefault`, `noquote`

## Examples

```
complete -W 'start stop status' svc
_g() { COMPREPLY=($(compgen -W 'checkout commit' -- "$2")); }
complete -F _g git
```

## Exit status

0, 1 when a NAME has no specification (with `-p` or `-r`), 2 for a usage error.

## See also

`compgen`, `compopt`, `@ecmaos/coreutils/ecmash`
