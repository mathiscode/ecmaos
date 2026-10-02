# screensaver-daemon

`man @ecmaos/kernel/commands/screensaver-daemon`

## Synopsis

```
screensaver-daemon
```

## Description

Start the idle-timeout screensaver daemon: shows the configured screensaver (the "screensaver" storage setting, default 'matrix') after a period of no user activity (the "screensaver-timeout" storage setting in ms, default 60000).

## Options

```
  --help  display this help and exit

This registers global activity listeners and returns immediately -- there is
no per-process "daemon" to keep alive here.
```

## See also

`screensaver-daemon --help`
