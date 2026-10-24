# lsof

`man @ecmaos/coreutils/lsof`

## Synopsis

```
lsof [-lt] [-p PID1,PID2,...] [NAME...]
```

## Description

Lists the files that processes have open, from toybox 0.8.12: each process's working directory (`cwd`), root (`rtd`), program (`txt`) and descriptors, read from `/proc/<pid>/fd`. `-p` limits the list to the processes named, and a file name limits it to the processes that have that file open. A pipe is shown as `pipe:[N]`, a terminal or device as `CHR`, a directory as `DIR`.

The sockets of a program are pipes underneath, so they show as pipes; `lsof -i` is not supported. `netstat` lists the listening sockets.

## Examples

```
lsof
lsof -p 1
lsof /var/log/messages
```

## See also

`@ecmaos/coreutils/ps`, `@ecmaos/coreutils/netstat`

## License

0BSD. The license text is in `/usr/share/licenses/@ecmaos/coreutils/lsof/`.
