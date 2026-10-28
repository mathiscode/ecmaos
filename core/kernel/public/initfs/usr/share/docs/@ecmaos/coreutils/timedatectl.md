# timedatectl

`man @ecmaos/coreutils/timedatectl`

## Synopsis

```
timedatectl [status]
timedatectl set-timezone ZONE
timedatectl list-timezones
timedatectl show [-p NAME] [--value]
```

## Description

Show the clock and the time zone, and set the zone.

The clock is the browser's. Only its host can set it, so `set-time`, `set-ntp` and `set-local-rtc` (to anything but no) are refused, and whether the clock is synchronized is not known here.

The zone is `/etc/timezone`, which the kernel reads at boot. `set-timezone` (root) writes it and gives the kernel's shells the zone's rules as `TZ`, so programs started from then on use the new zone. A login shell started earlier keeps the `TZ` it has: log in again, or `export TZ=ZONE`. `list-timezones` lists every zone the browser's `Intl` knows.

`TZ` holds a POSIX rule, such as `JST-9` or `CST6CDT,M3.2.0/2,M11.1.0/2`, which C programs can read without a zoneinfo database. `date`, `ls`, `stat` and the other JavaScript commands follow `TZ` too, whether it holds a rule or a zone name (`TZ=Asia/Tokyo date`). A date typed in, as to `date -d`, is still read in the browser's zone.

## See also

`date`, `/etc/timezone`
