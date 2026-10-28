# journalctl

`man @ecmaos/coreutils/journalctl`

## Synopsis

```
journalctl [OPTIONS] [MATCHES]
```

## Description

Query the system log. There is no binary journal. The entries are the lines of two files, each read with its rotated `.1` before it:

- `/var/log/messages`: what `/dev/log` receives from `logger`, `systemd-cat`, the units' output and init's messages
- `/var/log/kernel.log`: the kernel's own messages, shown with the tag `kernel`

The output pages when it goes to a terminal, unless `-f` is given.

Matching works on what those lines keep:

- the tag: `-t`, or `SYSLOG_IDENTIFIER=`
- the unit: `-u` matches the identifiers the unit logs under and init's messages that name it
- the pid: `_PID=`
- the time, and whether the entry is the kernel's (`-k`)

Neither file records a message's priority, so `-p` knows the priority only of the kernel's entries. Syslog entries count as info (6). Nor do they record a year: an entry is taken as this year's unless that would put it in the future.

`-b` is this boot only, from `btime` in `/proc/stat`. Only the current boot can be named. `--since` and `--until` take a date `date -d` understands, and also `today`, `yesterday`, `now`, and `-1h` or `+30min` forms.

## Options

```
  -u, --unit=UNIT          entries of a unit
  -t, --identifier=ID      entries with a tag
  -k, --dmesg              the kernel's entries, this boot
  -b, --boot               this boot
  -S, --since=DATE         -U, --until=DATE
  -p, --priority=RANGE     emerg..debug or 0..7, or one level and those above it
  -g, --grep=PATTERN       messages matching a regular expression (case-insensitive unless it has a capital)
  -n, --lines[=N]          the last N entries (10)
  -f, --follow             keep printing new entries
  -r, --reverse            newest first
  -o, --output=MODE        short, short-iso, short-precise, short-unix, cat, json, json-pretty
      --utc                times in UTC
      --no-pager, -q, -x, -e, -a
      --disk-usage         the size of the log files
      --list-boots         the one boot there is
```

The vacuum options are accepted and do nothing: the logs rotate on their own at 1 MiB.

## See also

`logger`, `dmesg`, `systemctl`, `systemd-cat`
