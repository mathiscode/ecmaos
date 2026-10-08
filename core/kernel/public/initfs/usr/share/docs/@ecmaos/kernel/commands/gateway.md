# gateway

`man @ecmaos/kernel/commands/gateway`

## Synopsis

```
gateway up [OPTIONS] [USER@]HOST[:PORT]
gateway down
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

A program names the destination by address (`connect()` to a name needs the resolver, which is not there yet), so a program
that resolves a name itself cannot yet use it. The link carries TCP only, and nothing on it is encrypted yet, so use it only
over loopback or a network you trust.

## Options

- `-p`, `--pair CODE`: enrol your key with this one-time pairing code first
- `-F`, `--fingerprint FP`: accept the host only if its key has this fingerprint
- `-y`, `--accept-new`: remember a host seen for the first time

## Examples

```
gateway up -y root@192.168.1.5
gateway
gateway down
```

## See also

`nc` (`-g`), `connect`, `attach`
