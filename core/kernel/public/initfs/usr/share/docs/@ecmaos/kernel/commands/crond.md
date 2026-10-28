# crond

`man @ecmaos/kernel/commands/crond`

## Synopsis

```
crond
crond --run USER COMMAND
crond --help
```

Started automatically from `/boot/init` as a backgrounded process; not normally invoked by hand.

## Description

The real cron daemon: a genuine, long-running `execve`'d worker process with its own pid, startable/killable/visible in `ps` like any other process - unlike the earlier in-process scheduler it replaced, which held cron jobs as live closures on the main-thread `Kernel` object with no pid and no way to be killed independently.

Scheduling needs no main-thread syscall: `setInterval`/`setTimeout` work natively inside a Web Worker, so `crond` wakes once a minute and matches each crontab entry's expression against `cron-schedule`'s `matchDate()`.

A job is run by `/bin/ecmash -c COMMAND`, as real cron runs `sh -c`, so a crontab entry can be a full pipeline (`cmd1 | cmd2`). It has no terminal and its output is dropped (there is no mail); the daemon logs each start, and a non-zero exit, to `kernel.log`.

- `/etc/crontab` is root's, and its jobs run as root.
- Every user in `/etc/passwd` may have a table, `/var/spool/cron/crontabs/USER` (the one `crontab` installs), and also the older `~/.config/crontab` (the one `cron add` writes). Its jobs run as that user, in their home directory, with `HOME`, `USER`, `LOGNAME`, `SHELL` and `PATH` set. A file is ignored unless that user, or root, owns it.
- `@yearly`, `@monthly`, `@weekly`, `@daily` and `@hourly` stand for their schedules. `@reboot` jobs run once a boot, when crond first starts; a marker in `/run`, which boot empties, says they have run.
- Where the installed `@zenfs/core` cannot run programs as a user (see the README's Known gaps), only root's jobs run, since running someone else's as root would hand out root. The startup log line says so.

`crond` re-reads the crontab files whenever their mtime changes (checked every tick), so `cron add`/`cron remove`'s plain file edits take effect within a minute with no explicit reload needed.

`crond` is also atd: every few seconds it looks in `/var/spool/cron/atjobs` for the jobs `at` queued, runs each one that is due as its owner through `systemd-cat -t at` (so what it prints reaches the system log), and removes it.

`crond --run USER COMMAND` runs one job as USER the way the daemon would, waits for it, and exits with its status. It is for trying a job without waiting for its minute. Only root can start a job as someone else.

`crond`'s own startup/failure logging goes through the `klog` custom syscall to `kernel.log`/`/var/log/kernel.log`, not raw stdout - a backgrounded daemon's routine bookkeeping doesn't resurface in whatever interactive terminal happens to share its session.

## See also

`crontab`, `at`, `@ecmaos/kernel/commands/kill`, `cron`, `/etc/crontab`
