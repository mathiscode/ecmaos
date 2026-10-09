# gateway

`man @ecmaos/kernel/commands/gateway`

## Synopsis

```
gateway up [OPTIONS] [USER@]HOST[:PORT]
gateway down
gateway expose PORT [HOSTPORT]
gateway unexpose PORT
gateway [status]
```

## Description

A browser tab cannot open a TCP socket. `gateway up` gives this machine a way onto the network anyway: it logs in to another
ecmaOS machine, one started with `ecmaos --listen --gateway`, with your key (like `connect`; it asks for your password to
unlock the key), and keeps the link up. From then on a program's `connect()` to an IPv4 address that is not this machine
goes through that machine, which makes the real connection and carries the bytes back. `nc -g` does the same for one command
without leaving anything up.

Only root can bring the gateway up or down, and it is for the whole machine: every program that connects out uses it. With
no gateway up, such a `connect()` fails with `ENETUNREACH`, as with no route. Connections to 127.0.0.1 and between programs on
this machine never use it.

The machine at the other end decides what is reachable. By default it refuses its own network (its loopback, private ranges,
link-local and metadata addresses) and only lets root use it; its operator can narrow that with allow and deny rules. A
refusal reaches the program as `EACCES`; a destination that does not answer is `ECONNREFUSED`, `EHOSTUNREACH` or
`ETIMEDOUT`, as it would be on Linux. Every connection is logged on that machine.

## Names

A program's `getaddrinfo()` and `gethostbyname()` answer from `/etc/hosts` first (it ships with `localhost`; edit it to add
your own names), then ask the gateway, whose machine resolves with its own resolver. The program then connects to the address
it got, and that is checked again on the way out. The gateway machine does not hand out addresses it would not connect to:
a name that points into its own network (a private range, loopback, a metadata address) is answered as if it did not exist,
unless its operator named that range in an allow rule. With no gateway up, a name that is not in `/etc/hosts` fails with
"Try again", as with no nameserver. Only IPv4 answers are used, so `AF_INET6` lookups find nothing yet.

## UDP

A program's `SOCK_DGRAM` socket works the same way: `connect()` (or the first `sendto()`) to an address beyond this machine
opens a flow to it, the same rules apply, and `send`/`recv`/`read`/`write`/`sendto`/`recvfrom` carry one datagram each, up to
65507 bytes, with their boundaries kept. A UDP socket talks to one peer, fixed by `connect()` or by the first `sendto()`
(`sendto()` to another address fails with `EINVAL`), and hears only from that peer. `bind()` to a port is accepted but nothing
is received for it, and UDP between programs on this machine is not provided (`ECONNREFUSED`). Datagrams are not flow
controlled: when the link or the program cannot keep up they are dropped, as UDP allows.

## Inbound

`gateway expose PORT [HOSTPORT]` asks the gateway machine to open HOSTPORT (default: PORT) and carry every connection to it
back to PORT on this machine, where a program is listening on loopback (an ordinary `bind()`/`listen()`/`accept()`). The
program does not change and does not know. `gateway unexpose PORT` (either number) stops it, and `gateway` lists what is
exposed and how many connections came.

The gateway machine opens nothing unless its operator named ports with `--gateway-listen`, opens them on its own loopback
unless `--gateway-listen-address` says otherwise, and logs every connection. A refusal says so: a port outside its range, a
port already in use, or too many listeners. A connection that arrives with nothing listening on PORT is dropped. Exposing
ends when you stop it, when the link goes down, or when `gateway down` is run. Only root can expose.

Nothing on the link is encrypted yet, so use it only over loopback or a network you trust.

## Options

- `-p`, `--pair CODE`: enrol your key with this one-time pairing code first
- `-F`, `--fingerprint FP`: accept the host only if its key has this fingerprint
- `-y`, `--accept-new`: remember a host seen for the first time

## Examples

```
gateway up -y root@192.168.1.5
gateway
gateway expose 3000 8080
gateway unexpose 8080
gateway down
```

## See also

`nc` (`-g`), `connect`, `attach`
