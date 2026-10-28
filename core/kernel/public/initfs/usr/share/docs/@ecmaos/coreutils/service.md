# service

`man @ecmaos/coreutils/service`

## Synopsis

```
service NAME ACTION [OPTIONS]
service NAME --full-restart
service --status-all
```

## Description

Run a System V init script, as Debian's `service` does. The actions the service manager knows go through `systemctl`, which runs the unit of that name or the script as a unit:

- `start`, `stop`, `restart`, `try-restart` and `condrestart`
- `reload`, `force-reload` and `status`

Any other action runs `/etc/init.d/NAME ACTION` directly, with a clean environment (`PATH`, `TERM` and `LANG` only) and `/` as its directory.

`--status-all` runs each script in `/etc/init.d` with `status` and lists it as running (`[ + ]`), stopped (`[ - ]`) or unknown (`[ ? ]`). The status is read from the script's exit code: 0, 3 or anything else.

## See also

`systemctl`, `/etc/init.d`
