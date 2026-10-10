# ulimit

`man @ecmaos/coreutils/ulimit`

## Synopsis

```
ulimit [-SHa] [-cdefilmnpqrstuvxR] [LIMIT]
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. Shows resource limits. Only some are real here, and `ulimit` says so rather than pretend:

- `-f` (file size, in 1024-byte blocks) is the machine's cap on one file, which depends on the device's memory (512 MiB on one with 8 GB or more). A write past it fails with `EFBIG`. It is the same for every process.
- `-c` is 0: no core file is ever written.
- `-p` (pipe size), `-e` and `-r` (priorities) are fixed.
- the rest (`-d -i -l -m -n -q -s -t -u -v -x -R`) are unlimited, because nothing limits them.

Setting a limit to the value it already has succeeds, so `ulimit -c 0` and `ulimit -n unlimited` work in scripts. Raising one is refused as it is for an unprivileged user (`cannot modify limit: Operation not permitted`), and lowering one is refused because nothing would enforce it (`cannot lower the limit: nothing here enforces it`). `-S` and `-H` are accepted; the soft and hard limits are the same.

## Options

- `-a` -- list every limit
- `-f` -- the largest file (the default when no resource is named)
- `-c` -- core file size
- `-n` -- open files
- `-s` -- stack size
- `-t` -- cpu time
- `-u` -- user processes
- `-v` -- virtual memory

## Examples

```
ulimit -f        # 524288
ulimit -c        # 0
ulimit -a
```

## Exit status

0, or 1 when a limit cannot be set.

## See also

`@ecmaos/coreutils/ecmash`, `df`
