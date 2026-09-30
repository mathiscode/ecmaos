---
"@ecmaos/coreutils": minor
"@ecmaos/kernel": minor
---

## `/bin/ecmash`, `chsh` and `/etc/shells`

`ecmash` is the shell as a real program: it runs in a worker on the same parsers and expander as the kernel shell and reaches the system only through syscalls (`spawn`, `waitpid`, `killpg`, `pipe`, `open`, the terminal ioctls). It runs `-c` commands, script files, stdin, and an interactive prompt with line editing and history in `~/.ecmash_history`. A pipeline stage killed by `^C` stops the rest of its pipeline through `killpg`. See `man @ecmaos/kernel/commands/ecmash` for what it covers.

`chsh -s SHELL [USER]` changes a login shell, checked against the new `/etc/shells` (`/bin/ecmash` and `ecmaos`); `chsh -l` lists them. History moved from `~/.history` to `~/.ecmash_history` (filesystem migration 4).

Fixed on the way:

- A reader blocked on an empty pipe never noticed the last writer closing, because upstream wakes a pipe only when data moves. Pipelines hung now and then depending on timing. Pipes are now woken on every close and on process exit.
- A spawned child kept every descriptor its parent held, so a pipe's write end stayed open in unrelated children and readers never saw EOF. A child now gets descriptors 0 to 2 only.
- `grep` accepts `-E`, `-F`, `-v` and `-q`, and exits 1 when nothing matched, as scripts expect.
