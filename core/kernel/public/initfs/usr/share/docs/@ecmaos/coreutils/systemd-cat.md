# systemd-cat

`man @ecmaos/coreutils/systemd-cat`

## Synopsis

```
systemd-cat [-t IDENT] [-p PRIORITY] [--stderr-priority=PRIORITY] [--level-prefix=BOOL] [COMMAND...]
```

## Description

Run COMMAND with its standard output and standard error connected to the system log. With no COMMAND, the lines of standard input are logged instead. Each line becomes a message on `/dev/log`, as `IDENT[PID]: line`, so it shows in `/var/log/messages` and in `journalctl -t IDENT`. The identifier defaults to the command's name.

A line beginning with `<N>` is logged at level N, unless `--level-prefix=false` is given. The file does not record levels, though.

There is no exec here, so the command runs as a child. `systemd-cat` reads its output through pipes and holds `SIGTERM`, `SIGINT`, `SIGHUP` and `SIGQUIT`, so it can log what the command prints as it stops. It then ends the way the command did: by the same signal, or with the same status. The service manager in `/sbin/init` runs each unit's processes under it, so in `ps` a service appears as `systemd-cat` with its program as the child.

## Options

```
  -t, --identifier=STRING     the tag to log under
  -p, --priority=PRIORITY     the level for standard output (0-7 or a name)
      --stderr-priority=PRI   the level for standard error
      --level-prefix=BOOL     whether to read <N> prefixes
```

## See also

`logger`, `journalctl`, `systemctl`
