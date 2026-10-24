# netstat

`man @ecmaos/coreutils/netstat`

## Synopsis

```
netstat [-pWrxwutneal]
```

## Description

Lists sockets, from toybox 0.8.12, read from `/proc/net/tcp`, `tcp6`, `udp`, `udp6` and `unix`. `-l` lists only the listening sockets, `-t`, `-u` and `-x` choose TCP, UDP and Unix sockets, `-n` keeps addresses numeric, and `-a` lists all of them.

The tables hold the sockets the kernel keeps: a TCP socket that is listening on this machine, the UDP ports bound by programs, and the Unix sockets that have a name. A connection between two programs on this machine is a pair of pipes and has no row, nor has one through the gateway. `-p` cannot name the program, since a socket is not a file descriptor to `/proc`. `-r` prints the routing table, which is empty.

## Examples

```
netstat -ltn
netstat -lx
```

## See also

`@ecmaos/coreutils/lsof`, `@ecmaos/coreutils/ps`

## License

0BSD. The license text is in `/usr/share/licenses/@ecmaos/coreutils/netstat/`.
