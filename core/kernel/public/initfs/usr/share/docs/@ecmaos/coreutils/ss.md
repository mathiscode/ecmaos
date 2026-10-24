# ss

`man @ecmaos/coreutils/ss`

## Synopsis

```
ss [-altux46nHp]
```

## Description

Shows sockets, read from `/proc/net/tcp`, `tcp6`, `udp`, `udp6` and `unix`. `-l` lists the ones that are listening, `-a` all of them, and `-t`, `-u` and `-x` choose TCP, UDP and Unix sockets (with one of them chosen the Netid column is left out, as `ss` does). `-4` and `-6` choose a family, and `-H` leaves out the header.

The tables hold the sockets the kernel keeps: TCP sockets listening on this machine, the UDP ports programs have bound, and Unix sockets that have a name. A connection between two programs is a pair of pipes and has no row, and neither has one through the gateway, so without `-l` or `-a` the listing is usually empty. `-p` is accepted, but the program is not shown: a socket is not a descriptor in `/proc`. Filter expressions (`ss state listening`) are not supported.

## Examples

```
ss -ltn
ss -lun
ss -lx
```

## See also

`@ecmaos/coreutils/netstat`, `@ecmaos/coreutils/ip`, `@ecmaos/coreutils/lsof`
