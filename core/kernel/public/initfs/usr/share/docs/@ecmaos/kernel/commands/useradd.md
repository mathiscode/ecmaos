# useradd

`man @ecmaos/kernel/commands/useradd`

## Synopsis

```
useradd [OPTION]... LOGIN
```

## Description

Creates a user account. Without `-g` the user gets a new group of their own, named after them; the user ID is the first free one from 1000 (100 to 999 for a system account with `-r`). The account is added to `/etc/passwd`, `/etc/shadow` and `/etc/group`.

## Options

- `-m, --create-home`: create the home directory (`0750`, owned by the user)
- `-d, --home-dir HOME_DIR`: the home directory (default `/home/LOGIN`)
- `-s, --shell SHELL`: the login shell (default `ecmaos`, the shell built into the kernel)
- `-u, --uid UID`: the user ID
- `-g, --gid GROUP`: the primary group, a name or number that exists
- `-G, --groups GROUPS`: supplementary groups, separated by commas
- `-r, --system`: a system account, with no password (a `*` in `/etc/shadow`) unless `-p` is given
- `-p, --password PASSWORD`: the password in plain text

## Notes

Unlike Linux, an account has to have a password, so `useradd` asks for one when there is no `-p`; a system account made with `-r` has none instead. The password goes in `/etc/shadow` with `lastchg` set to today, no minimum age, a maximum of 99999 days and 7 days of warning. No key pair is made: it is created the first time something needs one, in `~/.ssh`. There is no `/etc/skel` to copy into the home directory. Only root may run it.

## Exit status

0 on success, 1 when the account could not be created (it exists, a group does not, the password was refused), 2 for a bad command line, 3 for an invalid ID.

## See also

`@ecmaos/kernel/commands/userdel`, `@ecmaos/kernel/commands/usermod`, `@ecmaos/kernel/commands/groupadd`, `@ecmaos/kernel/commands/passwd`, `@ecmaos/kernel/commands/chage`, `@ecmaos/kernel/commands/user`
