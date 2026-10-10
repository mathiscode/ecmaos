# notify-send

`man @ecmaos/kernel/commands/notify-send`

## Synopsis

```
notify-send [OPTION...] SUMMARY [BODY]
```

## Description

Show a notification through the browser. The first time, the browser asks the user for permission; if it is blocked, `notify-send` says so and exits 1. The browser decides how long a notification stays and how urgent it looks, so `-u` and `-t` are accepted for scripts written for Linux and have no effect.

## Options

```
  -a, --app-name=NAME   the sending application (shown with the summary when set)
  -i, --icon=URL        an icon to show
  -u, --urgency=LEVEL   low, normal or critical (accepted and ignored)
  -t, --expire-time=MS  accepted and ignored
  -h, -c, -e, -r        accepted and ignored
  --help                display this help and exit
```

## Example

```
sleep 60; notify-send "Timer" "The tea is ready"
```

## See also

`say`, `xclip`
