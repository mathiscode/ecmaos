---
"@ecmaos/kernel": minor
"@ecmaos/types": minor
---

## `local` scoping is no longer bypassed by `export` and `unset`

Both wrote `shell.env` directly, as if no `local` frame could exist. Inside a function that meant:

- `local X=1; export X=2` left the local shadowing `X` sitting at 1, and destroyed the **caller's**
  `X` permanently.
- `unset X` could not remove a local at all. The frame kept shadowing the name, so `$X` still read its
  local value, while the global went away.

`export NAME=VALUE` now goes through `setVariable`, so an active frame is written. `unset` goes through
a new `Shell.unsetVariable`, which marks the innermost frame that declared the name rather than
deleting a binding it does not own -- the same thing bash does, which is why `$X` reads empty for the
rest of the call and the caller's value comes back when the function returns.

`unset` also grew `-v`/`-f`, and now unsets a variable if one exists by that name rather than removing
a variable *and* a same-named function in one go.

`env` and `export -p` read `shell.env` too, so inside a function they listed the caller's values.
Both now use `Shell.visibleVariables()`: `local` frames layered over the environment, with the shell's
own internals left out.

## A child process's environment is no longer the shell's whole variable map

`envObject` is what every `execve`'d command receives as its `envp`, and it was
`Object.fromEntries(shell.env)` -- the entire map. So every command in ecmaOS started life with `?=0`
in its environment, and inside a script or function the positional parameters arrived as environment
variables named `0`, `1`, `2`. `execve` passes `envp`; `1=arg` is not an environment variable.

`$?` and the positional parameters (and the other one-character specials) are now filtered out. They
remain fully visible to expansion, which is the only place they were ever meant to be read.

Remaining gap, in the other direction: a bare `X=1` still reaches a child here, where bash requires
`export X` first. Closing that needs a real exported-flag store, and every `shell.env.set` call site
would have to declare its intent.

## `globalThis.process.env` belongs to one shell at a time

ecmaOS runs up to eight shells at once, one per virtual console, and every one of them wrote to
`globalThis.process.env` -- a single global object. Two TTYs clobbered each other's variables and
whichever logged in last decided what `$PATH` the others saw.

That object is a compatibility mirror for code written against Node, not a source of truth; each
shell's own `Map` is. So exactly one shell publishes to it now: the one whose TTY is active.
`Kernel.switchTty` hands ownership over as consoles switch, the way `/proc/self` follows the current
process instead of being shared between them.

This also removed the hand-rolled save/restore of `process.env` in the `env` builtin, which was
keeping a second copy in step by hand.

`Shell` gains `unsetVariable`, `visibleVariables`, `publishEnv` and `claimProcessEnv`.
