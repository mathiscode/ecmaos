# sudoers

`man @ecmaos/coreutils/sudoers`

## Synopsis

```
/etc/sudoers
```

## Description

The file `sudo` reads to decide who may run what as whom. A subset of the real grammar:

```
# a comment
Defaults timestamp_timeout=5
Defaults !authenticate

root    ALL=(ALL:ALL) ALL
%sudo   ALL=(ALL:ALL) ALL
alice   ALL=(root) NOPASSWD: /bin/ls, /bin/cat /etc/hosts
bob     ALL=(root) /bin/ls, !/bin/rm, (alice) PASSWD: ALL
```

**Who** is `ALL`, a user name, `%group`, `%#gid` or `#uid`, comma separated. **Host** is `ALL` or this host's name (`/etc/hostname`).

**Runas** is `(users)` or `(users:groups)`; the group part is accepted and ignored. It and the tags `PASSWD:` and `NOPASSWD:` apply to every command after them in the list until another is given.

**Commands** are `ALL` or an absolute path. A path ending in `/` means every file in that directory; `*` matches anything. Arguments after the path are the only ones allowed (`""` means none). A `!` in front forbids the command. The last rule that matches decides, and no match means no.

**Defaults** understood: `timestamp_timeout=N` (minutes; 0 asks every time, a negative number never forgets) and `authenticate` / `!authenticate`. Any other `Defaults` is reported and ignored.

Not supported, and reported on standard error rather than guessed at: `User_Alias` and the other aliases, `#include` and `#includedir`, `SETENV:` and `NOEXEC:` tags.

A line ending in a backslash continues on the next. A line that does not parse is skipped.

## See also

`@ecmaos/coreutils/sudo`, `@ecmaos/coreutils/su`
