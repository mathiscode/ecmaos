# systemctl

`man @ecmaos/coreutils/systemctl`

## Synopsis

```
systemctl [OPTIONS] [COMMAND] [UNIT...]
```

## Description

Control the service manager. `/sbin/init` is both the SysV-style init that runs `/etc/inittab` and a service manager for systemd `.service` units.

**Where units come from.**

- `/etc/systemd/system` holds the administrator's units, and `/lib/systemd/system` holds the ones that packages ship. When both have a unit of the same name, `/etc` wins.
- Drop-ins in `NAME.service.d/*.conf` are read after the unit's file.
- Each executable script in `/etc/init.d` becomes `NAME.service`, the way systemd's sysv-generator makes them. Such a unit is started with `SCRIPT start` and stopped with `SCRIPT stop`, and counts as active once it has started.

**At boot**, init starts these units, ordered by `After=` and `Before=`:

- the units linked from `multi-user.target.wants` and `graphical.target.wants`, or the target `systemctl set-default` named
- the SysV scripts with `S` links in `/etc/rc3.d`, or in the runlevel's directory when inittab sets one

At shutdown it stops every unit, the last one started first.

**Unit settings**

- `[Unit]`: `Description=`, `Documentation=`, `After=`, `Before=`, `Wants=`, `Requires=`
- `[Service]`:
  - `Type=`: `simple`, `exec`, `oneshot` or `forking`. `notify` is taken as `simple`, since there is no notify socket.
  - `ExecStart=`, `ExecStartPre=`, `ExecStartPost=`, `ExecStop=`, `ExecStopPost=`, `ExecReload=`. A `-` prefix ignores a failure.
  - `Restart=`, all of its values, and `RestartSec=`
  - `TimeoutStopSec=`, `KillSignal=`, `RemainAfterExit=`
  - `User=`, `Group=`, `WorkingDirectory=`, `Environment=`, `EnvironmentFile=`
  - `PIDFile=`, `SyslogIdentifier=`, `StandardOutput=journal|null|inherit`
- `[Install]`: `WantedBy=`, `RequiredBy=`, `Alias=`

A unit that starts more than five times in ten seconds fails with `start-limit-hit`, as with systemd's defaults.

**How it works here**

- Each unit's processes start in a process group of their own, which stands in for its control group. Stopping a unit sends `KillSignal=` to the group, then `SIGKILL` once `TimeoutStopSec=` has passed (10 seconds by default).
- Output goes to the system log through `systemd-cat`, so `journalctl -u UNIT` shows it, along with init's own messages about the unit.
- `start`, `stop`, `restart`, `reload`, `kill`, `reset-failed` and `daemon-reload` are requests to init and need root. So do `enable`, `disable`, `mask`, `unmask`, `edit` and `set-default`, which make the links themselves.
- A SysV script is enabled with `S01` links in `rc2.d` to `rc5.d`, and `K01` links in the others, as `update-rc.d` makes them.
- `status` reads `/proc` for the main process and the group, and shows the unit's last 10 lines of log.
- Init reads unit files again on every request, so `daemon-reload` is accepted but rarely needed.
- There are no timers, sockets, paths, mounts or user managers.

## Commands

```
  list-units [PATTERN...]      the units that are active (--all: all loaded), and the targets
  list-unit-files [PATTERN...] every unit file and whether it is enabled
  status [UNIT...]             a unit's state, processes and recent log; with none, the system's
  show [UNIT...]               properties (-p NAME, --value)
  cat UNIT...                  the unit's file and drop-ins
  start | stop | restart | try-restart | reload | reload-or-restart UNIT...
  kill [-s SIGNAL] UNIT...     signal the unit's processes
  is-active | is-failed | is-enabled UNIT...
  enable | disable | reenable [--now] UNIT...
  mask | unmask UNIT...
  edit [--full] UNIT...        edit a drop-in (or, with --full, the whole file) and reload
  reset-failed [UNIT...]
  daemon-reload
  get-default | set-default TARGET
  is-system-running
  list-timers                  (there are none)
  poweroff | reboot | halt
```

## Options

```
  -a, --all             all units, or all properties
  -t, --type=TYPE       service or target
      --state=STATE     units in this state; --failed is --state=failed
  -p, --property=NAME   the properties to show; -P NAME is --value -p NAME
      --value           only the values
  -q, --quiet           no output, only the exit status
  -n, --lines=N         log lines in status (10)
  -s, --signal=SIGNAL   the signal for kill
      --now             start or stop the units too
  -l, --full            do not shorten command lines
      --no-pager, --no-legend
```

## Exit status

`is-active` returns 0 for an active unit and 3 otherwise. `status` returns 3 for a unit that is not active, and 4 for one that does not exist. A command refused for want of root returns 4.

## See also

`service`, `journalctl`, `systemd-cat`, `init`, `telinit`
