# gateway

`man @ecmaos/kernel/commands/gateway`

## Synopsis

```
gateway up [OPTIONS] [USER@]HOST[:PORT]
gateway down
gateway expose [-u] PORT [HOSTPORT]
gateway unexpose PORT
gateway [status]
```

## Description

A browser tab cannot open a TCP socket. `gateway up` gives this machine a way onto the network anyway: it logs in to another
ecmaOS machine, one started with `ecmaos --listen --gateway`, with your key (like `connect`; it asks for your password to
unlock the key), and keeps the link up. From then on a program's `connect()` to an IPv4 or IPv6 address that is not this machine
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
"Try again", as with no nameserver. `AF_INET6` and unspecified-family lookups get the AAAA answers too (IPv4 ones come first when no family is asked for).

## UDP

A program's `SOCK_DGRAM` socket works the same way: `connect()` to an address beyond this machine opens a flow to it, the same rules
apply, and `send`/`recv`/`read`/`write`/`sendto`/`recvfrom`/`sendmsg`/`recvmsg` carry one datagram each, up to 65507 bytes, with
their boundaries kept (`sendmsg` gathers its iovecs into one datagram and `recvmsg` scatters one back and names the sender; ancillary
data is not supported). A socket that was `connect()`ed keeps to its peer: `sendto()` to another address fails with `EINVAL`.

A socket that is not connected takes an ephemeral port the first time it sends to an address, as on Linux, and then sends to any number
of peers and hears from each of them; a socket that `bind()`s a loopback port gets the same, from other programs on this machine that
send to that port, from peers outside when the port is exposed with `gateway expose -u`, and from whatever it has sent to. `recvfrom()`
names the sender. An unconnected socket must name the peer each time (`send()` with none is `EDESTADDRREQ`). A destination beyond
this machine goes through the gateway, one flow per destination, so the same rules apply; with no gateway up that send fails with
`ENETUNREACH`. Datagrams are not flow controlled: when the link or the program cannot keep up they are dropped, as UDP allows.

## Inbound

`gateway expose [-u] PORT [HOSTPORT]` asks the gateway machine to open HOSTPORT (default: PORT) and carry every connection to it
back to PORT on this machine, where a program is listening on loopback (an ordinary `bind()`/`listen()`/`accept()`). The
program does not change and does not know. `gateway unexpose PORT` (either number) stops it, and `gateway` lists what is
exposed and how many connections came, and says so when nothing is listening on the port here (connections are dropped, and a program that starts later is picked up). With `-u` the port carries datagrams: what arrives at HOSTPORT over UDP reaches the
program that bound PORT, `recvfrom()` names the real sender, and a reply with `sendto()` goes back to that sender. The gateway
machine answers only a peer that has sent something in the last two minutes, so a guest cannot use an exposed port to send to
arbitrary addresses, and it passes on at most 500 datagrams a second per port.

The gateway machine opens nothing unless its operator named ports with `--gateway-listen`, opens them on its own loopback
unless `--gateway-listen-address` says otherwise, and logs every connection. A refusal says so: a port outside its range, a
port already in use, or too many listeners. A connection that arrives with nothing listening on PORT is dropped. Exposing
ends when you stop it, when the link goes down, or when `gateway down` is run. Only root can expose.

Who may connect is up to the gateway machine's operator: `--gateway-listen-allow` limits it to named addresses or networks (anyone
else is dropped and logged); without it, anyone who can reach the address the port was opened on may connect. `accept()` and
`recvfrom()` report the connecting client's real address and port, IPv4 or IPv6 (`[::1]:5000` is how the gateway names an IPv6 client).

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
gateway expose -u 5300 5353
gateway unexpose 8080
gateway down
```

## See also

`nc` (`-g`), `connect`, `attach`
