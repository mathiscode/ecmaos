---
"@ecmaos/kernel": minor
"@ecmaos/coreutils": patch
---

## Descriptor names in `/dev`, and `ps` from `/proc`

### New

- `/dev/fd`, `/dev/stdin`, `/dev/stdout` and `/dev/stderr`, the links Linux ships into
  `/proc/self/fd`. These names existed only inside the WASI shim, so `tee /dev/stderr` or
  `cat /dev/stdin` found nothing. `open` and `stat` of them (and of `/proc/self/fd/N`) resolve to the
  caller's own descriptor, because procfs serves an fd link as a path and a pipe's path cannot be
  opened.
- `ps` prints `PID PPID UID COMMAND`, read from `/proc/<pid>/{status,comm,cmdline,exe}`.

### Changed

- `killall` matches names from `/proc` too. The `ps_list` custom syscall, and its scratch file, are gone.
- `ps` no longer prints a STATUS column. `/proc/<pid>/status` reports every process as running, so
  the column could only be wrong for a stopped or exited one.
- The stale `/proc` descriptions (`/proc/host`, `/proc/language`, `/proc/memory`,
  `/proc/querystring`, `/proc/userAgentData`) named entries that were never created.

### Fixed

- `cat` printed nothing for a pipe named by path, since a pipe reports size 0.
