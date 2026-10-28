# pstree

`man @ecmaos/coreutils/pstree`

## Synopsis

```
pstree [-acglnpsuAU] [PID|USER]
```

## Description

Show the running processes as a tree, read from `/proc`. Children are sorted by name, or by pid with `-n`. Identical leaves are merged as `N*[name]` unless `-c`, `-a` or `-p` is given.

`-p` shows pids and `-g` process groups. `-u` shows where the user changes, and `-a` shows command lines. With a PID the tree starts there (`-s` also shows its parents). With a USER it starts at that user's highest processes.

pid 1's tree comes first. Any other process with no parent here, such as one the kernel starts itself, roots a tree of its own after it. Lines are drawn in UTF-8, or in ASCII with `-A` or when the locale is `C`. Long lines are cut at `$COLUMNS` (132 by default) unless `-l` is given.

## Options

```
  -a  command lines
  -A  ASCII lines
  -c  do not merge identical leaves
  -g  process groups
  -l  do not cut long lines
  -n  sort by pid
  -p  pids
  -s  parents of the given pid
  -u  user changes
  -U  UTF-8 lines
```

## See also

`ps`, `top`
