# userdel

`man @ecmaos/kernel/commands/userdel`

## Synopsis

```
userdel [OPTION]... LOGIN
```

## Description

Deletes a user account from `/etc/passwd`, `/etc/shadow` and `/etc/group`. The group named after the user goes too, unless somebody else is in it. It refuses while the user has processes running, and never deletes root.

## Options

- `-r, --remove`: also remove the home directory
- `-f, --force`: remove the account even when it has processes running

## Notes

Without `-r` the home directory is left behind, as on Linux. Only root may run it.

## Exit status

0 on success, 1 when the account could not be removed, 2 for a bad command line.

## See also

`@ecmaos/kernel/commands/useradd`, `@ecmaos/kernel/commands/usermod`
