# hwclock

`man @ecmaos/coreutils/hwclock`

## Synopsis

```
hwclock [-rswtlu] [-f FILE]
```

## Description

Reads the real-time clock, from toybox 0.8.12. The clock is `/dev/rtc0` (`/dev/rtc` is a link to it), and it is the browser's clock, kept in UTC. `-r` (the default) prints its time; `-f` reads another device. `-u` and `-l` say whether the clock is in UTC or local time.

The clock cannot be set, so `-w` (`--systohc`) fails with "Invalid argument" as root and "Permission denied" for anyone else, and `-s` (`--hctosys`) is refused like any other change to the system clock. The system clock is already this one.

## Examples

```
hwclock
hwclock -r -f /dev/rtc
cat /sys/class/rtc/rtc0/date /sys/class/rtc/rtc0/time
```

## License

0BSD. The license text is in `/usr/share/licenses/@ecmaos/coreutils/hwclock/`.
