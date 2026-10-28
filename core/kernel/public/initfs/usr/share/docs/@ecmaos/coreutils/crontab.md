# crontab

`man @ecmaos/coreutils/crontab`

## Synopsis

```
crontab [-u USER] FILE
crontab [-u USER] -l | -r [-i] | -e
crontab -T FILE
```

## Description

Install, list, edit or remove the table of jobs `crond` runs for a user. A user's table is `/var/spool/cron/crontabs/USER`, with mode 0600 and owned by the user. `crond` reads it again within a minute of a change.

A table is checked before it is installed, and one with a line cron cannot read is refused, with the line given. Each line is one of these:

- `minute hour day-of-month month day-of-week command`
- `@yearly`, `@monthly`, `@weekly`, `@daily`, `@hourly` or `@reboot`, followed by a command
- a `NAME=value` setting
- a comment

An `@reboot` job runs once a boot, when crond starts. A FILE of `-` is standard input.

`-e` edits a copy you own in `$VISUAL` or `$EDITOR` (else `vi`, `vim`, `nano` or `ed`), as you, and installs it when you are done. If the copy has errors you are asked whether to edit it again.

`crontab` runs with the setuid bit, so the spool can stay root's. `-u` is for root only. When `/etc/cron.allow` exists, only the users it lists may use crontab. Otherwise anyone not listed in `/etc/cron.deny` may. Root always may.

Jobs run in a shell with no terminal, with `HOME`, `USER`, `LOGNAME`, `SHELL` and `PATH` set. There is no mail, so what a job prints is not kept: redirect it, or pipe it to `logger`. The older `~/.config/crontab`, which `cron add` writes, is still read too.

## Options

```
  -u USER  the user whose table it is (root only)
  -l       print the table
  -r       remove the table
  -i       with -r, ask first
  -e       edit the table
  -T FILE  check a file's syntax without installing it
```

## See also

`cron`, `crond`, `at`, `/etc/crontab`
