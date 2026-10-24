# ping

`man @ecmaos/kernel/commands/ping`

## Synopsis

```
ping [-c COUNT] [-i SECONDS] [-p PORT] HOST
```

## Description

Times a TCP connection to a host. A browser cannot send an ICMP echo, so `ping` does not do what its name says: it resolves the host, connects to a TCP port (443 unless `-p` says otherwise) through the gateway (`gateway up`), closes the connection, and prints how long it took to open. A host that does not listen on that port counts as a failure although it may be up. `localhost` and the other loopback addresses are this machine, and `ping` says so without timing anything.

Exit status is 0 if any connection opened, 1 if none did, and 2 for a bad request or a name that does not resolve.

## Examples

```
ping example.com
ping -c 3 -p 22 192.0.2.7
```

## See also

`@ecmaos/kernel/commands/host`, `@ecmaos/kernel/commands/gateway`
