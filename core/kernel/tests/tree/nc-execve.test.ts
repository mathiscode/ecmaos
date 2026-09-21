import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/**
 * A stand-in WebSocket: an echo server that opens on the next microtask, records what it was sent,
 * and can be told to refuse the connection or to close itself. `kernel.sockets.createWebSocket` runs
 * for real on top of it, so the whole path (registry entry, streams, pipe fds, `poll`) is exercised.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  readyState = 0
  binaryType = 'blob'
  protocol = ''
  extensions = ''
  sent: string[] = []
  onopen: (() => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: ArrayBuffer | string }) => void) | null = null
  onclose: ((event: { code: number, reason: string }) => void) | null = null

  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
    queueMicrotask(() => {
      if (url.includes('refuse')) {
        this.readyState = 3
        this.onerror?.({})
        return
      }
      this.readyState = 1
      this.onopen?.()
    })
  }

  send(data: Uint8Array | string) {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
    this.sent.push(text)
    const echo = new TextEncoder().encode(`echo:${text}`)
    queueMicrotask(() => this.onmessage?.({ data: echo.buffer as ArrayBuffer }))
  }

  /** The server pushes a message. */
  push(text: string) {
    this.onmessage?.({ data: new TextEncoder().encode(text).buffer as ArrayBuffer })
  }

  close(code = 1000, reason = '') {
    if (this.readyState === 3) return
    this.readyState = 3
    queueMicrotask(() => this.onclose?.({ code, reason }))
  }
}

describe('nc: a real execve program with the socket as file descriptors', () => {
  let kernel: Kernel
  const realWebSocket = globalThis.WebSocket
  const type = (data: string) => kernel.terminal.input(data, true)
  const last = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!

  beforeAll(async () => {
    ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket

    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()

    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
    ;(kernel.terminal as unknown as { _isMobile: boolean })._isMobile = false // see tty-input.test.ts
  })

  afterAll(() => {
    ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = realWebSocket
  })

  it('validates its arguments before connecting', async () => {
    const run = async (command: string) => {
      const code = await kernel.shell.execute(`${command} 2> /tmp/nc.err`)
      return { code, err: await kernel.filesystem.fs.readFile('/tmp/nc.err', 'utf8') }
    }
    expect(await run('nc')).toEqual({ code: 1, err: 'nc: missing host or URL argument\nTry "nc --help" for more information.\n' })
    expect(await run('nc -p')).toEqual({ code: 1, err: 'nc: invalid arguments\nTry "nc --help" for more information.\n' })
    expect((await run('nc -u http://example.com')).err).toBe('nc: unsupported URL scheme. Use ws://, wss://, or https://\n')
    expect((await run('nc --help')).err).toContain('Usage: nc [OPTIONS] <host> [port]')
  })

  it('reports a refused connection and exits 1', async () => {
    const code = await kernel.shell.execute('nc -u ws://refuse.example > /tmp/nc.out 2> /tmp/nc.err')
    expect(code).toBe(1)
    expect(await kernel.filesystem.fs.readFile('/tmp/nc.err', 'utf8')).toBe('Failed to create WebSocket: WebSocket connection failed: ws://refuse.example\n')
  })

  it('sends what is typed a line at a time and prints what comes back; ^D ends the session', async () => {
    const done = kernel.shell.execute('nc -u ws://echo.example > /tmp/nc-tty.out')
    await waitFor(() => FakeWebSocket.instances.some(ws => ws.url === 'ws://echo.example' && ws.readyState === 1))
    await waitFor(() => kernel.terminal.ttyInputAttached)
    const ws = last()

    // while connected it is a registry entry, like any `sockets create`
    expect([...(kernel.sockets as unknown as { _connections: Map<string, unknown> })._connections.values()].length).toBeGreaterThan(0)

    type('hello\r')
    await waitFor(() => ws.sent.includes('hello\n'))
    ws.push('server says hi\n')
    await waitFor(() => ws.readyState === 1) // still open: a pushed message is not a close

    type('\x04') // ^D: end of input
    expect(await done).toBe(0)
    expect(ws.readyState).toBe(3)
    const output = await kernel.filesystem.fs.readFile('/tmp/nc-tty.out', 'utf8')
    expect(output).toBe('echo:hello\nserver says hi\n')
    expect(kernel.terminal.ttyInputAttached).toBe(false)
  })

  it('a peer that closes normally ends nc with status 0 and drops the registry entry', async () => {
    const done = kernel.shell.execute('nc echo2.example 8080 > /tmp/nc-peer.out')
    await waitFor(() => FakeWebSocket.instances.some(ws => ws.url === 'ws://echo2.example:8080' && ws.readyState === 1))
    const ws = last()
    ws.push('bye\n')
    ws.close(1000, 'done')

    expect(await done).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/nc-peer.out', 'utf8')).toBe('bye\n')
    expect([...(kernel.sockets as unknown as { _connections: Map<string, { url: string }> })._connections.values()].some(c => c.url.includes('echo2'))).toBe(false)
  })

  it('an abnormal close with a reason is reported and exits 1', async () => {
    const done = kernel.shell.execute('nc -u ws://echo3.example > /tmp/nc-bad.out 2> /tmp/nc-bad.err')
    await waitFor(() => FakeWebSocket.instances.some(ws => ws.url === 'ws://echo3.example' && ws.readyState === 1))
    last().close(4000, 'go away')

    expect(await done).toBe(1)
    expect(await kernel.filesystem.fs.readFile('/tmp/nc-bad.err', 'utf8')).toBe('Connection closed: go away\n')
  })

  it('^C kills nc and closes the socket with it', async () => {
    const done = kernel.shell.execute('nc -u ws://echo4.example > /tmp/nc-int.out')
    await waitFor(() => FakeWebSocket.instances.some(ws => ws.url === 'ws://echo4.example' && ws.readyState === 1))
    await waitFor(() => kernel.terminal.ttyInputAttached)
    const ws = last()

    type('\x03')
    expect(await done).toBe(130)
    await waitFor(() => ws.readyState === 3)
    expect(kernel.terminal.ttyInputAttached).toBe(false)
  })

  it('piped input is sent, and end of input closes the connection', async () => {
    const done = kernel.shell.execute('echo piped | nc -u ws://echo5.example > /tmp/nc-pipe.out')
    await waitFor(() => FakeWebSocket.instances.some(ws => ws.url === 'ws://echo5.example'))
    const ws = last()

    expect(await done).toBe(0)
    expect(ws.sent).toEqual(['piped\n'])
    expect(ws.readyState).toBe(3)
  })
})
