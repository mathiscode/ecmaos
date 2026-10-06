# chage

`man @ecmaos/kernel/commands/chage`

## Synopsis

```
chage [OPTION]... LOGIN
chage -l LOGIN
```

## Description

Shows or changes password aging: the `lastchg`, `min`, `max`, `warn`, `inactive` and `expire` fields of the account's `/etc/shadow` line. A day is `YYYY-MM-DD` or a number of days since 1970-01-01, and `-1` clears a field.

The login honours two of them. An account is closed on its `expire` day and after it, to every kind of login. A password that is older than `max` plus `inactive` days closes the account to a password login; with no `inactive` set a password past `max` keeps working, and `warn` is only information. Unlike Linux, nothing forces a new password at login. The message is given only once the password is right, so it cannot be used to find out which names exist.

## Options

- `-l, --list` -- show the aging information
- `-d, --lastday LAST_DAY` -- the day the password was last changed
- `-m, --mindays MIN_DAYS` -- fewest days between password changes
- `-M, --maxdays MAX_DAYS` -- most days a password stays valid (99999 is never)
- `-W, --warndays WARN_DAYS` -- days of warning before it expires
- `-I, --inactive INACTIVE` -- days after it expires before the account is disabled
- `-E, --expiredate EXPIRE` -- the day the account expires
- `--help` -- display usage and exit

## Notes

Only root may run it, `-l` included. `passwd -l` locks a password; `chage -E` closes the account whatever way it logs in.

## Exit status

0 on success, 1 for a bad value or an unknown user, 2 for a bad command line.

## See also

`@ecmaos/kernel/commands/passwd`, `@ecmaos/kernel/commands/useradd`, `@ecmaos/kernel/commands/usermod`
