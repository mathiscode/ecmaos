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
