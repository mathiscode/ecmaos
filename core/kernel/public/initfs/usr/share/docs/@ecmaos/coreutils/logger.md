# logger

`man @ecmaos/coreutils/logger`

## Synopsis

```
logger [-i[ID]] [-s] [-t TAG] [-p PRIORITY] [-k] [-f FILE] [MESSAGE]...
```

## Description

Put messages into the system log. Each goes to `/dev/log`, which the kernel appends to `/var/log/messages` as `Oct 26 14:33:15 host TAG[PID]: message` (within a second). With no `MESSAGE` the lines of standard input, or of `-f FILE`, are logged, one message each. The tag defaults to the user name.

The kernel plays syslogd itself, and there are no Unix datagram sockets here: `/dev/log` is a write-only character device, so the priority (`-p`) is accepted and checked but the file does not record it, there are no per-facility files, and a C program's `syslog()` does not arrive. Anything can write to the device, though: `echo "tag: text" > /dev/log`.

`-k` writes to the kernel log instead, through `/dev/kmsg`, where it joins what `dmesg` shows (an error priority is logged as an error). `/dev/kmsg` cannot be read.

## Options

```
  -i[ID], --id[=ID]    include the process id (or ID) in the tag
  -k, --kernel         write to the kernel log
  -p, --priority PRI   FACILITY.LEVEL (user.notice, daemon.err, local3.info) or a number
  -s, --stderr         also write the message to standard error
  -t, --tag TAG        the tag
  -f, --file FILE      log the lines of FILE
```

A log server (`-n`, `-u`) cannot be named; those options are refused.

## See also

`dmesg`, `cron`, `/var/log/messages`
