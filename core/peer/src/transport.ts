/**
 * A message-oriented, ordered, reliable link: one `send` is one `onMessage` on the other side (a WebSocket, a
 * `MessagePort`, a pair of in-memory queues). The connection layers frames, channels and flow control on top.
 */
export interface Transport {
  send(data: Uint8Array): void
  /** Set by the connection */
  onMessage: ((data: Uint8Array) => void) | undefined
  /** Set by the connection; called once when the link ends, with the reason if there was one */
  onClose: ((error?: Error) => void) | undefined
  close(): void
}

/** The part of a `WebSocket` the adapter uses (browsers, Node's global, and `ws` all fit) */
export interface WebSocketLike {
  binaryType: string
  readyState: number
  send(data: Uint8Array): void
  close(): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  addEventListener(type: 'close', listener: () => void): void
  addEventListener(type: 'error', listener: () => void): void
}

/**
 * Wraps a WebSocket as a transport. Wrap it as soon as it is made, before it opens: messages that arrive before the
 * connection sets `onMessage` are held and delivered in order when it does. Text messages are not part of the protocol and end the link.
 */
export function webSocketTransport(socket: WebSocketLike): Transport {
  socket.binaryType = 'arraybuffer'
  const held: Uint8Array[] = []
  let handler: ((data: Uint8Array) => void) | undefined
  let heldEnd: { error?: Error } | undefined
  let closeHandler: ((error?: Error) => void) | undefined
  const transport: Transport = {
    get onMessage() { return handler },
    set onMessage(fn) { handler = fn; if (fn) for (const data of held.splice(0)) fn(data) },
    get onClose() { return closeHandler },
    set onClose(fn) { closeHandler = fn; if (fn && heldEnd) { const { error } = heldEnd; heldEnd = undefined; fn(error) } },
    send: data => socket.send(data),
    close: () => socket.close()
  }
  let closed = false
  const end = (error?: Error) => {
    if (closed) return
    closed = true
    if (closeHandler) closeHandler(error)
    else heldEnd = { error }
  }
  const deliver = (data: Uint8Array) => { if (handler) handler(data); else held.push(data) }
  socket.addEventListener('message', event => {
    const { data } = event
    if (data instanceof ArrayBuffer) deliver(new Uint8Array(data))
    else if (ArrayBuffer.isView(data)) deliver(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
    else { end(new Error('text frame on a binary link')); socket.close() }
  })
  socket.addEventListener('close', () => end())
  socket.addEventListener('error', () => end(new Error('socket error')))
  return transport
}
