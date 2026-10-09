# quota

`man @ecmaos/kernel/commands/quota`

## Synopsis

```
quota [-b] [-r] [USER]
```

## Description

Shows a user's storage quota and how much of it their files use. A user sees their own; root names anyone, or leaves USER out to
list every quota that is set.

Quotas are written in `/etc/quota`, one per line: a user name or uid and a size (`k`, `m`, `g`, `t`; `#` starts a comment).

```
# who gets what
alice 100M
1002  2G
```

What counts is the size of the files a user owns on the root filesystem (a hard link once). `/tmp` and the other mounts are not the
root's and are not counted. A write or truncate that would take a file's owner past the quota fails with `EDQUOT` ("disk quota
exceeded"), the file unchanged. Root cannot have a quota, and a user with no line has none.

Usage is an estimate that grows with each write and is measured exactly (a walk of the root) the first time a user is checked and
whenever a write would go over, so space freed by deleting files is found then; a write is refused only if the measured figure still
does not fit. The quotas are read at boot; after editing `/etc/quota`, run `quota -r` as root.

## Options

```
  -b, --bytes   sizes in bytes
  -r, --reload  read /etc/quota again (root)
  --help        display this help and exit
```

## See also

`df`, `@ecmaos/coreutils/du`, `@ecmaos/coreutils/fsck`
