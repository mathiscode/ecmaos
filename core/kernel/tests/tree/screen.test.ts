import { describe, expect, it } from 'vitest'
import { AuthChannel, Connection, fingerprint, generateKeyPair, memoryPair, publicKeyOf, serverAuth, sign } from '@ecmaos/peer'
import type { KeyPair, MemoryTransport, PublicKey, Transport } from '@ecmaos/peer'

import { connectScreen, knownHosts, rememberHost, screenRequest, UnknownHost } from '#lib/screen.ts'
import type { Identity, ScreenRequest } from '#lib/screen.ts'

describe('screenRequest', () => {
  it('is not a screen without ?screen', () => {
    expect(screenRequest('')).toBeUndefined()
    expect(screenRequest('?display=1')).toBeUndefined()
  })

  it('reads the machine and the user', () => {
    expect(screenRequest('?screen=localhost')).toEqual({ url: 'ws://localhost:30022/ecmaos', id: 'localhost:30022', user: 'root' })
    expect(screenRequest('?screen=127.0.0.1:4000&user=alice')).toEqual({ url: 'ws://127.0.0.1:4000/ecmaos', id: '127.0.0.1:4000', user: 'alice' })
    expect(screenRequest('?screen=wss://box.example.com')).toMatchObject({ url: 'wss://box.example.com:30022/ecmaos' })
    expect(screenRequest('?screen=[::1]:5000')).toMatchObject({ url: 'ws://[::1]:5000/ecmaos' })
  })

  it('refuses what is not a host and port, or a user name', () => {
    for (const bad of ['?screen=', '?screen=a b', '?screen=host:0', '?screen=host:99999', '?screen=javascript:alert(1)', '?screen=host/path', '?screen=host&user=a%20b', '?screen=host&user=']) {
      expect(screenRequest(bad), bad).toMatchObject({ error: expect.any(String) })
    }
  })
})

/** Holds what arrives before the page has attached its handler, as a WebSocket the page wraps before it opens does */
function held(transport: MemoryTransport): Transport {
  const queue: Uint8Array[] = []
  let handler: ((data: Uint8Array) => void) | undefined
  transport.onMessage = data => { if (handler) handler(data); else queue.push(data) }
  return {
    send: data => transport.send(data),
    close: () => transport.close(),
    get onMessage() { return handler },
    set onMessage(next) { handler = next; if (next) for (const data of queue.splice(0)) next(data) },
    get onClose() { return transport.onClose },
    set onClose(next) { transport.onClose = next }
  }
}

/** A fake machine on the other end of memory transport: the host key, the keys it authorizes, and the pairing code it prints */
function machine(options: { authorized?: PublicKey[], code?: string, hostKey?: KeyPair } = {}) {
  const authorized = [...(options.authorized ?? [])]
  const hosting = options.hostKey ? Promise.resolve(options.hostKey) : generateKeyPair()
  let hostKey!: KeyPair
  const open = async () => {
    hostKey ??= await hosting
    const [a, b] = memoryPair()
    const server = new Connection(b, { role: 'server' })
    server.accept(AuthChannel, channel => {
      void serverAuth(channel, {
        hostKey, authorizedKeys: async user => user === 'root' ? authorized : undefined, timeout: 1000,
        pair: async (_user, code, key) => { if (code !== options.code) return false; authorized.push(key); return true }
      }).catch(() => {})
    })
    return held(a)
  }
  return { open, authorized, hostKey: async () => { hostKey ??= await hosting; return hostKey } }
}

async function identity(): Promise<Identity & { pair: KeyPair }> {
  const pair = await generateKeyPair()
  return { pair, publicKey: pair.publicKey, sign: data => sign(pair.privateKey, data) }
}

const request: ScreenRequest = { url: 'ws://test/ecmaos', id: 'test:30022', user: 'root' }

const memoryStorage = () => {
  const storage = new Map<string, string>()
  return { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value) } } as unknown as Storage
}

describe('connectScreen', () => {
  it('stops at a machine it has not seen and says what its key is; it logs in once the key is remembered', async () => {
    const me = await identity()
    const host = machine({ authorized: [me.publicKey] })
    const store = memoryStorage()
    const options = { request, identity: me, storage: store, open: host.open, timeout: 1000 }
    const printed = await fingerprint((await host.hostKey()).publicKey)

    const unknown = await connectScreen(options).catch(error => error)
    expect(unknown).toBeInstanceOf(UnknownHost)
    expect(unknown).toMatchObject({ id: 'test:30022', fingerprint: printed })
    expect(knownHosts(store)).toEqual({})

    rememberHost(store, unknown.id, unknown.fingerprint)
    expect(knownHosts(store)).toEqual({ 'test:30022': printed })
    ;(await connectScreen(options)).close()
  })

  it('is refused with an auth error when the key is not enrolled, and enrolled with the right code', async () => {
    const me = await identity()
    const host = machine({ code: '123-456' })
    const store = memoryStorage()
    rememberHost(store, request.id, await fingerprint((await host.hostKey()).publicKey))
    const options = { request, identity: me, storage: store, open: host.open, timeout: 1000 }
    await expect(connectScreen(options)).rejects.toMatchObject({ code: 'auth' })
    await expect(connectScreen({ ...options, pairingCode: '000-000' })).rejects.toMatchObject({ code: 'auth' })
    const connection = await connectScreen({ ...options, pairingCode: '123-456' })
    connection.close()
    expect(host.authorized.map(key => publicKeyOf(key)?.x)).toEqual([me.publicKey.x])
  })

  it('does not log in when a remembered key has changed', async () => {
    const me = await identity()
    const host = machine({ authorized: [me.publicKey] })
    const store = memoryStorage()
    rememberHost(store, request.id, await fingerprint((await host.hostKey()).publicKey))
    const impostor = machine({ authorized: [me.publicKey], hostKey: await generateKeyPair() })
    await expect(connectScreen({ request, identity: me, storage: store, open: impostor.open, timeout: 1000 })).rejects.toThrow(/has changed/)
  })
})
