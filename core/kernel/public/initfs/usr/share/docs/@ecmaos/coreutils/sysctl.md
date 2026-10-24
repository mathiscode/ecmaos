# sysctl

`man @ecmaos/coreutils/sysctl`

## Synopsis

```
sysctl [-aAeNnqw] [-p [FILE]] [KEY[=VALUE]...]
```

## Description

Reads and sets kernel parameters, from toybox 0.8.12. A parameter is a file under `/proc/sys` with the slashes written as dots: `kernel.hostname` is `/proc/sys/kernel/hostname`. `-a` lists them all, `-n` prints just the value, and `KEY=VALUE` (or `-w`) sets one that can be written.

What is there: `kernel.ostype`, `osrelease`, `version`, `hostname` and `domainname` (the last two can be set), `kernel.pid_max`, `kernel.cap_last_cap` and `net.ipv4.ip_local_port_range`.

## Examples

```
sysctl -a
sysctl -n kernel.ostype
sysctl -w kernel.hostname=laptop
```

## See also

`@ecmaos/coreutils/hostname`, `@ecmaos/coreutils/uname`

## License

0BSD. The license text is in `/usr/share/licenses/@ecmaos/coreutils/sysctl/`.
