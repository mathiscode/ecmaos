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

User_Alias ADMINS = alice, %ops
Cmnd_Alias READ = /bin/ls, /bin/cat /etc/hosts
ADMINS  ALL=(root) NOPASSWD: READ
```

**Who** is `ALL`, a user name, `%group`, `%#gid` or `#uid`, comma separated. **Host** is `ALL` or this host's name (`/etc/hostname`).

**Runas** is `(users)` or `(users:groups)`; the group part is accepted and ignored. It and the tags `PASSWD:` and `NOPASSWD:` apply to every command after them in the list until another is given.

**Commands** are `ALL` or an absolute path. A path ending in `/` means every file in that directory; `*` matches anything. Arguments after the path are the only ones allowed (`""` means none). A `!` in front forbids the command. The last rule that matches decides, and no match means no.

**Aliases** name a list: `User_Alias`, `Runas_Alias`, `Host_Alias` and `Cmnd_Alias`, each `NAME = member, member`, with several definitions on one line separated by `:`. Names are upper case. An alias may use other aliases and may be defined after the rule that uses it. A `!` in front of a command alias forbids every command in it. An upper-case name that is not an alias is taken as a user or host name.

**Defaults** understood: `timestamp_timeout=N` (minutes; 0 asks every time, a negative number never forgets) and `authenticate` / `!authenticate`. Any other `Defaults` is reported and ignored.

`#include FILE` (or `@include`) reads another file in its place, and `#includedir DIR` (or `@includedir`) every file in a directory, in sorted order, but for names that end in `~` or have a `.` in them. A relative name is taken from the including file's directory. The default file ends with `@includedir /etc/sudoers.d`, so a rule can be dropped in as a file of its own. An included file must be owned by root and not writable by its group or others; one that is not is left out, with a warning, since whoever can write it could grant themselves anything.

Not supported, and reported on standard error rather than guessed at: the `SETENV:` and `NOEXEC:` tags.

A line ending in a backslash continues on the next. A line that does not parse is skipped.

## See also

`@ecmaos/coreutils/sudo`, `@ecmaos/coreutils/su`
