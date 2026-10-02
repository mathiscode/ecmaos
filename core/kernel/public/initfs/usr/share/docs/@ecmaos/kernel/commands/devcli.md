# devcli

`man @ecmaos/kernel/commands/devcli`

## Synopsis

```
devcli <device> [args...]
```

## Description

The process behind a device's command line, for example `/dev/battery status`. The device's own command runs on the main thread, because the hardware APIs it drives exist only there, and its output is copied to standard output, so pipes and redirections work. The exit status is the status the device command returns.

Which arguments a device accepts is up to the device; run it with `--help` or see its package.

## Exit status

2 when no device is named, 1 when the device cannot be started, otherwise the device's own status.
