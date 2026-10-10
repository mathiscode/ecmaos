# dmesg

`man @ecmaos/coreutils/dmesg`

## Synopsis

```
dmesg [-l LEVEL[,LEVEL]...] [-n COUNT]
```

## Description

Print the kernel's log, oldest first. The log is `/var/log/kernel.log`: a time, the level in brackets and the message. Unlike Linux it is a file that persists across boots, so it can be longer than one run.

## Options

```
  -l, --level=LIST  only these levels: silly, trace, debug, info, warn, error, fatal
  -n, --last=COUNT  only the last COUNT lines
  --help            display this help and exit
```

## See also

`uptime`, `who`
