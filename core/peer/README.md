# @ecmaos/peer

The wire protocol ecmaOS kernels speak to each other (a browser to a Node host, or two hosts). Isomorphic: it uses only
typed arrays, `TextEncoder` and timers, so the same code runs in a browser, a worker and Node.

It is the transport layer only. It carries bytes and values; what a channel is for (a terminal, files, a device) and who
may open one is decided by the layers above, which register a handler per channel kind.

## Pieces

- **Codec** (`encodeValue`, `decodeValue`): a tagged binary format for null, booleans, integers (zigzag varints), floats,
  strings, raw bytes, arrays and maps. Payloads travel as bytes, with no base64 and no text round trip. Decoding is
  bounds-checked: truncated or lying input is a `protocol` error, never a crash or a huge allocation; maps have no
  prototype; nesting is limited.
- **Transport**: an ordered, reliable, message-oriented link. `webSocketTransport` wraps a WebSocket, `memoryPair` gives two
  linked in-memory ends for tests and for two peers in one process.
- **Connection**: the `hello` handshake (a version range and free-form `meta`), ids, ping and keepalive, and
  channels. Either side may open channels (the client uses odd ids, the server even).
- **Channel**: an ordered byte stream plus control messages. Bytes are flow controlled with a credit window per direction:
  a writer waits for credit, a reader returns it as it consumes (automatically after `onData`, or with `grant` when
  `manualCredit` is set, so a reader that buffers on its own, such as a device's read queue, paces the writer by what has
  actually been read). A peer that sends past its credit is cut off.

```ts
import { Connection, webSocketTransport } from '@ecmaos/peer'

const connection = new Connection(webSocketTransport(socket), { role: 'client', meta: { name: 'browser' } })
const files = await connection.open('fs', { params: { path: '/home' } })
files.onData = bytes => { /* ... */ }
await files.write(new Uint8Array([1, 2, 3]))

connection.accept('tty', channel => { /* throw to refuse; the other side sees why */ })
```

## Errors

`PeerError` has a `code`: `version`, `protocol`, `limit`, `unsupported`, `refused`, `auth`, `timeout`, `closed`,
`internal`. Codes cross the wire when a channel or connection is closed with a reason.

## Versioning

`ProtocolMin` to `ProtocolMax` is the range this build speaks; the highest version both sides speak is used, and no
overlap fails the handshake with `version`.
