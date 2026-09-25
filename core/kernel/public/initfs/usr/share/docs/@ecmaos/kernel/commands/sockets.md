# sockets

`man @ecmaos/kernel/commands/sockets`

## Synopsis

```
sockets [subcommand] [args...]
```

## Description

Manages WebSocket/WebTransport connections through `kernel.sockets`, the main-thread socket manager. This is the command-line surface over the same manager `nc` and the main-thread-only real-network path use.

## Address family behavior

ecmaOS has two genuinely different socket mechanisms, and it matters which one a given call goes through:

- **Real POSIX `socket()`/`bind()`/`listen()`/`connect()`/`accept()`**, implemented natively in the worker (`core/kernel/src/tree/lib/main-thread-syscalls.ts`). Only `AF_UNIX` and **loopback** `AF_INET`/`AF_INET6` are accepted -- anything that resolves to a non-loopback address is rejected with `-EAFNOSUPPORT`. This is real inter-process communication between ecmaOS processes (one process listens, another connects, real bytes flow), but it never leaves the browser tab.
- **External connectivity**, via `nc` or the `sockets_connect` main-thread custom syscall. Both create a real `WebSocket` (or `WebTransport`) connection on the main thread -- the only way a browser page can reach a real external address -- and bridge it to a worker-hosted process's stdio. This means external "sockets" in ecmaOS are always WebSocket-shaped on the wire, not raw TCP/UDP; a plain `AF_INET` `connect()` to a non-loopback address will not work, by design, because browsers don't expose raw sockets to a page at all.

In short: process-to-process on this machine → real POSIX sockets, loopback only. Anything that needs to leave the tab → `nc`/`sockets_connect` over WebSocket.

## See also

`nc`, `@ecmaos/kernel/commands/ps`, the root README's Sockets and Known gaps sections
