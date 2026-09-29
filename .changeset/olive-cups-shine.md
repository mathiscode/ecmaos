---
"@ecmaos/kernel": minor
---

## Special parameters

`$$`, `$PPID`, `$!`, `$-`, `$RANDOM`, `$SECONDS` and `$SHLVL` all expanded to nothing. `$$` matters
most: it is what every script reaches for to name a temp file (`/tmp/work.$$`).

They split two ways, the same way bash's do.

`$SHLVL` is a real environment entry, because it only means anything when a child shell inherits it
and adds one. Nothing nests shells yet, so every virtual console is level 1; the increment is written
so `/bin/ecmash` reports 2 the day it can run inside another shell.

The rest are computed at every read, which is the only way `$RANDOM` can give a new number and
`$SECONDS` can count up on its own. They sit between the `local` frames and the environment, so
`local RANDOM` shadows them as it would any variable, and they are kept out of a child's environment
where a name like `-` or `!` has no business.

- **`$$` and `$PPID`** come from a real, registered `@zenfs/linux` `Process` the shell owns. Inventing
  a number would eventually collide with a real pid, and ecmaOS allocates pids from that table, so
  the only honest way to get one is to take it from there. The process never exits, which is correct
  (a shell *is* a process, and `ps` shows it), and its descriptors go to `/dev/null` rather than the
  console, the same choice `Kernel.pipeProcess` makes. It is created lazily, since a `Shell` exists
  before `Kernel.boot` has mounted `/dev`. When `/bin/ecmash` lands this stops being a stand-in.
- **`$RANDOM`** gives 0..32767. Assigning to it seeds the generator rather than replacing the value,
  as in bash, so `RANDOM=42` makes the sequence that follows reproducible. The sequence does not match
  bash's, which nothing portable could.
- **`$SECONDS`** counts from shell start, and assigning to it restarts the clock.
- **`$-`** lists the flags in effect, gaining `e`/`u` from `set`.
- **`$!`** is the pid of the most recent background job, unset until there is one.

## Output redirection targets are expanded

`echo x > /tmp/work.$$` created a file named literally `/tmp/work.$$`, while every other reference to
that path expanded normally. The input side has always expanded its target; the output side used the
raw word. `> $dir/$name` and `> "$dir/two words.txt"` now name the file the script meant.
