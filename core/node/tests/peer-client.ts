import WebSocket from 'ws'

import { AuthChannel, clientAuth, Connection, generateKeyPair, sign, webSocketTransport } from '@ecmaos/peer'
import type { Channel, KeyPair, WebSocketLike } from '@ecmaos/peer'

// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '')

/** Opens a connection to a daemon the way a peer would. `headers` and `origin` let a test misbehave. */
export async function dial(port: number, options: { origin?: string, headers?: Record<string, string> } = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ecmaos`, { origin: options.origin, headers: options.headers })
  // Wrapped before it opens, so nothing the host sends first is missed
  const transport = webSocketTransport(socket as unknown as WebSocketLike)
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); socket.once('unexpected-response', (_request, response) => reject(new Error(`HTTP ${response.statusCode}`))) })
  return new Connection(transport, { role: 'client' })
}

export { generateKeyPair }

/** Logs in; with `code`, pairs the key first. Resolves with the host fingerprint the client saw. */
export async function login(connection: Connection, user: string, pair: KeyPair, options: { code?: string, trust?: (fingerprint: string) => boolean } = {}) {
  const channel = await connection.open(AuthChannel, { timeout: 5000 })
  return await clientAuth(channel, {
    user, sign: async data => ({ key: pair.publicKey, signature: await sign(pair.privateKey, data) }),
    trust: async (_key, fingerprint) => options.trust?.(fingerprint) ?? true,
    pairingCode: options.code, timeout: 10_000
  })
}

/** A shell on the daemon: what you send is typed, what comes back is what the terminal printed */
export class Shell {
  private _out = ''
  constructor(readonly channel: Channel) {
    channel.onData = data => { this._out += new TextDecoder().decode(data, { stream: true }) }
  }
  get output() { return stripAnsi(this._out) }
  send(text: string) { return this.channel.write(new TextEncoder().encode(text)) }
  resize(cols: number, rows: number) { this.channel.send({ op: 'resize', cols, rows }) }
  async waitFor(text: string, from = 0, timeout = 15_000) {
    const started = Date.now()
    while (this.output.indexOf(text, from) === -1) {
      if (this.channel.closed) throw new Error(`the channel closed while waiting for "${text}"\n${this.output}`)
      if (Date.now() - started > timeout) throw new Error(`timed out waiting for "${text}"\n${this.output}`)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  /** Types a command, waits for the next prompt and returns what it printed after the echo */
  async run(command: string) {
    const prompts = () => (this.output.match(/^\w+:[^\n]*# /gm) ?? []).length
    const before = prompts()
    const mark = this.output.length
    await this.send(`${command}\r`)
    const started = Date.now()
    while (prompts() <= before) {
      if (this.channel.closed) throw new Error(`the channel closed running "${command}"\n${this.output}`)
      if (Date.now() - started > 20_000) throw new Error(`timed out running "${command}"\n${this.output.slice(mark)}`)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return this.output.slice(mark).split('\n').slice(1, -1).join('\n')
  }
}

export async function openShell(connection: Connection, cols = 100, rows = 30) {
  const channel = await connection.open('tty', { params: { cols, rows }, timeout: 15_000 })
  return new Shell(channel)
}
