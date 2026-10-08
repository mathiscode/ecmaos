import { afterEach, describe, expect, it, vi } from 'vitest'

import { Connection, memoryPair, RemoteDevice, serveDevice } from '@ecmaos/peer'
import { openGamepadSession } from '@ecmaos-devices/gamepad'
import { openHidSession } from '@ecmaos-devices/hid'
import { openMidiSession, splitMessages } from '@ecmaos-devices/midi'
import { openLocalDevice } from '../../../src/tree/lib/remote-device.js'

const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))
afterEach(() => { vi.unstubAllGlobals() })

class FakeMidiPort extends EventTarget {
  state = 'connected'
  sent: number[][] = []
  opened = false
  constructor(readonly id: string, readonly name: string) { super() }
  async open() { this.opened = true; return this }
  async close() { this.opened = false; return this }
  send(data: number[] | Uint8Array) { this.sent.push([...data]) }
  play(...bytes: number[]) { const event = new Event('midimessage') as Event & { data: Uint8Array }; event.data = new Uint8Array(bytes); this.dispatchEvent(event) }
}

function midiAccess(input = new FakeMidiPort('in0', 'Keys'), output = new FakeMidiPort('out0', 'Synth')) {
  const access = Object.assign(new EventTarget(), {
    inputs: new Map([[input.id, input]]), outputs: new Map([[output.id, output]]), sysexEnabled: false
  })
  return { access, input, output }
}

describe('MIDI as a device session', () => {
  it('cuts a byte stream into whole messages', () => {
    const { messages, rest } = splitMessages(new Uint8Array([0x90, 60, 100, 0xc0, 5, 0xf0, 1, 2, 0xf7, 0xb0, 7]))
    expect(messages.map(m => [...m])).toEqual([[0x90, 60, 100], [0xc0, 5], [0xf0, 1, 2, 0xf7]])
    expect([...rest]).toEqual([0xb0, 7])
    expect(() => splitMessages(new Uint8Array([5]))).toThrow(/status/)
  })

  it('reads what the input plays and sends whole messages to the output', async () => {
    const { access, input, output } = midiAccess()
    const session = await openMidiSession(access as never, { input: 0, output: 0 })
    expect(session.info).toMatchObject({ kind: 'midi', read: true, write: true, input: { name: 'Keys' }, output: { name: 'Synth' } })
    input.play(0x90, 60, 100)
    expect([...(await session.read!())!]).toEqual([0x90, 60, 100])
    // a message split over two writes goes out once it is whole
    await session.write!(new Uint8Array([0x90, 61]))
    expect(output.sent).toEqual([])
    await session.write!(new Uint8Array([90]))
    expect(output.sent).toEqual([[0x90, 61, 90]])
    expect(await session.control('ports', [])).toMatchObject({ inputs: [{ id: 'in0' }], outputs: [{ id: 'out0' }] })
    await session.close()
    expect(input.opened).toBe(false)
    await expect(openMidiSession(access as never, { input: 3 })).rejects.toMatchObject({ code: 'ENODEV' })
  })

  it('ends when the input is unplugged', async () => {
    const { access, input } = midiAccess()
    const session = await openMidiSession(access as never, { input: 0 })
    expect(session.write).toBeUndefined()
    const events: string[] = []
    session.emit = name => { events.push(name) }
    const pending = session.read!()
    input.state = 'disconnected'
    const event = new Event('statechange') as Event & { port: unknown }
    event.port = input
    access.dispatchEvent(event)
    expect(events).toEqual(['state', 'disconnect'])
    await session.close()
    expect(await pending).toBeUndefined()
  })
})

function pad(index = 0) {
  const state = { connected: true, id: 'Test Pad', mapping: 'standard', index, buttons: [{ pressed: false }, { pressed: true }], axes: [0, -1], vibrationActuator: { effects: [] as unknown[], async playEffect(type: string, params: unknown) { this.effects.push([type, params]) } } }
  return state
}

describe('a gamepad as a device session', () => {
  it('starts with its state and then reports changes as joystick events', async () => {
    const state = pad()
    const session = await openGamepadSession(0, { getGamepads: () => [state] as never, interval: 2 })
    expect(session.info).toMatchObject({ kind: 'gamepad', read: true, write: false, buttons: 2, axes: 2 })
    const event = async () => { const chunk = (await session.read())!; const view = new DataView(chunk.buffer, chunk.byteOffset); return { value: view.getInt16(4, true), type: chunk[6], number: chunk[7], length: chunk.length } }
    expect(await event()).toEqual({ value: 0, type: 0x81, number: 0, length: 8 })
    expect(await event()).toEqual({ value: 1, type: 0x81, number: 1, length: 8 })
    expect(await event()).toEqual({ value: 0, type: 0x82, number: 0, length: 8 })
    expect(await event()).toEqual({ value: -32767, type: 0x82, number: 1, length: 8 })
    state.buttons[0]!.pressed = true
    state.axes[0] = 0.5
    expect(await event()).toEqual({ value: 1, type: 0x01, number: 0, length: 8 })
    expect(await event()).toEqual({ value: 16384, type: 0x02, number: 0, length: 8 })
    await session.control('rumble', [{ duration: 50, strong: 0.5 }])
    expect(state.vibrationActuator.effects).toEqual([['dual-rumble', { duration: 50, strongMagnitude: 0.5, weakMagnitude: 1 }]])
    state.connected = false
    const events: string[] = []
    session.emit = name => { events.push(name) }
    expect(await session.read()).toBeUndefined()
    expect(events).toEqual(['disconnect'])
    await expect(openGamepadSession(4, { getGamepads: () => [] })).rejects.toMatchObject({ code: 'ENODEV' })
  })
})

class FakeHid extends EventTarget {
  opened = false
  vendorId = 0x046d
  productId = 0xc52b
  productName = 'Receiver'
  collections = [{ usagePage: 1, usage: 2 }]
  sent: Array<[number, number[]]> = []
  features = new Map<number, number[]>()
  async open() { this.opened = true }
  async close() { this.opened = false }
  async sendReport(id: number, data: Uint8Array) { this.sent.push([id, [...data]]) }
  async receiveFeatureReport(id: number) { return new DataView(new Uint8Array(this.features.get(id) ?? []).buffer) }
  async sendFeatureReport(id: number, data: Uint8Array) { this.features.set(id, [...data]) }
  report(id: number, ...bytes: number[]) { const event = new Event('inputreport') as Event & { reportId: number, data: DataView }; event.reportId = id; event.data = new DataView(new Uint8Array(bytes).buffer); this.dispatchEvent(event) }
}

describe('a HID device as a device session', () => {
  it('reads reports with their id, writes output reports and gets and sets feature reports', async () => {
    const hid = new FakeHid()
    const session = await openHidSession(hid as never)
    expect(session.info).toMatchObject({ kind: 'hid', vendorId: 0x046d, productId: 0xc52b })
    hid.report(3, 10, 20)
    expect([...(await session.read())!]).toEqual([3, 10, 20])
    await session.write(new Uint8Array([1, 7, 8]))
    expect(hid.sent).toEqual([[1, [7, 8]]])
    await session.control('set-feature', [5, new Uint8Array([4, 4])])
    expect([...(await session.control('get-feature', [5]) as Uint8Array)]).toEqual([4, 4])
    expect(await session.control('collections', [])).toEqual([{ usagePage: 1, usage: 2 }])
    await expect(session.control('get-feature', ['x'])).rejects.toMatchObject({ code: 'EINVAL' })
    await expect(session.control('reboot', [])).rejects.toMatchObject({ code: 'ENOSYS' })
    await session.close()
    expect(hid.opened).toBe(false)
    expect(await session.read()).toBeUndefined()
  })
})

describe('offering a device by its spec', () => {
  it('opens midi, gamepad and hid devices of the browser, and explains what is missing', async () => {
    const { access, output } = midiAccess()
    const hid = new FakeHid()
    vi.stubGlobal('navigator', { requestMIDIAccess: async () => access, getGamepads: () => [pad()], hid: { getDevices: async () => [hid], addEventListener() {}, removeEventListener() {} } })
    const midi = await openLocalDevice('midi:in=0,out=0')
    expect(midi.info).toMatchObject({ kind: 'midi' })
    await midi.close()
    const gamepad = await openLocalDevice('gamepad:0')
    expect(gamepad.info).toMatchObject({ kind: 'gamepad' })
    await gamepad.close()
    expect((await openLocalDevice('hid:0')).info).toMatchObject({ kind: 'hid' })
    await expect(openLocalDevice('hid:2')).rejects.toThrow(/no HID device 2/)
    await expect(openLocalDevice('midi:in=x')).rejects.toThrow(/in is a number/)
    await expect(openLocalDevice('webcam:0')).rejects.toThrow(/unknown device/)
    expect(output.opened).toBe(false)
    vi.stubGlobal('navigator', {})
    await expect(openLocalDevice('gamepad:0')).rejects.toThrow(/no Gamepad API/)
    await expect(openLocalDevice('midi:out=0')).rejects.toThrow(/no Web MIDI/)
  })

  it('serves a MIDI session over a device channel', async () => {
    const [a, b] = memoryPair()
    const client = new Connection(a, { role: 'client' })
    const server = new Connection(b, { role: 'server' })
    const { access, input, output } = midiAccess()
    const session = await openMidiSession(access as never, { input: 0, output: 0 })
    server.accept('device', channel => serveDevice(channel, session as never))
    const remote = new RemoteDevice(await client.open('device'))
    expect(await remote.info()).toMatchObject({ kind: 'midi' })
    input.play(0x80, 1, 2)
    await tick()
    const into = new Uint8Array(8)
    expect(remote.take(into)).toBe(3)
    expect(remote.write(new Uint8Array([0xc0, 9]))).toBe(2)
    await tick()
    expect(output.sent).toEqual([[0xc0, 9]])
    expect(await remote.control('ports')).toMatchObject({ outputs: [{ name: 'Synth' }] })
    remote.close()
  })
})
