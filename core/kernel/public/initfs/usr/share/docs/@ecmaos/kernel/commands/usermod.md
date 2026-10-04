# usermod

`man @ecmaos/kernel/commands/usermod`

## Synopsis

```
usermod [OPTION]... LOGIN
```

## Description

Changes a user account. A new name is written everywhere the old one was (the account, `/etc/shadow`, and the group named after the user); a new user ID hands the files in the home directory over to it; supplementary groups replace the current ones, or are added to them with `-a`.

## Options

- `-l, --login NEW_LOGIN`: rename the user
- `-u, --uid UID`: a new user ID
- `-g, --gid GROUP`: a new primary group, a name or number that exists
- `-G, --groups GROUPS`: supplementary groups, separated by commas
- `-a, --append`: with `-G`, add to the current groups
- `-d, --home HOME_DIR`: a new home directory
- `-m, --move-home`: with `-d`, move the content of the old home directory
- `-s, --shell SHELL`: a new login shell

## Notes

Locking an account (`-L`, `-U`) is not supported: a password is the only way in, so change it with `passwd`. Files outside the home directory keep the user ID they have. Only root may run it.

## Exit status

0 on success, 1 when the change could not be made, 2 for a bad command line, 3 for an invalid ID.

## See also

`@ecmaos/kernel/commands/useradd`, `@ecmaos/kernel/commands/userdel`, `@ecmaos/kernel/commands/chsh`, `@ecmaos/kernel/commands/passwd`
