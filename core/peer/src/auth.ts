import type { Channel } from './channel.ts'
import type { Value } from './codec.ts'
import { PeerError } from './errors.ts'
import { fingerprint, randomNonce, requireKey, sameKey, sign, transcript, verify } from './keys.ts'
import type { KeyPair, PublicKey } from './keys.ts'

/** The channel kind the authentication runs on; the only one a server accepts before a user is known */
export const AuthChannel = 'auth'

/** How long either side waits for the other's next message */
const StepTimeout = 30_000

type Message = { [key: string]: Value }

function messages(channel: Channel, timeout = StepTimeout) {
  const queue: Message[] = []
  let wake: (() => void) | undefined
  channel.onMessage = value => {
    if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array)) { queue.push(value); wake?.() }
  }
  void channel.done.then(() => wake?.())
  return async (op: string): Promise<Message> => {
    const deadline = Date.now() + timeout
    while (!queue.length) {
      if (channel.closed) throw channel.error ?? new PeerError('closed', 'the channel closed during authentication')
      const left = deadline - Date.now()
      if (left <= 0) throw new PeerError('timeout', 'authentication timed out')
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, left)
        wake = () => { clearTimeout(timer); resolve() }
      })
    }
    const message = queue.shift()!
    if (message['op'] !== op) throw new PeerError('protocol', `expected ${op}, got ${String(message['op'])}`)
    return message
  }
}

const bytesOf = (value: Value | undefined, length: number) => {
  if (!(value instanceof Uint8Array) || value.length !== length) throw new PeerError('protocol', 'bad nonce')
  return value
}

// -- server ---------------------------------------------------------------------------------------

export interface ServerAuthOptions {
  hostKey: KeyPair
  /** The keys `user` may log in with, or `undefined` for no such user or no login */
  authorizedKeys(user: string): Promise<PublicKey[] | undefined>
  /** Pairing: checks `code` for `user` and, if it is good, records `key` as authorized for them. False when the code is not valid. */
  pair?(user: string, code: string, key: PublicKey): Promise<boolean>
  /** How long to wait for each client message, ms. Default 30000. */
  timeout?: number
  /** How long to hold a refusal back before telling the client, ms: slows guessing. Default 0. */
  failureDelay?: number
}

/**
 * The server half of the handshake on an `auth` channel. Resolves with the user name once the client proved it holds an
 * authorized key (or a pairing code and a key). On failure the channel is closed with a generic `auth` error: the
 * client is never told whether the user exists or which part was wrong.
 */
export async function serverAuth(channel: Channel, options: ServerAuthOptions): Promise<string> {
  const next = messages(channel, options.timeout)
  try {
    const begin = await next('begin')
    const user = begin['user']
    if (typeof user !== 'string' || user.length === 0 || user.length > 256) throw new PeerError('protocol', 'bad user')
    const clientNonce = bytesOf(begin['nonce'], 32)
    const serverNonce = randomNonce()
    const hostFingerprint = await fingerprint(options.hostKey.publicKey)

    // Proves this is the host whose key the client has pinned, for these two nonces
    const hostSignature = await sign(options.hostKey.privateKey, transcript('host', clientNonce, serverNonce))
    channel.send({ op: 'challenge', nonce: serverNonce, hostKey: { ...options.hostKey.publicKey }, sig: hostSignature })

    const reply = await next(typeof begin['pair'] === 'string' ? 'pair' : 'auth')
    const key = requireKey(reply['key'])
    const signature = reply['sig']
    if (!(signature instanceof Uint8Array)) throw new PeerError('protocol', 'bad signature')

    if (reply['op'] === 'pair') {
      const code = reply['code']
      if (typeof code !== 'string' || !options.pair) throw new PeerError('auth', 'authentication failed')
      const proof = transcript('pair', clientNonce, serverNonce, `${hostFingerprint}\0${user}`)
      if (!await verify(key, signature, proof)) throw new PeerError('auth', 'authentication failed')
      if (!await options.pair(user, code, key)) throw new PeerError('auth', 'authentication failed')
    } else {
      const keys = await options.authorizedKeys(user)
      const proof = transcript('auth', clientNonce, serverNonce, `${hostFingerprint}\0${user}`)
      // Verify even when there is no such user, so the time taken does not say which it was
      const allowed = keys?.some(candidate => sameKey(candidate, key)) ?? false
      const valid = await verify(key, signature, proof)
      if (!allowed || !valid) throw new PeerError('auth', 'authentication failed')
    }

    channel.send({ op: 'ok', user })
    return user
  } catch (error) {
    const failure = error instanceof PeerError ? error : new PeerError('internal', 'authentication failed')
    if (options.failureDelay && failure.code === 'auth') await new Promise(resolve => setTimeout(resolve, options.failureDelay))
    // Whatever went wrong inside, the other side only learns that it did
    channel.close(failure.code === 'protocol' || failure.code === 'timeout' ? failure : new PeerError('auth', 'authentication failed'))
    throw failure
  }
}

// -- client ---------------------------------------------------------------------------------------

export interface ClientAuthOptions {
  user: string
  /** Signs the login transcript, and says which public key the signature is by. The private half never has to leave the caller. */
  sign(data: Uint8Array): Promise<{ key: PublicKey, signature: Uint8Array }>
  /** Decides whether to trust the host's key: look it up in known_hosts, or ask. Return false to stop. */
  trust(hostKey: PublicKey, fingerprint: string): Promise<boolean>
  /** A one-time pairing code from the host's console: enrols `key` for `user` instead of logging in with it */
  pairingCode?: string
  timeout?: number
}

/**
 * The client half. Resolves with the host key's fingerprint once logged in. Rejects with `auth` if the host or the key was
 * refused, whichever side refused.
 */
export async function clientAuth(channel: Channel, options: ClientAuthOptions): Promise<{ hostKey: PublicKey, fingerprint: string }> {
  const next = messages(channel, options.timeout)
  try {
    const clientNonce = randomNonce()
    channel.send({ op: 'begin', user: options.user, nonce: clientNonce, ...(options.pairingCode !== undefined ? { pair: 'yes' } : {}) })

    const challenge = await next('challenge')
    const serverNonce = bytesOf(challenge['nonce'], 32)
    const hostKey = requireKey(challenge['hostKey'])
    const hostSignature = challenge['sig']
    if (!(hostSignature instanceof Uint8Array) || !await verify(hostKey, hostSignature, transcript('host', clientNonce, serverNonce))) {
      throw new PeerError('auth', 'the host could not prove its identity')
    }
    const hostFingerprint = await fingerprint(hostKey)
    if (!await options.trust(hostKey, hostFingerprint)) throw new PeerError('auth', 'the host key was not trusted')

    const label = options.pairingCode !== undefined ? 'pair' : 'auth'
    const { key, signature } = await options.sign(transcript(label, clientNonce, serverNonce, `${hostFingerprint}\0${options.user}`))
    channel.send({ op: label, key: { ...key }, sig: signature, ...(options.pairingCode !== undefined ? { code: options.pairingCode } : {}) })

    await next('ok')
    return { hostKey, fingerprint: hostFingerprint }
  } catch (error) {
    channel.close()
    // The server's refusal arrives as the channel closing with its reason. A failure on this side (the key could not be
    // used, the host was not trusted) is reported as it is: it is the caller's own, and the user needs to read it.
    if (error instanceof PeerError && error.code === 'closed') throw channel.error ?? error
    throw error
  }
}
