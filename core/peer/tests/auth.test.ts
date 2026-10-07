import { describe, expect, it } from 'vitest'
import { AuthChannel, clientAuth, Connection, fingerprint, generateKeyPair, memoryPair, PeerError, publicKeyOf, serverAuth, sign, transcript, verify } from '../src/index.ts'
import type { KeyPair, PublicKey, ServerAuthOptions, Value } from '../src/index.ts'

async function setup(options: { authorized?: Record<string, PublicKey[]>, pair?: ServerAuthOptions['pair'], hostKey?: KeyPair } = {}) {
  const hostKey = options.hostKey ?? await generateKeyPair()
  const [a, b] = memoryPair()
  const client = new Connection(a, { role: 'client' })
  const server = new Connection(b, { role: 'server' })
  const authorized = options.authorized ?? {}
  let result: Promise<string> | undefined
  server.accept(AuthChannel, channel => {
    result = serverAuth(channel, { hostKey, authorizedKeys: async user => authorized[user], pair: options.pair, timeout: 500 })
    result.catch(() => {})
  })
  return { client, server, hostKey, result: () => result! }
}

const login = async (client: Connection, user: string, pair: KeyPair, extra: { trust?: boolean, code?: string } = {}) => {
  const channel = await client.open(AuthChannel)
  return clientAuth(channel, {
    user, sign: async data => ({ key: pair.publicKey, signature: await sign(pair.privateKey, data) }),
    trust: async () => extra.trust ?? true, pairingCode: extra.code, timeout: 500
  })
}

describe('keys', () => {
  it('fingerprints are stable and SHA256: shaped; signatures verify only for the right key and data', async () => {
    const one = await generateKeyPair()
    const two = await generateKeyPair()
    expect(await fingerprint(one.publicKey)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
    expect(await fingerprint(one.publicKey)).toBe(await fingerprint({ ...one.publicKey }))
    const data = new TextEncoder().encode('data')
    const signature = await sign(one.privateKey, data)
    expect(await verify(one.publicKey, signature, data)).toBe(true)
    expect(await verify(two.publicKey, signature, data)).toBe(false)
    expect(await verify(one.publicKey, signature, new TextEncoder().encode('other'))).toBe(false)
    expect(await verify(one.publicKey, new Uint8Array(96), data)).toBe(false)
  })

  it('publicKeyOf strips extras and rejects other keys', async () => {
    const pair = await generateKeyPair()
    expect(publicKeyOf({ ...pair.privateKey })).toEqual(pair.publicKey) // a private JWK reduces to its public part
    expect(publicKeyOf({ ...pair.publicKey, d: 'secret' })).toEqual(pair.publicKey)
    expect(publicKeyOf({ ...pair.publicKey, crv: 'P-256' })).toBeNull()
    expect(publicKeyOf({ ...pair.publicKey, x: 'short' })).toBeNull()
    expect(publicKeyOf(null)).toBeNull()
    expect(publicKeyOf('x')).toBeNull()
  })
})

describe('login by key', () => {
  it('lets an authorized key in and gives the client the host fingerprint', async () => {
    const user = await generateKeyPair()
    const { client, hostKey, result } = await setup({ authorized: { alice: [user.publicKey] } })
    const outcome = await login(client, 'alice', user)
    expect(outcome.fingerprint).toBe(await fingerprint(hostKey.publicKey))
    expect(await result()).toBe('alice')
  })

  it('refuses an unauthorized key, an unknown user and a key for another user with the same message', async () => {
    const alice = await generateKeyPair()
    const mallory = await generateKeyPair()
    const failures: string[] = []
    for (const [name, key] of [['alice', mallory], ['nobody', alice], ['bob', alice]] as const) {
      const { client } = await setup({ authorized: { alice: [alice.publicKey], bob: [mallory.publicKey] } })
      const error = await login(client, name, key).catch(error => error)
      expect(error).toBeInstanceOf(PeerError)
      expect(error.code).toBe('auth')
      failures.push(error.message)
    }
    expect(new Set(failures).size).toBe(1)
  })

  it('refuses a signature made by a different key than the one offered', async () => {
    const alice = await generateKeyPair()
    const mallory = await generateKeyPair()
    const { client } = await setup({ authorized: { alice: [alice.publicKey] } })
    const channel = await client.open(AuthChannel)
    await expect(clientAuth(channel, {
      user: 'alice', sign: async data => ({ key: alice.publicKey, signature: await sign(mallory.privateKey, data) }), trust: async () => true, timeout: 500
    })).rejects.toMatchObject({ code: 'auth' })
  })

  it('a signature for one host or one exchange cannot be replayed on another', async () => {
    const alice = await generateKeyPair()
    // an attacker host relays a real login to the real host: the relayed signature binds the attacker's key and nonces
    const real = await setup({ authorized: { alice: [alice.publicKey] } })
    const fake = await setup({ authorized: { alice: [alice.publicKey] } })
    let captured: { sig: Uint8Array } | undefined
    const channel = await fake.client.open(AuthChannel)
    await clientAuth(channel, {
      user: 'alice', trust: async () => true, timeout: 500,
      sign: async data => { const sig = await sign(alice.privateKey, data); captured = { sig }; return { key: alice.publicKey, signature: sig } }
    })
    const replay = await real.client.open(AuthChannel)
    replay.send({ op: 'begin', user: 'alice', nonce: new Uint8Array(32).fill(1) })
    const messages: unknown[] = []
    replay.onMessage = value => messages.push(value)
    await new Promise(resolve => setTimeout(resolve, 20))
    replay.send({ op: 'auth', key: { ...alice.publicKey }, sig: captured!.sig })
    expect(await replay.done).toMatchObject({ code: 'auth' })
    await expect(real.result()).rejects.toMatchObject({ code: 'auth' })
  })

  it('stops if the host cannot prove its key (a signature that does not match the key it sent)', async () => {
    const alice = await generateKeyPair()
    const real = await generateKeyPair()
    const impostor = await generateKeyPair()
    const [a, b] = memoryPair()
    const client = new Connection(a, { role: 'client' })
    const server = new Connection(b, { role: 'server' })
    server.accept(AuthChannel, channel => {
      channel.onMessage = async value => {
        const nonce = (value as { nonce: Uint8Array }).nonce
        // claims the real host's key but signs with its own
        channel.send({ op: 'challenge', nonce: new Uint8Array(32), hostKey: { ...real.publicKey }, sig: await sign(impostor.privateKey, transcript('host', nonce, new Uint8Array(32))) })
      }
    })
    const channel = await client.open(AuthChannel)
    await expect(clientAuth(channel, {
      user: 'alice', sign: async data => ({ key: alice.publicKey, signature: await sign(alice.privateKey, data) }), trust: async () => true, timeout: 500
    })).rejects.toMatchObject({ code: 'auth', message: expect.stringContaining('prove') })
  })

  it('the client stops, and signs nothing, when the host key is not trusted', async () => {
    const alice = await generateKeyPair()
    const { client, result } = await setup({ authorized: { alice: [alice.publicKey] } })
    let signed = false
    const channel = await client.open(AuthChannel)
    await expect(clientAuth(channel, {
      user: 'alice', trust: async () => false, timeout: 500,
      sign: async data => { signed = true; return { key: alice.publicKey, signature: await sign(alice.privateKey, data) } }
    })).rejects.toMatchObject({ code: 'auth' })
    expect(signed).toBe(false)
    await expect(result()).rejects.toBeInstanceOf(PeerError)
  })

  it('malformed first messages are protocol errors, not crashes', async () => {
    for (const bad of [{ op: 'begin' }, { op: 'begin', user: 'x', nonce: new Uint8Array(3) }, { op: 'nope' }, { op: 'begin', user: '', nonce: new Uint8Array(32) }] as Value[]) {
      const { client, result } = await setup()
      const channel = await client.open(AuthChannel)
      channel.send(bad)
      await expect(result()).rejects.toBeInstanceOf(PeerError)
      await channel.done
    }
  })

  it('times out a client that never answers', async () => {
    const { client, result } = await setup()
    const channel = await client.open(AuthChannel)
    channel.send({ op: 'begin', user: 'alice', nonce: new Uint8Array(32) })
    await expect(result()).rejects.toMatchObject({ code: 'timeout' })
    expect(await channel.done).toBeDefined()
  })
})

describe('pairing', () => {
  it('enrols the key when the code is good, and the same key then logs in', async () => {
    const alice = await generateKeyPair()
    const stored: Record<string, PublicKey[]> = {}
    const { client, result } = await setup({
      authorized: stored,
      pair: async (user, code, key) => { if (code !== '123-456') return false; (stored[user] ??= []).push(key); return true }
    })
    await login(client, 'alice', alice, { code: '123-456' })
    expect(await result()).toBe('alice')
    expect(stored['alice']).toEqual([alice.publicKey])
    const again = await setup({ authorized: stored })
    await login(again.client, 'alice', alice)
  })

  it('a wrong code enrols nothing', async () => {
    const alice = await generateKeyPair()
    const stored: Record<string, PublicKey[]> = {}
    const { client } = await setup({ authorized: stored, pair: async (user, code, key) => { if (code !== 'right') return false; (stored[user] ??= []).push(key); return true } })
    await expect(login(client, 'alice', alice, { code: 'wrong' })).rejects.toMatchObject({ code: 'auth' })
    expect(stored).toEqual({})
  })

  it('pairing needs a signature from the key being enrolled', async () => {
    const alice = await generateKeyPair()
    const mallory = await generateKeyPair()
    let called = false
    const { client } = await setup({ pair: async () => { called = true; return true } })
    const channel = await client.open(AuthChannel)
    await expect(clientAuth(channel, {
      user: 'alice', pairingCode: 'x', sign: async data => ({ key: alice.publicKey, signature: await sign(mallory.privateKey, data) }), trust: async () => true, timeout: 500
    })).rejects.toMatchObject({ code: 'auth' })
    expect(called).toBe(false)
  })

  it('a server with no pairing refuses a code', async () => {
    const alice = await generateKeyPair()
    const { client } = await setup()
    await expect(login(client, 'alice', alice, { code: 'x' })).rejects.toMatchObject({ code: 'auth' })
  })
})
