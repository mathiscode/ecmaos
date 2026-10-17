import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'

import type { ToDisplay, ToKernel, WindowId } from '@ecmaos/types'

import { displayPage } from './page.ts'

/** A display session's side of the conversation: what the page sent, and the page going away */
export interface SessionHandlers {
  message(message: ToKernel): void
  /** The page's socket closed (the host window was closed, or the browser died) */
  disconnect(): void
}

export interface DisplaySession {
  /** Where the host window loads from; the one-time token is in the fragment, so it never reaches a log or a `Referer` */
  readonly url: string
  /** Sends now when the page is connected, else when it connects */
  send(message: ToDisplay): void
  /** Ends the session and its socket; `disconnect` is not called */
  close(): void
}

const tokenMatches = (known: string, given: string) => {
  const a = Buffer.from(known)
  const b = Buffer.from(given)
  return a.length === b.length && timingSafeEqual(a, b)
}

interface Entry {
  id: WindowId
  token: string
  handlers: SessionHandlers
  socket?: WebSocket
  queue: ToDisplay[]
  closed: boolean
}

/**
 * Serves the display page and its WebSocket on a loopback port. A session is one host window: it has a token that is
 * valid for one connection, and a socket bound to it carries only that window's messages. A page that cannot name a
 * live token gets nothing, so another local program (or a web page that reaches the port) cannot drive the windows.
 */
export class DisplayServer {
  private readonly _entries = new Set<Entry>()
  private readonly _http: Server
  private readonly _sockets: WebSocketServer
  private _origin = ''

  private constructor(private readonly _onIdle?: () => void) {
    this._http = createServer((req, res) => this._serve(req, res))
    this._sockets = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 })
    this._http.on('upgrade', (req, socket, head) => {
      if (req.url !== '/ws' || !this._trusted(req) || req.headers.origin !== this._origin) { socket.destroy(); return }
      this._sockets.handleUpgrade(req, socket, head, ws => this._accept(ws))
    })
  }

  static async start(onIdle?: () => void): Promise<DisplayServer> {
    const server = new DisplayServer(onIdle)
    await new Promise<void>((resolve, reject) => {
      server._http.once('error', reject)
      server._http.listen(0, '127.0.0.1', resolve)
    })
    server._origin = `http://127.0.0.1:${(server._http.address() as AddressInfo).port}`
    server._http.unref()
    return server
  }

  get origin() { return this._origin }

  /** How many sessions are open */
  get sessions() { return this._entries.size }

  open(id: WindowId, handlers: SessionHandlers): DisplaySession {
    const entry: Entry = { id, token: randomBytes(24).toString('hex'), handlers, queue: [], closed: false }
    this._entries.add(entry)
    return {
      url: `${this._origin}/#${entry.token}`,
      send: message => {
        if (entry.closed) return
        if (entry.socket) entry.socket.send(JSON.stringify(message))
        else {
          // a frame of pixels replaces the one still waiting for the page: nobody sees the older one
          if (message.t === 'content' && 'pixels' in message.content) entry.queue = entry.queue.filter(queued => !(queued.t === 'content' && 'pixels' in queued.content))
          entry.queue.push(message)
        }
      },
      close: () => this._end(entry, false)
    }
  }

  async close(): Promise<void> {
    for (const entry of [...this._entries]) this._end(entry, false)
    for (const client of this._sockets.clients) client.terminate()
    this._sockets.close()
    await new Promise<void>(resolve => { this._http.close(() => resolve()); this._http.closeAllConnections() })
  }

  /** Only a request addressed to the loopback name and port is served: a rebound DNS name carries another `Host` */
  private _trusted(req: IncomingMessage) {
    return req.headers.host === this._origin.slice('http://'.length)
  }

  private _serve(req: IncomingMessage, res: import('node:http').ServerResponse) {
    if (!this._trusted(req)) { res.writeHead(421).end(); return }
    const path = (req.url ?? '/').split('?')[0]
    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': `base-uri 'none'; form-action 'none'; frame-ancestors 'none'; connect-src ws://${this._origin.slice('http://'.length)}`
      }).end(displayPage)
    } else if (path === '/favicon.ico') res.writeHead(204).end()
    else res.writeHead(404).end()
  }

  private _accept(socket: WebSocket) {
    let entry: Entry | undefined
    const timer = setTimeout(() => socket.close(1008, 'no hello'), 5000)
    socket.on('message', (data, binary) => {
      if (binary) { socket.close(1003, 'text only'); return }
      let message: ToKernel
      try { message = JSON.parse(data.toString()) as ToKernel } catch { socket.close(1003, 'not json'); return }
      if (!entry) {
        const given = message?.t === 'hello' && typeof message.token === 'string' ? message.token : ''
        const match = [...this._entries].find(candidate => !candidate.socket && !candidate.closed && tokenMatches(candidate.token, given))
        if (!match) { socket.close(1008, 'bad token'); return }
        clearTimeout(timer)
        entry = match
        entry.socket = socket
        // the token is spent: another connection with it is refused
        entry.token = randomBytes(24).toString('hex')
        socket.send(JSON.stringify({ t: 'ready' } satisfies ToDisplay))
        for (const queued of entry.queue.splice(0)) socket.send(JSON.stringify(queued))
        return
      }
      // a page speaks only for its own window
      if ('id' in message && message.id !== entry.id) return
      entry.handlers.message(message)
    })
    socket.on('close', () => {
      clearTimeout(timer)
      if (entry && entry.socket === socket) this._end(entry, true)
    })
    socket.on('error', () => socket.terminate())
  }

  private _end(entry: Entry, notify: boolean) {
    if (entry.closed) return
    entry.closed = true
    this._entries.delete(entry)
    entry.socket?.close(1000)
    if (notify) entry.handlers.disconnect()
    if (this._entries.size === 0) this._onIdle?.()
  }
}
