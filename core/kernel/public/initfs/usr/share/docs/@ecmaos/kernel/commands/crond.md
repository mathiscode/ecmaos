# crond

`man @ecmaos/kernel/commands/crond`

## Synopsis

```
crond
```

Started automatically from `/boot/init` as a backgrounded process; not normally invoked by hand.

## Description

The real cron daemon: a genuine, long-running `execve`'d worker process with its own pid, startable/killable/visible in `ps` like any other process -- unlike the earlier in-process scheduler it replaced, which held cron jobs as live closures on the main-thread `Kernel` object with no pid and no way to be killed independently.

Scheduling needs no main-thread syscall: `setInterval`/`setTimeout` work natively inside a Web Worker, so `crond` wakes once a minute and matches each crontab entry's expression against `cron-schedule`'s `matchDate()`. Running a job's command line does need a main-thread hop (`shell_exec`), since a crontab entry can be a full shell pipeline (`cmd1 | cmd2`), and there is no standalone `/bin/sh -c` interpreter to spawn a single resolved binary for.

`crond` re-reads `/etc/crontab` and `~/.config/crontab` whenever their mtime changes (checked every tick), so `cron add`/`cron remove`'s plain file edits take effect within a minute with no explicit reload needed.

`crond`'s own startup/failure logging goes through the `klog` custom syscall to `kernel.log`/`/var/log/kernel.log`, not raw stdout -- a backgrounded daemon's routine bookkeeping doesn't resurface in whatever interactive terminal happens to share its session.

## See also

`@ecmaos/kernel/commands/kill`, the `cron` coreutil, `/etc/crontab`
