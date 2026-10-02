# nc

`man @ecmaos/kernel/commands/nc`

## Synopsis

```
nc [OPTIONS] <host> [port]
nc [OPTIONS] -u <url>
```

## Description

Netcat - network utility for reading from and writing to network connections.

## Options

```
Options:
  -u, --url <url>    Direct URL (ws://, wss://, or https://)
  -p, --port <port> Port number (for WebSocket, defaults to 80/443)
  --help             display this help and exit

Examples:
  nc echo.websocket.org
  nc -p 443 echo.websocket.org
  nc -u wss://echo.websocket.org
  nc -u https://example.com:443
```

## See also

`nc --help`
