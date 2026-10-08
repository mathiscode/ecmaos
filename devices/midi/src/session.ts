/// <reference types="webmidi" />

/**
 * A Web MIDI input and/or output as a device session for `@ecmaos/peer`'s `serveDevice`. Reads are the raw MIDI bytes of
 * the messages the input produced (one message per chunk); writes are raw MIDI bytes, cut into whole messages before they
 * are sent, since the browser refuses half a message.
 */

import { Feed, SessionError } from '@ecmaos-devices/session'
import type { DeviceSession, Plain } from '@ecmaos-devices/session'

export type MidiDeviceSession = DeviceSession
export { SessionError as MidiError }
const MidiError = SessionError

/** Length of the message that starts with `status`, or 0 for a status that cannot start one */
function messageLength(status: number): number {
  if (status >= 0xf8) return 1
  if (status >= 0xf0) return status === 0xf1 || status === 0xf3 ? 2 : status === 0xf2 ? 3 : 1
  if (status >= 0xc0 && status < 0xe0) return 2
  if (status >= 0x80) return 3
  return 0
}

/** Splits a byte stream into whole messages; what is left over (an unfinished message) is returned to be joined with the next bytes */
export function splitMessages(bytes: Uint8Array): { messages: Uint8Array[], rest: Uint8Array } {
  const messages: Uint8Array[] = []
  let at = 0
  while (at < bytes.length) {
    const status = bytes[at]!
    if (status === 0xf0) {
      const end = bytes.indexOf(0xf7, at)
      if (end < 0) break
      messages.push(bytes.slice(at, end + 1))
      at = end + 1
      continue
    }
    const length = messageLength(status)
    if (length === 0) throw new MidiError('EINVAL', 'not a MIDI message (a data byte without a status byte)')
    if (at + length > bytes.length) break
    messages.push(bytes.slice(at, at + length))
    at += length
  }
  return { messages, rest: bytes.slice(at) }
}

export interface MidiSessionOptions {
  /** Index in the browser's list of inputs, in the order `ports` gives them */
  input?: number
  output?: number
  sysex?: boolean
}

const portInfo = (port: MIDIPort) => ({ id: port.id, name: port.name ?? '', manufacturer: port.manufacturer ?? '', state: port.state })

/** Opens the chosen input and/or output (at least one) of `access` and serves them as one device */
export async function openMidiSession(access: MIDIAccess, options: MidiSessionOptions): Promise<MidiDeviceSession> {
  if (options.input === undefined && options.output === undefined) throw new MidiError('EINVAL', 'give an input, an output or both')
  const inputs = [...access.inputs.values()]
  const outputs = [...access.outputs.values()]
  const input = options.input === undefined ? undefined : inputs[options.input]
  const output = options.output === undefined ? undefined : outputs[options.output]
  if (options.input !== undefined && !input) throw new MidiError('ENODEV', `no MIDI input ${options.input}`)
  if (options.output !== undefined && !output) throw new MidiError('ENODEV', `no MIDI output ${options.output}`)
  await input?.open()
  await output?.open()

  // A controller keeps playing whether or not anyone reads, so the oldest messages are dropped past the limit
  const feed = new Feed(4096)
  let carry: Uint8Array = new Uint8Array(0)

  const onMessage = (event: Event) => {
    const data = (event as MIDIMessageEvent).data
    if (data) feed.push(data.slice())
  }
  const finish = () => feed.end()
  const onState = (event: Event) => {
    const port = (event as MIDIConnectionEvent).port
    if (!port || (port !== input && port !== output)) return
    session.emit?.('state', portInfo(port))
    if (port.state === 'disconnected') { session.emit?.('disconnect', null); if (port === input) finish() }
  }
  input?.addEventListener('midimessage', onMessage)
  access.addEventListener('statechange', onState)

  const session: MidiDeviceSession = {
    info: {
      kind: 'midi', read: !!input, write: !!output,
      ...(input ? { input: portInfo(input) } : {}),
      ...(output ? { output: portInfo(output) } : {}),
      sysex: !!access.sysexEnabled
    },
    ...(input ? {
      read: () => feed.next()
    } : {}),
    ...(output ? {
      async write(data: Uint8Array) {
        const joined = new Uint8Array(carry.length + data.length)
        joined.set(carry)
        joined.set(data, carry.length)
        const { messages, rest } = splitMessages(joined)
        carry = rest
        for (const message of messages) output.send(message)
      }
    } : {}),
    async control(op, _args) {
      switch (op) {
        case 'ports': return { inputs: inputs.map(portInfo), outputs: outputs.map(portInfo) }
        case 'clear': { (output as { clear?(): void } | undefined)?.clear?.(); return null }
        default: throw new MidiError('ENOSYS', `no such operation: ${op.slice(0, 32)}`)
      }
    },
    async close() {
            input?.removeEventListener('midimessage', onMessage)
      access.removeEventListener('statechange', onState)
      finish()
      await input?.close().catch(() => {})
      await output?.close().catch(() => {})
    }
  }
  return session
}
