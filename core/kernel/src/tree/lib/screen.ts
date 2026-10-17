/**
 * The page that is only a screen of another machine (`?screen=HOST[:PORT]`): it boots no kernel. It logs in to an `ecmaos
 * --listen` machine with a key of its own, opens a `display` channel and draws that machine's windows (`screen-view.ts`).
 * The key is made by the page, kept in IndexedDB where the page cannot read it back, and enrolled with a pairing code the
 * machine prints; the machine's own key is remembered the first time and checked every time after.
 */

import { AuthChannel, clientAuth, Connection, DisplayChannel, MessageStream, publicKeyOf, webSocketTransport } from '@ecmaos/peer'
import type { PublicKey, Transport, WebSocketLike } from '@ecmaos/peer'
import type { ToDisplay, ToKernel } from '@ecmaos/types'

import { WindowServer } from '#windowserver.ts'
import { WinBoxRenderer } from '#windows.ts'
import { ScreenView } from '#lib/screen-view.ts'

export const DefaultPort = 30022

export interface ScreenRequest {
  /** The WebSocket address of the machine */
  url: string
  /** `host:port`: what its key is remembered under */
  id: string
  user: string
}

/** What a page address asks to be a screen of, `undefined` for a normal boot */
export function screenRequest(search: string): ScreenRequest | { error: string } | undefined {
  const params = new URLSearchParams(search)
  const raw = params.get('screen')
  if (raw === null) return undefined
  const tls = /^wss:\/\//.test(raw)
  const match = /^(?:wss?:\/\/)?(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(raw)
  const port = match?.[2] ? Number(match[2]) : DefaultPort
  if (!match || port < 1 || port > 65535) return { error: `'${raw.slice(0, 60)}' is not a machine to show (use HOST or HOST:PORT)` }
  const user = params.get('user') ?? 'root'
  if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/.test(user)) return { error: `'${user.slice(0, 40)}' is not a user name` }
  return { url: `${tls ? 'wss' : 'ws'}://${match[1]}:${port}/ecmaos`, id: `${match[1]}:${port}`, user }
}

// - keys ---------------------------------------------------------------------------------------------

const Algorithm = { name: 'ECDSA', namedCurve: 'P-384' } as const
const Signature = { name: 'ECDSA', hash: 'SHA-384' } as const

export interface Identity {
  publicKey: PublicKey
  sign(data: Uint8Array): Promise<Uint8Array>
}

const idb = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })

/** The page's own key, made on first use. The private half is not extractable: the page can sign with it and cannot read it. */
export async function loadIdentity(factory: IDBFactory = indexedDB): Promise<Identity> {
  const opening = factory.open('ecmaos-screen', 1)
  opening.onupgradeneeded = () => { opening.result.createObjectStore('keys') }
  const db = await idb(opening)
  try {
    let pair = await idb(db.transaction('keys').objectStore('keys').get('identity')) as CryptoKeyPair | undefined
    if (!pair) {
      pair = await crypto.subtle.generateKey(Algorithm, false, ['sign', 'verify'])
      await idb(db.transaction('keys', 'readwrite').objectStore('keys').put(pair, 'identity'))
    }
    const publicKey = publicKeyOf(await crypto.subtle.exportKey('jwk', pair.publicKey))
    if (!publicKey) throw new Error('the page\'s key is not a P-384 key')
    const privateKey = pair.privateKey
    return { publicKey, sign: async data => new Uint8Array(await crypto.subtle.sign(Signature, privateKey, data as BufferSource)) }
  } finally {
    db.close()
  }
}

// - hosts --------------------------------------------------------------------------------------------

const HostsKey = 'ecmaos:screen:hosts'

export function knownHosts(storage: Storage): Record<string, string> {
  try {
    const parsed = JSON.parse(storage.getItem(HostsKey) ?? '{}') as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, string> : {}
  } catch { return {} }
}

export interface ConnectOptions {
  request: ScreenRequest
  identity: Identity
  storage: Storage
  /** The one-time code that enrols the page's key; not given when logging in with a key already enrolled */
  pairingCode?: string
  /** Opens the transport; a WebSocket by default */
  open?: (url: string) => Promise<Transport>
  timeout?: number
}

const openSocket = (url: string) => new Promise<Transport>((resolve, reject) => {
  const socket = new WebSocket(url)
  // wrapped before it opens, so nothing the machine sends first is missed
  const transport = webSocketTransport(socket as unknown as WebSocketLike)
  socket.addEventListener('open', () => resolve(transport), { once: true })
  socket.addEventListener('error', () => reject(new Error(`could not connect to ${url}`)), { once: true })
})

/** A machine this page has not seen before: the handshake is ended and the user is asked, because it waits for nobody for long */
export class UnknownHost extends Error {
  constructor(readonly id: string, readonly fingerprint: string) { super(`${id} is not a known machine (its key is ${fingerprint})`) }
}

/** Remembers the key of a machine the user trusts */
export function rememberHost(storage: Storage, id: string, fingerprint: string) {
  storage.setItem(HostsKey, JSON.stringify({ ...knownHosts(storage), [id]: fingerprint }))
}

/** Connects and logs in; throws with a message ready to show, and a `PeerError` with code `auth` when the key is not enrolled */
export async function connectScreen(options: ConnectOptions): Promise<Connection> {
  const { request, identity, storage } = options
  const transport = await (options.open ?? openSocket)(request.url)
  const connection = new Connection(transport, { role: 'client', meta: { name: 'ecmaos-screen' } })
  try {
    await connection.ready
    const channel = await connection.open(AuthChannel)
    await clientAuth(channel, {
      user: request.user,
      pairingCode: options.pairingCode,
      timeout: options.timeout,
      trust: async (_key, printed) => {
        const hosts = knownHosts(storage)
        const known = hosts[request.id]
        if (known) {
          if (known === printed) return true
          throw new Error(`The key of ${request.id} has changed (now ${printed}, remembered ${known}). Something may be impersonating it, or the machine was reinstalled. Nothing was sent.`)
        }
        throw new UnknownHost(request.id, printed)
      },
      sign: async data => ({ key: identity.publicKey, signature: await identity.sign(data) })
    })
    return connection
  } catch (error) {
    connection.close()
    throw error
  }
}

/** Opens the display channel of a logged-in connection and shows what comes over it */
export async function showWindows(connection: Connection, windows: WindowServer) {
  const channel = await connection.open(DisplayChannel, { timeout: 10_000 })
  const stream = new MessageStream(channel)
  const view = new ScreenView(message => { void stream.send(JSON.parse(JSON.stringify(message satisfies ToKernel))).catch(() => {}) }, windows)
  stream.onMessage = value => { if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array)) view.handle(value as unknown as ToDisplay) }
  return { view, closed: channel.done, close: () => channel.close() }
}

// - page ---------------------------------------------------------------------------------------------

export async function runScreen(request: ScreenRequest | { error: string }) {
  document.body.style.cssText = 'margin:0;background:#101010;color:#e8e8e8;font:15px system-ui,sans-serif;height:100vh;overflow:hidden'
  const overlay = document.createElement('div')
  overlay.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;z-index:2147483646;background:#101010'
  const panel = document.createElement('div')
  panel.style.cssText = 'max-width:34em;padding:24px;display:flex;flex-direction:column;gap:12px'
  overlay.append(panel)
  document.body.append(overlay)

  const say = (text: string, ...controls: HTMLElement[]) => {
    const message = document.createElement('p')
    message.style.cssText = 'margin:0;white-space:pre-wrap;word-break:break-word'
    message.textContent = text
    panel.replaceChildren(message, ...controls)
    overlay.style.display = 'grid'
  }
  const button = (label: string, onclick: () => void) => {
    const element = document.createElement('button')
    element.textContent = label
    element.style.cssText = 'align-self:flex-start;padding:6px 14px;font:inherit'
    element.onclick = onclick
    return element
  }
  const choose = (text: string, yes: string, no: string) => new Promise<boolean>(resolve => say(text, button(yes, () => resolve(true)), button(no, () => resolve(false))))
  const askCode = (text: string) => new Promise<string>(resolve => {
    const input = document.createElement('input')
    input.placeholder = '123-456'
    input.autocomplete = 'off'
    input.style.cssText = 'padding:6px;font:inherit'
    const done = () => { if (input.value.trim()) resolve(input.value.trim()) }
    input.onkeydown = event => { if (event.key === 'Enter') done() }
    say(text, input, button('Pair', done))
    input.focus()
  })

  if ('error' in request) return say(request.error)
  document.title = `ecmaOS - ${request.id}`

  const windows = new WindowServer()
  const renderer = new WinBoxRenderer()
  await renderer.init()
  windows.registerRenderer(renderer)

  const identity = await loadIdentity()
  const connect = async (): Promise<Connection> => {
    const attempt = (pairingCode?: string) => connectScreen({
      request, identity, storage: localStorage, pairingCode
    })
    say(`Connecting to ${request.id}`)
    // a machine seen for the first time is asked about before anything else is said to it, then connected to again
    const withHost = async (pairingCode?: string): Promise<Connection> => {
      try {
        return await attempt(pairingCode)
      } catch (error) {
        if (!(error instanceof UnknownHost)) throw error
        const trusted = await choose(`The authenticity of ${error.id} cannot be established.\nIts key fingerprint is ${error.fingerprint}.\nCompare it with the one the machine printed when it started.`, 'Trust it', 'Cancel')
        if (!trusted) throw new Error('The machine\'s key was not trusted.', { cause: error })
        rememberHost(localStorage, error.id, error.fingerprint)
        say(`Connecting to ${request.id}`)
        return await attempt(pairingCode)
      }
    }
    try {
      return await withHost()
    } catch (error) {
      if ((error as { code?: string }).code !== 'auth') throw error
      // the machine does not know this page's key: it is enrolled with the code the machine printed
      const code = await askCode(`${request.id} does not know this page yet.\nEnter the pairing code its console printed for ${request.user}.`)
      say(`Pairing with ${request.id}`)
      return await withHost(code)
    }
  }

  try {
    const connection = await connect()
    const shown = await showWindows(connection, windows)
    overlay.style.display = 'none'
    await Promise.race([shown.closed, connection.done])
    shown.view.dispose()
    connection.close()
    say(`${request.id} went away.`, button('Reconnect', () => location.reload()))
  } catch (error) {
    say(`${error instanceof Error ? error.message : String(error)}`, button('Try again', () => location.reload()))
  }
}
