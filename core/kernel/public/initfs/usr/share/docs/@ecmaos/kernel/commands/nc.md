# nc

`man @ecmaos/kernel/commands/nc`

## Synopsis

```
nc [OPTIONS] <host> [port]
nc [OPTIONS] -u <url>
nc -g [USER@]GATEWAY[:PORT] [OPTIONS] <host> <port>
```

## Description

Netcat - network utility for reading from and writing to network connections.

Without `-g`, `nc` speaks WebSocket (or WebTransport): it reaches a server that speaks that, not an arbitrary TCP service, because a browser tab has no sockets of its own.

With `-g`, the connection is a plain TCP flow made for you by another ecmaOS machine started with `ecmaos --listen --gateway`. You log in to that machine with your own key (the first time, enrol it with `--pair CODE`), and it connects to host:port and carries the bytes. `nc` ends when the far end does; end of input tells the far end nothing more is coming. What the gateway will reach is the gateway's decision: by default not itself, private networks or metadata addresses, and an operator may allow only some destinations.

## Options

```
Options:
  -u, --url <url>    Direct URL (ws://, wss://, or https://)
  -p, --port <port> Port number (for WebSocket, defaults to 80/443)
  -g, --gateway ADDR Reach host:port (plain TCP) through an ecmaOS machine started with
                     `ecmaos --listen --gateway`, logging in to it with your key
  --pair CODE        with -g: enrol your key with this one-time pairing code first
  -F, --fingerprint FP  with -g: accept the gateway only if its key has this fingerprint
  -y, --accept-new   with -g: remember a gateway seen for the first time without asking
  --help             display this help and exit

Examples:
  nc -g root@box:30022 example.com 80
  nc echo.websocket.org
  nc -p 443 echo.websocket.org
  nc -u wss://echo.websocket.org
  nc -u https://example.com:443
```

## See also

`nc --help`
